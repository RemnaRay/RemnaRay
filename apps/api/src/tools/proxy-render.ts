import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';

import { isContactEmail, isHostName, isIpOrCidr } from '../common/network-values';

export const TLS_MODES = ['acme', 'certbot', 'custom', 'none'] as const;
export type TlsMode = (typeof TLS_MODES)[number];
export const PROXY_PROFILES = ['nginx', 'caddy'] as const;
export type ProxyProfile = (typeof PROXY_PROFILES)[number];

export type ProxySources = {
  domain: string;
  extraDomains: string[];
  acmeEmail: string;
  adminAllowlist: string[];
  dockerCidr: string;
  apiDocs: boolean;
  /**
   * Section 9.5: `/api/internal/*` is for the bot and the worker, which reach
   * `api:3000` on the compose network; the proxies answer it with 404. Only
   * the section 22.7 smoke stand (`RR_ECHO_HEADERS=true`) routes it, for its
   * header echo and the browser suite's sign-in scaffolding.
   */
  internalApi: boolean;
  /**
   * Section 21.4: the stock `caddy:2-alpine` has no rate-limit module, and the
   * renderer then drops the `rate_limit` blocks rather than emit a
   * configuration Caddy cannot load. The throttler keeps the limits.
   */
  caddyRateLimit: boolean;
};

export type RenderOptions = {
  profile: ProxyProfile;
  tlsMode: TlsMode;
  /** `certbot` renders an HTTP-only bootstrap until the certificate exists. */
  certificatePresent: boolean;
};

export type RenderedFile = { name: string; content: string };

/**
 * Certbot creates its live/archive directories with root-only permissions.
 * nginx reads the certificate as its root master; this unprivileged renderer
 * only needs the deployment marker shared with the Certbot service.
 */
export function certbotCertificates(stateDirectory = '/run/remnaray/certbot'): string[] {
  const file = resolve(stateDirectory, 'certificates.json');
  if (!existsSync(file)) return [];
  const domains: unknown = JSON.parse(readFileSync(file, 'utf8'));
  return Array.isArray(domains)
    ? domains.filter((domain): domain is string => typeof domain === 'string')
    : [];
}

export function certbotCertificatePresent(
  domain: string,
  stateDirectory = '/run/remnaray/certbot',
): boolean {
  return certbotCertificates(stateDirectory).includes(domain);
}

/**
 * R57: which domain the certbot site serves. A new `domain.main` has no
 * certificate until `rr tls:issue`; rendering the HTTP-only bootstrap for it
 * would take the working site (TLS, webhooks, the console) down, so a domain
 * that has one — the one `.env` names, else the first by name — keeps being
 * served meanwhile (the worker's `tls-check` reports the new one). Only with
 * no certificate at all is the bootstrap rendered.
 */
export function certbotSite(
  domain: string,
  certified: string[],
  preferred?: string,
): { domain: string; certificatePresent: boolean } {
  if (certified.includes(domain)) return { domain, certificatePresent: true };
  const kept = preferred && certified.includes(preferred) ? preferred : [...certified].sort().at(0);
  return kept ? { domain: kept, certificatePresent: true } : { domain, certificatePresent: false };
}

/** Section 21.2 replaces `{{NAME}}` placeholders; nothing else is interpreted. */
export function fill(template: string, values: Record<string, string>): string {
  return template.replaceAll(/\{\{([A-Z0-9_]+)\}\}/gu, (match, name: string) =>
    name in values ? (values[name] ?? '') : match,
  );
}

function indentedBlock(lines: string[], indent: string): string {
  return lines.map((line) => `${indent}${line}`).join('\n');
}

export function placeholders(
  sources: ProxySources,
  options: RenderOptions,
): Record<string, string> {
  const extra = sources.extraDomains.join(' ');
  const allowlist =
    sources.adminAllowlist.length > 0
      ? indentedBlock(
          [...sources.adminAllowlist.map((cidr) => `allow ${cidr};`), 'deny all;'],
          '        ',
        )
      : '';
  return {
    DOMAIN: sources.domain,
    EXTRA_DOMAINS: extra,
    EXTRA_DOMAINS_SUFFIX: extra ? ` ${extra}` : '',
    ACME_EMAIL: sources.acmeEmail,
    TLS_MODE: options.tlsMode,
    DOCKER_CIDR: sources.dockerCidr,
    ADMIN_ALLOWLIST: sources.adminAllowlist.join(' '),
    ADMIN_ALLOWLIST_BLOCK: allowlist,
    API_DOCS_BLOCK: sources.apiDocs ? '' : indentedBlock(['deny all;'], '        '),
    INTERNAL_API_BLOCK: indentedBlock(
      sources.internalApi
        ? [
            'limit_req zone=rr_api burst=30 nodelay;',
            'client_max_body_size 1m;',
            'proxy_pass http://rr_api;',
          ]
        : ['return 404;'],
      '        ',
    ),
    LOAD_MODULE_BLOCK:
      options.tlsMode === 'acme' ? 'load_module modules/ngx_http_acme_module.so;\n' : '',
    ...caddyPlaceholders(sources, options),
  };
}

