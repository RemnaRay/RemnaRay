import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import { Buffer } from 'node:buffer';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { GenericContainer } from 'testcontainers';

const IMAGE = 'remnaray/nginx:test';
const CADDY_IMAGE = 'remnaray/caddy:test';
const TEMPLATES = resolve(process.cwd(), 'deploy/proxy');
const MODES = ['acme', 'certbot', 'custom'];

/** `nginx -t` reports on stderr, so both streams are returned together. */
function docker(args, { expectSuccess = true } = {}) {
  const result = spawnSync('docker', args, { encoding: 'utf8' });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (expectSuccess && result.status !== 0)
    throw new Error(`docker ${args.join(' ')} failed with ${String(result.status)}:\n${output}`);
  return output;
}

/** `nginx -t` loads the certificate files, so the modes that name real paths need one. */
function selfSigned(directory) {
  execFileSync('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    join(directory, 'privkey.pem'),
    '-out',
    join(directory, 'fullchain.pem'),
    '-days',
    '2',
    '-subj',
    '/CN=shop.example.test',
  ]);
}

async function renderInto(
  output,
  mode,
  domain,
  databaseUrl,
  valkeyUrl,
  watch,
  templates = TEMPLATES,
) {
  const child = spawn(
    'node',
    [
      'apps/api/dist/tools/render-proxy.js',
      '--profile',
      'nginx',
      '--tls',
      mode,
      '--templates',
      templates,
      '--out',
      output,
      ...(watch ? ['--watch'] : []),
    ],
    {
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        VALKEY_URL: valkeyUrl,
        RR_DOMAIN: domain,
        RR_ACME_EMAIL: 'ops@example.test',
      },
      stdio: 'pipe',
    },
  );
  const log = [];
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', (chunk) => log.push(String(chunk)));
  if (!watch) {
    const code = await new Promise((done) => child.on('exit', done));
    assert.equal(code, 0, log.join(''));
    return { log };
  }
  return { child, log };
}

