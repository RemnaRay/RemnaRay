/**
 * `proxy-config` (section 21.2): renders `deploy/proxy/<profile>` into the
 * shared `proxy-conf` volume and asks `proxy-reloader` to apply it. With
 * `--watch` it re-renders on `rr:settings.changed`.
 *
 * P-20: a render that changes the live files is staged first and validated by
 * the running proxy (`rr:proxy.validate`, answered on `rr:proxy.validated`);
 * only an accepted one replaces them and is reloaded. The live files are the
 * last configuration known to be good, so a refused render can never keep the
 * proxy — and the console behind it — from starting again.
 */
import { randomUUID } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { createPrismaClient } from '@remnaray/db';
import Redis from 'ioredis';

import {
  PROXY_PROFILES,
  PROXY_SETTING_KEYS,
  TLS_MODES,
  applyRender,
  certbotCertificates,
  certbotDomainsFile,
  certbotSite,
  customFiles,
  renderProfile,
  sourcesFrom,
  type ProxyProfile,
  type RenderOutcome,
  type TlsMode,
  type Verdict,
} from './proxy-render';

const SETTINGS_CHANNEL = 'rr:settings.changed';
const RELOAD_CHANNEL = 'rr:proxy.reload';
const VALIDATE_CHANNEL = 'rr:proxy.validate';
const VALIDATED_CHANNEL = 'rr:proxy.validated';
/** `nginx -t` takes well under a second; this covers a busy host. */
const VALIDATION_TIMEOUT_MS = 10_000;
/** How soon a render nobody could validate is tried again. */
const RETRY_MS = 15_000;

function flag(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}

async function main(): Promise<void> {
  const profile = flag('profile', process.env.RR_PROXY_PROFILE ?? 'nginx');
  const tlsMode = flag('tls', process.env.RR_TLS_MODE ?? 'acme');
  const templates = flag('templates', '/templates');
  const output = flag('out', '/proxy-conf');
  const watch = process.argv.includes('--watch');
  if (watch) rmSync('/tmp/proxy-config-ready', { force: true });

  if (!PROXY_PROFILES.includes(profile as ProxyProfile)) {
    process.stderr.write(`Unsupported proxy profile: ${profile}\n`);
    process.exitCode = 1;
    return;
  }
  if (!TLS_MODES.includes(tlsMode as TlsMode)) {
    process.stderr.write(`Unsupported TLS mode: ${tlsMode}\n`);
    process.exitCode = 1;
    return;
  }

  const directory = resolve(templates, profile);
  const db = createPrismaClient();
  const valkeyUrl = process.env.VALKEY_URL ?? 'redis://valkey:6379/0';
  const publisher = new Redis(valkeyUrl, { maxRetriesPerRequest: null });
  const subscriber = new Redis(valkeyUrl, { maxRetriesPerRequest: null });

  // The reloader's answers, by request.
  const waiting = new Map<string, (verdict: Verdict) => void>();
  await subscriber.subscribe(VALIDATED_CHANNEL);
  subscriber.on('message', (channel, message) => {
    if (channel !== VALIDATED_CHANNEL) return;
    try {
      const { id, verdict } = JSON.parse(message) as { id?: string; verdict?: Verdict };
      if (id && verdict) waiting.get(id)?.(verdict);
    } catch {
      // Not an answer this process can read.
    }
  });

  const validate = async (): Promise<Verdict> => {
    const id = randomUUID();
    const answered = new Promise<Verdict>((done) => {
      const timer = setTimeout(() => {
        done('unavailable');
      }, VALIDATION_TIMEOUT_MS);
      waiting.set(id, (verdict) => {
        clearTimeout(timer);
        done(verdict);
      });
    });
    try {
      // Nobody listening: no reloader to ask.
      if ((await publisher.publish(VALIDATE_CHANNEL, JSON.stringify({ id }))) === 0)
        return 'unavailable';
      return await answered;
    } finally {
      waiting.delete(id);
    }
  };

  const render = async (): Promise<RenderOutcome> => {
    const rows = await db.setting.findMany({ where: { key: { in: PROXY_SETTING_KEYS } } });
    const wanted = sourcesFrom(rows);
    const site =
      tlsMode === 'certbot'
        ? certbotSite(wanted.domain, certbotCertificates(), process.env.RR_DOMAIN)
        : { domain: wanted.domain, certificatePresent: true };
    if (site.domain !== wanted.domain)
      process.stdout.write(
        `no certificate for ${wanted.domain} yet; still serving ${site.domain} — run ./scripts/rr tls:issue\n`,
      );
    const sources = { ...wanted, domain: site.domain };
    const files = [
      ...renderProfile(directory, sources, {
        profile: profile as ProxyProfile,
        tlsMode: tlsMode as TlsMode,
        certificatePresent: site.certificatePresent,
      }),
      ...customFiles(directory, profile as ProxyProfile),
      ...(tlsMode === 'certbot' ? [certbotDomainsFile(wanted)] : []),
    ];
    const outcome = await applyRender(output, files, profile as ProxyProfile, validate);
    const note: Record<RenderOutcome, string> = {
      unchanged: 'unchanged',
      written: 'rendered',
      promoted: 'rendered and validated',
      refused: 'refused by the proxy; the running configuration stays',
      pending: 'not validated yet (no running proxy); the current configuration stays',
    };
    process.stdout.write(`${profile}/${tlsMode} for ${sources.domain}: ${note[outcome]}\n`);
    if (outcome === 'promoted')
      await publisher.publish(RELOAD_CHANNEL, JSON.stringify({ at: Date.now() }));
    return outcome;
  };

  if (!watch) {
    const outcome = await render();
    // `rr proxy:render` then asks for a reload of what is live.
    if (outcome === 'refused' || outcome === 'pending') process.exitCode = 1;
    subscriber.disconnect();
    await publisher.quit();
    await db.$disconnect();
    return;
  }

  // One render at a time; a change during one makes one more. A render
  // nobody could validate is tried again until the proxy is there.
  let running = false;
  let requested = false;
  let retry: NodeJS.Timeout | undefined;
  const request = async (): Promise<void> => {
    requested = true;
    if (running) return;
    running = true;
    try {
      while (requested) {
        requested = false;
        clearTimeout(retry);
        retry = undefined;
        const outcome = await render().catch((error: unknown) => {
          process.stderr.write(`Proxy render failed: ${String(error)}\n`);
          return 'pending' as const;
        });
        // Cleared above when another render follows at once.
        if (outcome === 'pending') retry = setTimeout(() => void request(), RETRY_MS);
      }
    } finally {
      running = false;
    }
  };

  await request();

  const changes = new Redis(valkeyUrl, { maxRetriesPerRequest: null });
  await changes.subscribe(SETTINGS_CHANNEL);
  changes.on('message', (channel) => {
    if (channel === SETTINGS_CHANNEL) void request();
  });
  // The live files are there and good: the proxy may start on them.
  writeFileSync('/tmp/proxy-config-ready', 'ready\n');
  process.stdout.write(`watching ${SETTINGS_CHANNEL}\n`);
}

void main();