/**
 * `custom` names the owner's files; every other mode Caddy supports is its own
 * ACME client, which needs no directive.
 */
function caddyTls(tlsMode: TlsMode): string {
  return tlsMode === 'custom' ? '\ttls /certs/fullchain.pem /certs/privkey.pem' : '';
}

/**
 * Section 21.4 zones, carrying the same allowance as the nginx profile.
 *
 * nginx spends a token bucket: `rate` refills it and `burst` is its depth, so
 * what a client may send inside one window is `rate × window + burst`. Caddy's
 * `rate_limit` is a sliding window of `events`, with no separate burst, so the
 * events are that sum — otherwise the same sign-in that the nginx profile
 * serves is refused here, which is exactly what section 21.5 forbids.
 */
type CaddyZone = { zone: string; events: number; window: string; method?: string };

const WEBHOOKS: CaddyZone = { zone: 'rr_webhooks', events: 360, window: '10s' }; // 30r/s + 60
const AUTH: CaddyZone = { zone: 'rr_auth', events: 15, window: '1m' }; // 5r/m + 10
// Owner decision F17: sign-in counts its POSTs only (the nginx `rr_signin`),
// and the console zone is 120r/m + burst 120; see `ratelimits.inc`.
const SIGNIN: CaddyZone = { zone: 'rr_signin', events: 15, window: '1m', method: 'POST' };
const ADMIN: CaddyZone = { zone: 'rr_admin', events: 240, window: '1m' };
const API: CaddyZone = { zone: 'rr_api', events: 130, window: '10s' }; // 10r/s + 30
const GENERAL: CaddyZone = { zone: 'rr_general', events: 250, window: '10s' }; // 20r/s + 50

/** The zones each `{{CADDY_RATE_LIMIT_<NAME>}}` placeholder applies together. */
const CADDY_ZONES: Record<string, CaddyZone[]> = {
  WEBHOOKS: [WEBHOOKS],
  AUTH: [AUTH],
  SIGNIN_API: [SIGNIN, API],
  SIGNIN_ADMIN: [SIGNIN, ADMIN],
  ADMIN: [ADMIN],
  API: [API],
  GENERAL: [GENERAL],
};

function caddyPlaceholders(sources: ProxySources, options: RenderOptions): Record<string, string> {
  const values: Record<string, string> = {
    CADDY_RATE_LIMIT_ORDER: sources.caddyRateLimit ? '\torder rate_limit before basicauth' : '',
    // Not `/etc/caddy/certs`, which section 21.4 names: `/etc/caddy` is the
    // read-only `proxy-conf` volume, and a nested mount point cannot be
    // created inside it. The owner's directory is mounted at `/certs`.
    CADDY_TLS_BLOCK: caddyTls(options.tlsMode),
    // `email` with nothing after it is a parse error, and `custom` mode has
    // no ACME account to name: the owner brought their own certificate.
    CADDY_ACME_EMAIL_BLOCK: sources.acmeEmail ? `\temail ${sources.acmeEmail}` : '',
    CADDY_ADMIN_ALLOWLIST_BLOCK:
      sources.adminAllowlist.length > 0
        ? [
            `\t@rr_denied not client_ip ${sources.adminAllowlist.join(' ')}`,
            '\trespond @rr_denied 403',
          ].join('\n')
        : '',
    // A `handle`, not a bare `respond`: `respond` is ordered after `handle`,
    // so `handle /api/*` answered these first and the denial never applied.
    CADDY_API_DOCS_BLOCK: sources.apiDocs ? '' : '\thandle /api/docs {\n\t\trespond 404\n\t}',
    CADDY_INTERNAL_API_BLOCK: sources.internalApi
      ? ''
      : '\thandle /api/internal/* {\n\t\trespond 404\n\t}',
    // The redirect site needs the same certificate source as the main one:
    // without it Caddy would try to issue for a name the owner may have
    // pointed here only for the redirect, and in `custom` mode there is no
    // issuance to fall back on at all.
    CADDY_EXTRA_DOMAINS_SITE:
      sources.extraDomains.length > 0
        ? [
            '# Additional domains redirect to the main one.',
            `${sources.extraDomains.join(', ')} {`,
            ...(caddyTls(options.tlsMode) ? [caddyTls(options.tlsMode)] : []),
            `\tredir https://${sources.domain}{uri} permanent`,
            '}',
            '',
          ].join('\n')
        : '',
  };
  for (const [name, zones] of Object.entries(CADDY_ZONES))
    values[`CADDY_RATE_LIMIT_${name}`] = sources.caddyRateLimit
      ? [
          '\t\trate_limit {',
          ...zones.flatMap((limit) => [
            `\t\t\tzone ${limit.zone} {`,
            // caddy-ratelimit: a zone may filter the requests it counts.
            ...(limit.method
              ? ['\t\t\t\tmatch {', `\t\t\t\t\tmethod ${limit.method}`, '\t\t\t\t}']
              : []),
            '\t\t\t\tkey {client_ip}',
            `\t\t\t\tevents ${String(limit.events)}`,
            `\t\t\t\twindow ${limit.window}`,
            '\t\t\t}',
          ]),
          '\t\t}',
        ].join('\n')
      : '';
  return values;
}