test(
  'TASK-M5-002: the rendered nginx configuration is valid in every TLS mode',
  { timeout: 600_000 },
  async () => {
    docker(['build', '-f', 'deploy/proxy/nginx/Dockerfile', '-t', IMAGE, '.']);

    const modules = docker(['run', '--rm', IMAGE, 'ls', '/usr/lib/nginx/modules']);
    assert.match(modules, /ngx_http_acme_module\.so/u, 'the ACME module must be in the image');

    const postgres = await new PostgreSqlContainer('postgres:18-alpine')
      .withDatabase('remnaray')
      .withUsername('remnaray')
      .withPassword('remnaray')
      .start();
    const valkey = await new GenericContainer('valkey/valkey:9.1-alpine')
      .withExposedPorts(6379)
      .start();
    const databaseUrl = postgres.getConnectionUri();
    const valkeyUrl = `redis://${valkey.getHost()}:${String(valkey.getMappedPort(6379))}/0`;
    execFileSync('pnpm', ['--filter', '@remnaray/db', 'db:migrate:deploy'], {
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
    });

    const certs = mkdtempSync(join(tmpdir(), 'rr-certs-'));
    selfSigned(certs);
    const roots = new Map(
      MODES.map((mode) => [mode, mkdtempSync(join(tmpdir(), `rr-conf-${mode}-`))]),
    );

    try {
      for (const mode of MODES) {
        await renderInto(roots.get(mode), mode, 'shop.example.test', databaseUrl, valkeyUrl, false);
        const output = docker(
          [
            'run',
            '--rm',
            '--add-host',
            'web:127.0.0.1',
            '--add-host',
            'api:127.0.0.1',
            '-v',
            `${roots.get(mode)}:/etc/nginx/conf.d:ro`,
            '-v',
            `${certs}:/etc/nginx/certs:ro`,
            '-v',
            `${certs}:/etc/letsencrypt/live/shop.example.test:ro`,
            IMAGE,
            'nginx',
            '-t',
            '-c',
            '/etc/nginx/conf.d/nginx.conf',
          ],
          { stdio: ['ignore', 'pipe', 'pipe'] },
        );
        assert.match(output, /test is successful/u, `nginx -t failed for ${mode}`);
      }

      // --- reload within fifteen seconds of a domain change (section 21.6) ---
      const output = roots.get('acme');
      const reports = [];
      let attempts = 0;
      // The first report meets the 503 the API answers while the setup wizard
      // runs (section 17.4) — the wizard's domain step is what reloads.
      const stub = createServer((request, response) => {
        const chunks = [];
        request.on('data', (chunk) => chunks.push(chunk));
        request.on('end', () => {
          attempts += 1;
          response.setHeader('content-type', 'application/json');
          if (attempts === 1) {
            response.writeHead(503);
            response.end('{"error":{"code":"SETUP_NOT_COMPLETED"}}');
            return;
          }
          reports.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          response.writeHead(200);
          response.end('{"recorded":true}');
        });
      });
      await new Promise((done) => stub.listen(0, '127.0.0.1', done));
      const stubUrl = `http://127.0.0.1:${String(stub.address().port)}`;

      // A copy, so the test can add a file of the owner's to `custom.d`.
      const templates = mkdtempSync(join(tmpdir(), 'rr-templates-'));
      cpSync(TEMPLATES, templates, { recursive: true });
      const watcher = await renderInto(
        output,
        'acme',
        'shop.example.test',
        databaseUrl,
        valkeyUrl,
        true,
        templates,
      );
      const proxy = docker([
        'run',
        '-d',
        '--rm',
        '--add-host',
        'web:127.0.0.1',
        '--add-host',
        'api:127.0.0.1',
        '-v',
        `${output}:/etc/nginx/conf.d:ro`,
        IMAGE,
      ]).trim();

      const reloader = spawn(
        'node',
        ['apps/api/dist/tools/proxy-reloader.js', '--profile', 'nginx'],
        {
          env: {
            ...process.env,
            VALKEY_URL: valkeyUrl,
            RR_PROXY_CONTAINER: proxy,
            INTERNAL_API_URL: stubUrl,
            RR_INTERNAL_TOKEN: 'proxy-reloader-test',
          },
          stdio: 'pipe',
        },
      );
      const reloaderLog = [];
      for (const stream of [reloader.stdout, reloader.stderr])
        stream.on('data', (chunk) => reloaderLog.push(String(chunk)));

      try {
        await waitFor(() => watcher.log.join('').includes('watching rr:settings.changed'), 30_000);
        await waitFor(() => reloaderLog.join('').includes('watching rr:proxy.reload'), 30_000);

        const { createPrismaClient } = await import('../packages/db/dist/index.js');
        const prisma = createPrismaClient(databaseUrl);
        const changeDomain = async (domain) => {
          await prisma.setting.upsert({
            where: { key: 'domain.main' },
            create: { key: 'domain.main', value: domain, isSecret: false },
            update: { value: domain },
          });
          await valkey.exec([
            'valkey-cli',
            'publish',
            'rr:settings.changed',
            '{"keys":["domain.main"]}',
          ]);
        };

        const started = Date.now();
        await changeDomain('second.example.test');
        await waitFor(
          () =>
            readFileSync(join(output, 'site.conf'), 'utf8').includes(
              'server_name second.example.test;',
            ) && attempts > 0,
          15_000,
        );
        const elapsed = Date.now() - started;
        assert.ok(elapsed <= 15_000, `reload took ${String(elapsed)} ms`);
        process.stdout.write(`proxy reload after a domain change: ${String(elapsed)} ms\n`);
        assert.deepEqual(reports, [], 'the refused report is not recorded');

        // The refused report is kept, and goes before the next one.
        await changeDomain('third.example.test');
        await waitFor(() => reports.length >= 2, 15_000);
        await prisma.$disconnect();
        assert.deepEqual(reports, [{ ok: true }, { ok: true }], reloaderLog.join(''));
        assert.match(reloaderLog.join(''), /not recorded yet: 503/u);

        // P-20: a render nginx refuses — here an owner's `custom.d` file —
        // never becomes live. It used to be written over the live files and
        // only then refused, so the next start of the proxy failed.
        writeFileSync(join(templates, 'nginx/custom.d/broken.conf'), 'no_such_directive on;\n');
        await changeDomain('fourth.example.test');
        await waitFor(() => reports.some((report) => report.ok === false), 15_000);
        assert.match(
          readFileSync(join(output, 'site.conf'), 'utf8'),
          /server_name third\.example\.test;/u,
        );
        assert.match(
          readFileSync(join(output, '.staging', 'site.conf'), 'utf8'),
          /server_name fourth\.example\.test;/u,
        );
        // What a restarted proxy reads is still a configuration it accepts.
        const restarted = docker(
          [
            'run',
            '--rm',
            '--add-host',
            'web:127.0.0.1',
            '--add-host',
            'api:127.0.0.1',
            '-v',
            `${output}:/etc/nginx/conf.d:ro`,
            IMAGE,
            'nginx',
            '-t',
            '-c',
            '/etc/nginx/conf.d/nginx.conf',
          ],
          { expectSuccess: false },
        );
        assert.match(restarted, /test is successful/u, restarted);

        // Removed again, the next render validates and goes live.
        rmSync(join(templates, 'nginx/custom.d/broken.conf'));
        await changeDomain('fifth.example.test');
        await waitFor(
          () =>
            readFileSync(join(output, 'site.conf'), 'utf8').includes(
              'server_name fifth.example.test;',
            ),
          15_000,
        );
      } finally {
        reloader.kill('SIGTERM');
        watcher.child?.kill('SIGTERM');
        stub.close();
        docker(['rm', '-f', proxy], { expectSuccess: false });
        rmSync(templates, { recursive: true, force: true });
      }
    } finally {
      rmSync(certs, { recursive: true, force: true });
      for (const directory of roots.values()) rmSync(directory, { recursive: true, force: true });
      await valkey.stop();
      await postgres.stop();
    }
  },
);

async function waitFor(condition, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (condition()) return;
    } catch {
      // not ready yet
    }
    await sleep(200);
  }
  throw new Error('Timed out waiting for the condition');
}

test(
  'TASK-M5-003: the rendered Caddyfile is valid in both supported TLS modes',
  { timeout: 600_000 },
  async () => {
    docker(['build', '-f', 'deploy/proxy/caddy/Dockerfile', '-t', CADDY_IMAGE, '.']);

    const modules = docker(['run', '--rm', CADDY_IMAGE, 'caddy', 'list-modules']);
    assert.match(
      modules,
      /http\.handlers\.rate_limit/u,
      'the rate-limit module must be in the image',
    );

    const postgres = await new PostgreSqlContainer('postgres:18-alpine')
      .withDatabase('remnaray')
      .withUsername('remnaray')
      .withPassword('remnaray')
      .start();
    const valkey = await new GenericContainer('valkey/valkey:9.1-alpine')
      .withExposedPorts(6379)
      .start();
    const databaseUrl = postgres.getConnectionUri();
    const valkeyUrl = `redis://${valkey.getHost()}:${String(valkey.getMappedPort(6379))}/0`;
    execFileSync('pnpm', ['--filter', '@remnaray/db', 'db:migrate:deploy'], {
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
    });

    const certs = mkdtempSync(join(tmpdir(), 'rr-caddy-certs-'));
    selfSigned(certs);
    const roots = new Map(
      ['acme', 'custom', 'stock', 'extra'].map((name) => [
        name,
        mkdtempSync(join(tmpdir(), `rr-caddy-${name}-`)),
      ]),
    );

    try {
      for (const [name, output] of roots) {
        const mode = name === 'stock' ? 'acme' : name === 'extra' ? 'custom' : name;
        // Section 21.6 adds the redirect site while the stand is running, and
        // it is a site of its own: a directive of it on the wrong line makes
        // Caddy refuse the whole file, which only `validate` catches here.
        if (name === 'extra') {
          const { createPrismaClient } = await import('../packages/db/dist/index.js');
          const prisma = createPrismaClient(databaseUrl);
          await prisma.setting.upsert({
            where: { key: 'domain.extra_domains' },
            update: { value: ['www.shop.example.test'] },
            create: { key: 'domain.extra_domains', value: ['www.shop.example.test'] },
          });
          await prisma.$disconnect();
        }
        const rendered = spawnSync(
          'node',
          [
            'apps/api/dist/tools/render-proxy.js',
            '--profile',
            'caddy',
            '--tls',
            mode,
            '--templates',
            TEMPLATES,
            '--out',
            output,
          ],
          {
            encoding: 'utf8',
            env: {
              ...process.env,
              DATABASE_URL: databaseUrl,
              VALKEY_URL: valkeyUrl,
              RR_DOMAIN: 'shop.example.test',
              RR_ACME_EMAIL: 'ops@example.test',
              // Section 21.4: the official image has no rate-limit module.
              ...(name === 'stock' ? { RR_CADDY_IMAGE: 'caddy:2-alpine' } : {}),
            },
          },
        );
        assert.equal(rendered.status, 0, `${rendered.stdout ?? ''}${rendered.stderr ?? ''}`);

        const caddyfile = readFileSync(join(output, 'Caddyfile'), 'utf8');
        assert.equal(
          caddyfile.includes('rate_limit'),
          name !== 'stock',
          `${name} carries the wrong rate-limit blocks`,
        );
        if (name === 'extra')
          assert.match(caddyfile, /www\.shop\.example\.test \{/u, 'the redirect site is missing');

        const result = docker(
          [
            'run',
            '--rm',
            '-v',
            `${output}:/etc/caddy:ro`,
            '-v',
            `${certs}:/certs:ro`,
            CADDY_IMAGE,
            'caddy',
            'validate',
            '--config',
            '/etc/caddy/Caddyfile',
            '--adapter',
            'caddyfile',
          ],
          { expectSuccess: false },
        );
        assert.match(result, /Valid configuration/u, `caddy validate failed for ${name}`);
      }

      // Section 21.4: `certbot` has no meaning for Caddy and must be refused.
      const refused = spawnSync(
        'node',
        [
          'apps/api/dist/tools/render-proxy.js',
          '--profile',
          'caddy',
          '--tls',
          'certbot',
          '--templates',
          TEMPLATES,
          '--out',
          roots.get('acme'),
        ],
        {
          encoding: 'utf8',
          env: { ...process.env, DATABASE_URL: databaseUrl, VALKEY_URL: valkeyUrl },
        },
      );
      assert.notEqual(refused.status, 0, 'certbot must not render for the caddy profile');
    } finally {
      rmSync(certs, { recursive: true, force: true });
      for (const directory of roots.values()) rmSync(directory, { recursive: true, force: true });
      await valkey.stop();
      await postgres.stop();
    }
  },
);

test(
  'TASK-M5-004: Certbot permissions remain root-only while renderer reads only domain metadata',
  { timeout: 120_000 },
  async () => {
    const prefix = `rr-certbot-permissions-${process.pid}`;
    const certVolume = `${prefix}-certs`;
    const stateVolume = `${prefix}-state`;
    const certs = mkdtempSync(join(tmpdir(), 'rr-certbot-permissions-'));
    selfSigned(certs);
    try {
      docker(['volume', 'create', certVolume]);
      docker(['volume', 'create', stateVolume]);
      docker([
        'run',
        '--rm',
        '--entrypoint',
        'sh',
        '-v',
        `${certVolume}:/etc/letsencrypt`,
        '-v',
        `${certs}:/fixture:ro`,
        'certbot/certbot:latest',
        '-c',
        'mkdir -p /etc/letsencrypt/archive/shop.example.test /etc/letsencrypt/live/shop.example.test; cp /fixture/fullchain.pem /etc/letsencrypt/archive/shop.example.test/fullchain1.pem; cp /fixture/privkey.pem /etc/letsencrypt/archive/shop.example.test/privkey1.pem; chmod 700 /etc/letsencrypt/archive /etc/letsencrypt/live; chmod 600 /etc/letsencrypt/archive/shop.example.test/privkey1.pem; ln -s ../../archive/shop.example.test/fullchain1.pem /etc/letsencrypt/live/shop.example.test/fullchain.pem; ln -s ../../archive/shop.example.test/privkey1.pem /etc/letsencrypt/live/shop.example.test/privkey.pem',
      ]);
      docker([
        'run',
        '--rm',
        '--entrypoint',
        'sh',
        '-v',
        `${certVolume}:/etc/letsencrypt:ro`,
        '-v',
        `${stateVolume}:/run/remnaray/certbot`,
        '-v',
        `${resolve('deploy/proxy/certbot.sh')}:/scripts/certbot.sh:ro`,
        'certbot/certbot:latest',
        '/scripts/certbot.sh',
        'sync',
      ]);
      // The production renderer runs as uid 1000 with NO certificate mount.
      const output = docker([
        'run',
        '--rm',
        '--user',
        '1000:1000',
        '-v',
        `${stateVolume}:/run/remnaray/certbot:ro`,
        '-v',
        // The compiled tools with their own relative modules, and no
        // `node_modules`: the renderer needs none of the application's.
        `${resolve('apps/api/dist')}:/dist:ro`,
        'node:24-alpine',
        'node',
        '-e',
        "const assert = require('node:assert/strict'); const fs = require('node:fs'); const {certbotCertificatePresent} = require('/dist/tools/proxy-render.js'); assert.equal(certbotCertificatePresent('shop.example.test'), true); assert.equal(certbotCertificatePresent('other.example.test'), false); assert.equal(fs.existsSync('/etc/letsencrypt'), false); console.log('renderer reads names only');",
      ]);
      assert.match(output, /renderer reads names only/);
      const permissions = docker([
        'run',
        '--rm',
        '--entrypoint',
        'sh',
        '-v',
        `${certVolume}:/etc/letsencrypt:ro`,
        'certbot/certbot:latest',
        '-c',
        'stat -c "%u:%g %a" /etc/letsencrypt/archive /etc/letsencrypt/live /etc/letsencrypt/archive/shop.example.test/privkey1.pem',
      ]);
      assert.equal(permissions.trim(), '0:0 700\n0:0 700\n0:0 600');
    } finally {
      docker(['volume', 'rm', certVolume, stateVolume], { expectSuccess: false });
      rmSync(certs, { recursive: true, force: true });
    }
  },
);

test(
  'Section 9.5: neither proxy forwards /api/internal/* outside the smoke stand',
  { timeout: 600_000 },
  async () => {
    docker(['build', '-f', 'deploy/proxy/nginx/Dockerfile', '-t', IMAGE, '.']);
    docker(['build', '-f', 'deploy/proxy/caddy/Dockerfile', '-t', CADDY_IMAGE, '.']);
    const { renderProfile, writeAtomically } =
      await import('../apps/api/dist/tools/proxy-render.js');
    const prefix = `rr-internal-${String(process.pid)}`;
    const network = `${prefix}-net`;
    const certs = mkdtempSync(join(tmpdir(), 'rr-internal-certs-'));
    selfSigned(certs);
    const directories = [];
    const containers = [];
    // One upstream stands in for both `api` and `web` and names itself, so a
    // response says whether the proxy answered or forwarded.
    const upstream = `const http = require('node:http');
      for (const port of [3000, 3001])
        http.createServer((q, r) => r.end('upstream ' + q.url)).listen(port);`;
    const probe = (path, method = 'GET') =>
      docker(
        [
          'run',
          '--rm',
          '--network',
          network,
          'curlimages/curl:8.17.0',
          '-sk',
          '-X',
          method,
          '-w',
          '\n%{http_code}',
          `https://shop.example.test${path}`,
        ],
        { expectSuccess: false },
      ).trim();
    try {
      docker(['network', 'create', network]);
      containers.push(`${prefix}-up`);
      docker([
        'run',
        '-d',
        '--name',
        `${prefix}-up`,
        '--network',
        network,
        '--network-alias',
        'api',
        '--network-alias',
        'web',
        'node:24-alpine',
        'node',
        '-e',
        upstream,
      ]);
      for (const profile of ['nginx', 'caddy'])
        for (const internalApi of [false, true]) {
          const directory = mkdtempSync(join(tmpdir(), `rr-internal-${profile}-`));
          directories.push(directory);
          writeAtomically(
            directory,
            renderProfile(
              resolve(TEMPLATES, profile),
              {
                domain: 'shop.example.test',
                extraDomains: [],
                acmeEmail: '',
                adminAllowlist: [],
                dockerCidr: '172.28.0.0/16',
                apiDocs: false,
                internalApi,
                caddyRateLimit: true,
              },
              { profile, tlsMode: 'custom', certificatePresent: true },
            ),
          );
          const name = `${prefix}-${profile}-${String(internalApi)}`;
          containers.push(name);
          docker([
            'run',
            '-d',
            '--name',
            name,
            '--network',
            network,
            '--network-alias',
            'shop.example.test',
            '-v',
            profile === 'nginx'
              ? `${directory}:/etc/nginx/conf.d:ro`
              : `${directory}:/etc/caddy:ro`,
            '-v',
            profile === 'nginx' ? `${certs}:/etc/nginx/certs:ro` : `${certs}:/certs:ro`,
            profile === 'nginx' ? IMAGE : CADDY_IMAGE,
          ]);
          let ready = '';
          for (let attempt = 0; attempt < 30 && !ready.endsWith('200'); attempt += 1) {
            await sleep(500);
            ready = probe('/api/v1/public/config');
          }
          assert.match(
            ready,
            /^upstream \/api\/v1\/public\/config\n200$/u,
            `${name} never proxied`,
          );

          const internal = probe('/api/internal/v1/echo-headers', 'POST');
          if (internalApi)
            assert.match(internal, /^upstream \/api\/internal\/v1\/echo-headers\n200$/u, name);
          else {
            assert.match(internal, /(?:^|\n)404$/u, `${name} must answer /api/internal itself`);
            assert.doesNotMatch(internal, /upstream/u, `${name} forwarded /api/internal`);
          }
          // The Caddy profile's API docs denial ran after `handle /api/*`.
          const apiDocs = probe('/api/docs');
          assert.match(apiDocs, /(?:^|\n)(?:403|404)$/u, `${name} forwarded /api/docs`);
          assert.doesNotMatch(apiDocs, /upstream/u, `${name} forwarded /api/docs`);

          docker(['rm', '-f', name], { expectSuccess: false });
          containers.splice(containers.indexOf(name), 1);
        }
    } finally {
      for (const container of containers) docker(['rm', '-f', container], { expectSuccess: false });
      docker(['network', 'rm', network], { expectSuccess: false });
      rmSync(certs, { recursive: true, force: true });
      for (const directory of directories) rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  'Section 21.3: a security header the upstream also sends reaches the client once',
  { timeout: 600_000 },
  async () => {
    docker(['build', '-f', 'deploy/proxy/nginx/Dockerfile', '-t', IMAGE, '.']);
    docker(['build', '-f', 'deploy/proxy/caddy/Dockerfile', '-t', CADDY_IMAGE, '.']);
    const { renderProfile, writeAtomically } =
      await import('../apps/api/dist/tools/proxy-render.js');
    const prefix = `rr-once-${String(process.pid)}`;
    const network = `${prefix}-net`;
    const certs = mkdtempSync(join(tmpdir(), 'rr-once-certs-'));
    selfSigned(certs);
    const directories = [];
    const containers = [];
    // `web` sends `nosniff` with every theme asset (its SVGs are sandboxed),
    // as the proxy does for every answer.
    const upstream = `const http = require('node:http');
      for (const port of [3000, 3001])
        http.createServer((q, r) => {
          r.setHeader('X-Content-Type-Options', 'nosniff');
          r.setHeader('Content-Type', 'image/svg+xml');
          r.end('<svg xmlns="http://www.w3.org/2000/svg"/>');
        }).listen(port);`;
    const headersOf = (path) =>
      docker(
        [
          'run',
          '--rm',
          '--network',
          network,
          'curlimages/curl:8.17.0',
          '-sk',
          '-o',
          '/dev/null',
          '-D',
          '-',
          `https://shop.example.test${path}`,
        ],
        { expectSuccess: false },
      );
    try {
      docker(['network', 'create', network]);
      containers.push(`${prefix}-up`);
      docker([
        'run',
        '-d',
        '--name',
        `${prefix}-up`,
        '--network',
        network,
        '--network-alias',
        'api',
        '--network-alias',
        'web',
        'node:24-alpine',
        'node',
        '-e',
        upstream,
      ]);
      for (const profile of ['nginx', 'caddy']) {
        const directory = mkdtempSync(join(tmpdir(), `rr-once-${profile}-`));
        directories.push(directory);
        writeAtomically(
          directory,
          renderProfile(
            resolve(TEMPLATES, profile),
            {
              domain: 'shop.example.test',
              extraDomains: [],
              acmeEmail: '',
              adminAllowlist: [],
              dockerCidr: '172.28.0.0/16',
              apiDocs: false,
              internalApi: false,
              caddyRateLimit: true,
            },
            { profile, tlsMode: 'custom', certificatePresent: true },
          ),
        );
        const name = `${prefix}-${profile}`;
        containers.push(name);
        docker([
          'run',
          '-d',
          '--name',
          name,
          '--network',
          network,
          '--network-alias',
          'shop.example.test',
          '-v',
          profile === 'nginx' ? `${directory}:/etc/nginx/conf.d:ro` : `${directory}:/etc/caddy:ro`,
          '-v',
          profile === 'nginx' ? `${certs}:/etc/nginx/certs:ro` : `${certs}:/certs:ro`,
          profile === 'nginx' ? IMAGE : CADDY_IMAGE,
        ]);
        let headers = '';
        for (let attempt = 0; attempt < 30 && !/^HTTP\/\S+ 200/mu.test(headers); attempt += 1) {
          await sleep(500);
          headers = headersOf('/themes/manta/favicon.svg');
        }
        assert.match(headers, /^HTTP\/\S+ 200/mu, `${name} never proxied:\n${headers}`);
        const count = headers.match(/^x-content-type-options:/gimu)?.length ?? 0;
        assert.equal(count, 1, `${name} sent x-content-type-options ${String(count)} times`);

        docker(['rm', '-f', name], { expectSuccess: false });
        containers.splice(containers.indexOf(name), 1);
      }
    } finally {
      for (const container of containers) docker(['rm', '-f', container], { expectSuccess: false });
      docker(['network', 'rm', network], { expectSuccess: false });
      rmSync(certs, { recursive: true, force: true });
      for (const directory of directories) rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  'Section 19.6: the access logs carry neither the webhook secret path nor a query token',
  { timeout: 600_000 },
  async () => {
    docker(['build', '-f', 'deploy/proxy/nginx/Dockerfile', '-t', IMAGE, '.']);
    docker(['build', '-f', 'deploy/proxy/caddy/Dockerfile', '-t', CADDY_IMAGE, '.']);
    const { renderProfile, writeAtomically } =
      await import('../apps/api/dist/tools/proxy-render.js');
    const prefix = `rr-logs-${String(process.pid)}`;
    const network = `${prefix}-net`;
    const certs = mkdtempSync(join(tmpdir(), 'rr-logs-certs-'));
    selfSigned(certs);
    const directories = [];
    const containers = [];
    const upstream = `const http = require('node:http');
      for (const port of [3000, 3001]) http.createServer((q, r) => r.end('ok')).listen(port);`;
    const request = (args) =>
      docker(
        [
          'run',
          '--rm',
          '--network',
          network,
          'curlimages/curl:8.17.0',
          '-sk',
          '-o',
          '/dev/null',
          '-w',
          '%{http_code}',
          ...args,
        ],
        { expectSuccess: false },
      );
    try {
      docker(['network', 'create', network]);
      containers.push(`${prefix}-up`);
      docker([
        'run',
        '-d',
        '--name',
        `${prefix}-up`,
        '--network',
        network,
        '--network-alias',
        'api',
        '--network-alias',
        'web',
        'node:24-alpine',
        'node',
        '-e',
        upstream,
      ]);
      for (const profile of ['nginx', 'caddy']) {
        const directory = mkdtempSync(join(tmpdir(), `rr-logs-${profile}-`));
        directories.push(directory);
        writeAtomically(
          directory,
          renderProfile(
            resolve(TEMPLATES, profile),
            {
              domain: 'shop.example.test',
              extraDomains: [],
              acmeEmail: '',
              adminAllowlist: [],
              dockerCidr: '172.28.0.0/16',
              apiDocs: false,
              internalApi: false,
              caddyRateLimit: true,
            },
            { profile, tlsMode: 'custom', certificatePresent: true },
          ),
        );
        const name = `${prefix}-${profile}`;
        containers.push(name);
        docker([
          'run',
          '-d',
          '--name',
          name,
          '--network',
          network,
          '--network-alias',
          'shop.example.test',
          '-v',
          profile === 'nginx' ? `${directory}:/etc/nginx/conf.d:ro` : `${directory}:/etc/caddy:ro`,
          '-v',
          profile === 'nginx' ? `${certs}:/etc/nginx/certs:ro` : `${certs}:/certs:ro`,
          profile === 'nginx' ? IMAGE : CADDY_IMAGE,
        ]);
        let status = '';
        for (let attempt = 0; attempt < 30 && status !== '200'; attempt += 1) {
          await sleep(500);
          status = request(['https://shop.example.test/healthz']);
        }
        assert.equal(status, '200', `${name} never answered`);
        assert.equal(
          request([
            '-X',
            'POST',
            '-H',
            'content-type: application/json',
            '-H',
            'X-Telegram-Bot-Api-Secret-Token: HEADERSECRET',
            '-d',
            '{}',
            'https://shop.example.test/tg/webhook/SECRETPATH?token=QUERYTOKEN',
          ]),
          '200',
        );
        assert.equal(
          request([
            '-H',
            'Referer: https://shop.example.test/auth/tg?token=REFERERTOKEN',
            'https://shop.example.test/auth/tg?token=SIGNINTOKEN',
          ]),
          '200',
        );
        await sleep(500);
        const logs = docker(['logs', name]);
        assert.match(logs, /\/tg\/webhook\/\*\*\*/u, `${name} logged no webhook line:\n${logs}`);
        for (const secret of [
          'SECRETPATH',
          'QUERYTOKEN',
          'HEADERSECRET',
          'REFERERTOKEN',
          'SIGNINTOKEN',
        ])
          assert.doesNotMatch(logs, new RegExp(secret, 'u'), `${name} logged ${secret}:\n${logs}`);

        docker(['rm', '-f', name], { expectSuccess: false });
        containers.splice(containers.indexOf(name), 1);
      }
    } finally {
      for (const container of containers) docker(['rm', '-f', container], { expectSuccess: false });
      docker(['network', 'rm', network], { expectSuccess: false });
      rmSync(certs, { recursive: true, force: true });
      for (const directory of directories) rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  'R137: Caddy`s admin API answers only inside its container; the metrics port answers the network',
  { timeout: 600_000 },
  async () => {
    docker(['build', '-f', 'deploy/proxy/caddy/Dockerfile', '-t', CADDY_IMAGE, '.']);
    const { renderProfile, writeAtomically } =
      await import('../apps/api/dist/tools/proxy-render.js');
    const prefix = `rr-admin-${String(process.pid)}`;
    const network = `${prefix}-net`;
    const certs = mkdtempSync(join(tmpdir(), 'rr-admin-certs-'));
    selfSigned(certs);
    const directory = mkdtempSync(join(tmpdir(), 'rr-admin-caddy-'));
    const containers = [];
    const curl = (url, args = []) =>
      docker(
        [
          'run',
          '--rm',
          '--network',
          network,
          'curlimages/curl:8.17.0',
          '-s',
          '-o',
          '/dev/null',
          '-w',
          '%{http_code}',
          '--max-time',
          '5',
          ...args,
          url,
        ],
        { expectSuccess: false },
      );
    try {
      docker(['network', 'create', network]);
      containers.push(`${prefix}-up`);
      docker([
        'run',
        '-d',
        '--name',
        `${prefix}-up`,
        '--network',
        network,
        '--network-alias',
        'api',
        '--network-alias',
        'web',
        'node:24-alpine',
        'node',
        '-e',
        `for (const port of [3000, 3001]) require('node:http').createServer((q, r) => r.end('ok')).listen(port);`,
      ]);
      writeAtomically(
        directory,
        renderProfile(
          resolve(TEMPLATES, 'caddy'),
          {
            domain: 'shop.example.test',
            extraDomains: [],
            acmeEmail: '',
            adminAllowlist: [],
            dockerCidr: '172.28.0.0/16',
            apiDocs: false,
            internalApi: false,
            caddyRateLimit: true,
          },
          { profile: 'caddy', tlsMode: 'custom', certificatePresent: true },
        ),
      );
      const name = `${prefix}-caddy`;
      containers.push(name);
      docker([
        'run',
        '-d',
        '--name',
        name,
        '--network',
        network,
        '--network-alias',
        'proxy-caddy',
        '-v',
        `${directory}:/etc/caddy:ro`,
        '-v',
        `${certs}:/certs:ro`,
        CADDY_IMAGE,
      ]);
      let metrics = '';
      for (let attempt = 0; attempt < 30 && metrics !== '200'; attempt += 1) {
        await sleep(500);
        metrics = curl('http://proxy-caddy:2020/metrics');
      }
      assert.equal(metrics, '200', 'the metrics port never answered');
      // curl reports 000 when nothing listens there.
      assert.equal(curl('http://proxy-caddy:2019/config/'), '000');
      assert.equal(
        curl('http://proxy-caddy:2019/load', [
          '-X',
          'POST',
          '-H',
          'content-type: application/json',
          '-d',
          '{}',
        ]),
        '000',
      );
      // `caddy reload`, which the reloader runs inside the container, still
      // reaches it.
      docker([
        'exec',
        name,
        'caddy',
        'reload',
        '--config',
        '/etc/caddy/Caddyfile',
        '--adapter',
        'caddyfile',
      ]);
    } finally {
      for (const container of containers) docker(['rm', '-f', container], { expectSuccess: false });
      docker(['network', 'rm', network], { expectSuccess: false });
      rmSync(certs, { recursive: true, force: true });
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