/**
 * The redirect server for `extra_domains` only exists when there are any: an
 * empty `server_name` would make nginx answer every unmatched host with a
 * redirect to the main domain.
 */
function extraDomainsServer(values: Record<string, string>): string {
  const extra = values['EXTRA_DOMAINS'] ?? '';
  const domain = values['DOMAIN'] ?? '';
  if (!extra) return '';
  return `# ---------- additional domains redirect to the main one ----------
server {
    listen 443 ssl;
    http2 on;
    server_name ${extra};
    include tls-cert.inc;
    return 301 https://${domain}$request_uri;
}
`;
}

function readTemplate(directory: string, name: string): string {
  return readFileSync(resolve(directory, name), 'utf8');
}

/**
 * Renders one profile from `deploy/proxy/<profile>`. Templates end in `.tmpl`
 * and lose that suffix; `*.inc` files without it are copied verbatim, which is
 * what section 21.2 calls the shared includes.
 */
export function renderProfile(
  directory: string,
  sources: ProxySources,
  options: RenderOptions,
): RenderedFile[] {
  if (!existsSync(directory)) throw new Error(`No proxy templates for profile ${options.profile}`);
  if (options.tlsMode === 'none')
    throw new Error('RR_TLS_MODE=none is only valid with the external profile');
  // Section 21.4: Caddy issues and renews its own certificates, so `certbot`
  // has no meaning there and is refused rather than silently ignored.
  if (options.profile === 'caddy' && options.tlsMode === 'certbot')
    throw new Error('RR_TLS_MODE=certbot is not supported by the caddy profile');

  const values = placeholders(sources, options);
  values['EXTRA_DOMAINS_SERVER'] = extraDomainsServer(values);

  const files: RenderedFile[] = [];
  const entries = readdirSync(directory, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.inc')) continue;
    files.push({ name: entry.name, content: readTemplate(directory, entry.name) });
  }

  if (options.profile === 'nginx') {
    const site =
      options.tlsMode === 'certbot' && !options.certificatePresent
        ? 'site-bootstrap.conf.tmpl'
        : 'site.conf.tmpl';
    files.push(
      { name: 'nginx.conf', content: fill(readTemplate(directory, 'nginx.conf.tmpl'), values) },
      { name: 'site.conf', content: fill(readTemplate(directory, site), values) },
      {
        name: 'site-locations.inc',
        content: fill(readTemplate(directory, 'site-locations.inc.tmpl'), values),
      },
      {
        name: `tls-${options.tlsMode}.inc`,
        content: fill(readTemplate(directory, `tls-${options.tlsMode}.inc.tmpl`), values),
      },
      {
        name: 'tls-cert.inc',
        content: fill(readTemplate(directory, `tls-cert-${options.tlsMode}.inc.tmpl`), values),
      },
    );
    return files;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.tmpl')) continue;
    files.push({
      name: entry.name.slice(0, -'.tmpl'.length),
      content: fill(readTemplate(directory, entry.name), values),
    });
  }
  if (files.length === 0) throw new Error(`No proxy templates for profile ${options.profile}`);
  return files;
}

/** The owner's extension point; never rewritten, never deleted. */
export function customFiles(directory: string, profile: ProxyProfile = 'nginx'): RenderedFile[] {
  const custom = resolve(directory, 'custom.d');
  const suffix = profile === 'caddy' ? '.caddy' : '.conf';
  if (!existsSync(custom)) return [];
  return readdirSync(custom, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
    .map((entry) => ({
      name: `custom.d/${entry.name}`,
      content: readFileSync(resolve(custom, entry.name), 'utf8'),
    }));
}

type SettingRow = { key: string; value: unknown };

function settingValue(rows: SettingRow[], key: string): unknown {
  return rows.find((row) => row.key === key)?.value;
}

/**
 * R58: what the settings schema accepts, checked again here, because a row
 * written before it did (or by hand) is pasted into the configuration too.
 * An invalid value falls back to the environment; an invalid list entry is
 * dropped.
 */
function valueOf(value: unknown, valid: (value: unknown) => boolean, fallback: string): string {
  return typeof value === 'string' && valid(value) ? value : fallback;
}

function listOf(value: unknown, valid: (value: unknown) => boolean): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => valid(item)) : [];
}

/**
 * Section 21.2 names the sources: `settings.domain.*`,
 * `settings.admin.ip_allowlist` and `.env`. Only non-secret keys are read, so
 * no decryption key is needed in the renderer.
 */
export function sourcesFrom(rows: SettingRow[]): ProxySources {
  return {
    domain: valueOf(
      settingValue(rows, 'domain.main'),
      isHostName,
      process.env.RR_DOMAIN ?? 'localhost',
    ),
    acmeEmail: valueOf(
      settingValue(rows, 'domain.acme_email'),
      isContactEmail,
      process.env.RR_ACME_EMAIL ?? '',
    ),
    extraDomains: listOf(settingValue(rows, 'domain.extra_domains'), isHostName),
    adminAllowlist: listOf(settingValue(rows, 'admin.ip_allowlist'), isIpOrCidr),
    dockerCidr: process.env.RR_DOCKER_CIDR ?? '172.28.0.0/16',
    apiDocs: process.env.RR_API_DOCS === 'true',
    internalApi: process.env.RR_ECHO_HEADERS === 'true',
    caddyRateLimit: caddyHasRateLimit(process.env.RR_CADDY_IMAGE),
  };
}

/**
 * Section 21.4: only the RemnaRay image carries `caddy-ratelimit`. An owner who
 * prefers the official image gets a configuration without the `rate_limit`
 * blocks, which is the documented degradation.
 */
export function caddyHasRateLimit(image: string | undefined): boolean {
  return !/^(?:docker\.io\/)?(?:library\/)?caddy:/u.test(image ?? '');
}

export const PROXY_SETTING_KEYS = [
  'domain.main',
  'domain.acme_email',
  'domain.extra_domains',
  'admin.ip_allowlist',
];

/** `tmp` + `rename`, so nginx never reads a half-written file (section 21.2). */
export function writeAtomically(outputDirectory: string, files: RenderedFile[]): boolean {
  let changed = false;
  for (const file of files) {
    const target = resolve(outputDirectory, file.name);
    mkdirSync(dirname(target), { recursive: true });
    const current = existsSync(target) ? readFileSync(target, 'utf8') : null;
    if (current === file.content) continue;
    const temporary = `${target}.tmp`;
    writeFileSync(temporary, file.content, 'utf8');
    renameSync(temporary, target);
    changed = true;
  }
  return changed;
}

/**
 * P-20: where a changed render waits for the running proxy to validate it,
 * inside the shared volume (`/etc/nginx/conf.d/.staging`,
 * `/etc/caddy/.staging`). The templates include each other by relative path,
 * so the staged main file includes the staged files.
 */
export const STAGING_DIRECTORY = '.staging';

/** The file each proxy is started with. */
export function mainFile(profile: ProxyProfile): string {
  return profile === 'caddy' ? 'Caddyfile' : 'nginx.conf';
}

/** What the reloader answers about a staged render. */
export type Verdict = 'ok' | 'invalid' | 'unavailable';

export type RenderOutcome = 'unchanged' | 'written' | 'promoted' | 'refused' | 'pending';

/**
 * P-20: the live files are the last configuration known to be good. A render
 * that changes them is staged and validated by the running proxy first:
 * accepted, it replaces them; refused, they stay (the reloader reports the
 * refusal); with nothing to validate it (the proxy not running yet), they
 * stay until it can. Only the very first render, with nothing live to keep,
 * is written straight away.
 */
export async function applyRender(
  outputDirectory: string,
  files: RenderedFile[],
  profile: ProxyProfile,
  validate: () => Promise<Verdict>,
): Promise<RenderOutcome> {
  const staging = resolve(outputDirectory, STAGING_DIRECTORY);
  if (!existsSync(resolve(outputDirectory, mainFile(profile)))) {
    writeAtomically(outputDirectory, files);
    return 'written';
  }
  const changed = files.some((file) => {
    const target = resolve(outputDirectory, file.name);
    return !existsSync(target) || readFileSync(target, 'utf8') !== file.content;
  });
  if (!changed) {
    rmSync(staging, { recursive: true, force: true });
    return 'unchanged';
  }
  rmSync(staging, { recursive: true, force: true });
  writeAtomically(staging, files);
  const verdict = await validate();
  if (verdict === 'invalid') return 'refused';
  if (verdict === 'unavailable') return 'pending';
  writeAtomically(outputDirectory, files);
  rmSync(staging, { recursive: true, force: true });
  return 'promoted';
}
