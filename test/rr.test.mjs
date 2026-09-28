import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import test from 'node:test';

const rr = resolve('scripts/rr');
function run(command, values = {}, failure = '', options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'rr-cli-'));
  try {
    writeFileSync(
      join(root, '.env'),
      Object.entries({
        RR_PROXY_PROFILE: 'nginx',
        RR_TLS_MODE: 'certbot',
        RR_DOMAIN: 'shop.example.test',
        RR_ACME_EMAIL: 'owner@example.test',
        ...values,
      })
        .map(([key, value]) => `${key}=${value}`)
        .join('\n'),
    );
    writeFileSync(
      join(root, 'docker'),
      `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.RR_TEST_LOG, JSON.stringify(args) + '\\n');
fs.appendFileSync(process.env.RR_TEST_LOG + '.env', JSON.stringify({ RR_VERSION: process.env.RR_VERSION, RR_REGISTRY: process.env.RR_REGISTRY }) + '\\n');
if (process.env.RR_TEST_FAILURE && args.includes(process.env.RR_TEST_FAILURE)) process.exit(1);
if (args[0] === 'ps' && process.env.RR_TEST_STALE_ID) console.log(process.env.RR_TEST_STALE_ID);
if (args.includes('config') && args.includes('--services')) console.log('proxy-caddy\\nproxy-nginx\\nedge\\ncertbot\\nproxy-config\\nproxy-reloader');
// RR_TEST_IDS: {service: [container id before \`up\`, after it]}, answered in turn.
if (args.includes('ps') && args.includes('-aq')) {
  const service = args.at(-1);
  const ids = JSON.parse(process.env.RR_TEST_IDS || '{}')[service] || [];
  const counter = process.env.RR_TEST_LOG + '.' + service;
  const seen = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0;
  fs.writeFileSync(counter, String(seen + 1));
  const id = ids[Math.min(seen, ids.length - 1)];
  if (id) console.log(id);
}
`,
      { mode: 0o755 },
    );
    writeFileSync(
      join(root, 'curl'),
      `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(process.env.RR_TEST_LOG, JSON.stringify(['curl', ...process.argv.slice(2)]) + '\\n');
if (process.env.RR_TEST_CURL_FAIL) { process.stderr.write('certificate verify failed'); process.exit(60); }
process.stdout.write('ok');
`,
      { mode: 0o755 },
    );
    const result = spawnSync('sh', [rr, ...command], {
      timeout: 10000,
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${root}:${process.env.PATH}`,
        RR_TEST_LOG: join(root, 'calls'),
        RR_TEST_FAILURE: failure,
        ...options,
      },
    });
    let calls = [];
    let environments = [];
    try {
      calls = readFileSync(join(root, 'calls'), 'utf8').trim().split('\n').map(JSON.parse);
      environments = readFileSync(join(root, 'calls.env'), 'utf8')
        .trim()
        .split('\n')
        .map(JSON.parse);
    } catch {
      // Validation can fail before Docker is invoked.
    }
    return { ...result, calls, environments };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('tls:issue overrides the renewal entrypoint with initial certonly issuance', () => {
  const result = run(['tls:issue']);
  assert.equal(result.status, 0, result.stderr);
  const issue = result.calls.find((args) => args.includes('certonly'));
  assert.deepEqual(issue.slice(issue.indexOf('run')), [
    'run',
    '--rm',
    '--no-deps',
    '--entrypoint',
    'certbot',
    'certbot',
    'certonly',
    '--webroot',
    '-w',
    '/var/www/certbot',
    '-d',
    'shop.example.test',
    '-m',
    'owner@example.test',
    '--agree-tos',
    '-n',
    '--cert-name',
    'shop.example.test',
    '--keep-until-expiring',
    '--deploy-hook',
    'sh /scripts/certbot.sh deploy',
  ]);
  assert.ok(!issue.includes('renew'));
  const certbot = readFileSync('deploy/proxy/certbot.sh', 'utf8');
  assert.match(certbot, /certbot renew --webroot -w \/var\/www\/certbot/);
});

test('admin:list uses the running API container without exposing recovery secrets', () => {
  const result = run(['admin:list']);
  assert.equal(result.status, 0, result.stderr);
  const call = result.calls.find((args) => args.includes('exec') && args.includes('api'));
  assert.ok(call);
  assert.ok(call.includes('-e'));
  assert.ok(!call.some((arg) => arg.includes('PASSWORD')));
});

test('tls:issue refuses missing issuance settings and propagates Certbot failures', () => {
  assert.equal(run(['tls:issue'], { RR_ACME_EMAIL: '' }).status, 2);
  assert.equal(run(['tls:issue'], { RR_TLS_MODE: 'custom' }).status, 1);
  const failed = run(['tls:issue'], {}, 'certonly');
  assert.equal(failed.status, 1);
  assert.ok(!failed.calls.some((args) => args.includes('restart')));
});

test('profile lifecycle removes only stale proxy containers and down enables every deployment profile', () => {
  const switched = run(['up']);
  assert.ok(
    switched.calls.some(
      (args) => args[0] === 'compose' && args.includes('*') && args.includes('config'),
    ),
  );
  assert.ok(
    switched.calls.some(
      (args) => args[0] === 'compose' && args.includes('rm') && args.includes('--stop'),
    ),
  );
  assert.ok(
    switched.calls.some((args) => args.includes('--wait') && args.includes('--wait-timeout')),
  );

  const down = run(['down']);
  const downCall = down.calls.find((args) => args[0] === 'compose' && args.at(-1) === 'down');
  assert.deepEqual(downCall.slice(downCall.indexOf('--profile')), ['--profile', '*', 'down']);
});

test('proxy-config and proxy-reloader do not mount Certbot private-key material', () => {
  const compose = readFileSync('compose.yaml', 'utf8');
  const proxyConfig = compose.slice(
    compose.indexOf('  proxy-config:'),
    compose.indexOf('  proxy-nginx:'),
  );
  const reloader = compose.slice(
    compose.indexOf('  proxy-reloader:'),
    compose.indexOf('  backup:'),
  );
  assert.doesNotMatch(proxyConfig, /certbot-certs/u);
  assert.doesNotMatch(reloader, /certbot-certs/u);
  assert.match(proxyConfig, /certbot-state:\/run\/remnaray\/certbot:ro/u);
  assert.match(compose, /certbot-state:\/run\/remnaray\/certbot/u);
});

test('readiness fails with diagnostics when Compose health never succeeds', () => {
  const result = run(['up', '--wait-timeout', '1'], { RR_TLS_MODE: 'custom' }, '--wait');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /readiness failed/);
  assert.ok(result.calls.some((args) => args.includes('logs')));
  assert.ok(!result.calls.some((args) => args[0] === 'curl'));
});

test('HTTPS readiness checks a trusted chain and returns a bounded failure', () => {
  const result = run(['up', '--wait-timeout', '1'], { RR_TLS_MODE: 'acme' }, '', {
    RR_TEST_CURL_FAIL: 'true',
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /certificate verify failed/);
  const curls = result.calls.filter((args) => args[0] === 'curl');
  assert.ok(curls.length > 0);
  assert.ok(curls.every((args) => !args.includes('-k') && !args.includes('--insecure')));
  assert.ok(curls.every((args) => args.includes('shop.example.test:443:127.0.0.1')));
});

test('both proxy switches and external remove only the inactive services through Compose', () => {
  for (const [profile, stale, active] of [
    ['nginx', 'proxy-caddy', 'proxy-nginx'],
    ['caddy', 'proxy-nginx', 'proxy-caddy'],
    ['external', 'proxy-nginx', 'edge'],
  ]) {
    const result = run(['up'], {
      RR_PROXY_PROFILE: profile,
      RR_TLS_MODE: profile === 'external' ? 'none' : 'custom',
    });
    assert.equal(result.status, 0, result.stderr);
    const removals = result.calls.filter((args) => args.includes('rm'));
    assert.ok(removals.some((args) => args.at(-1) === stale));
    assert.ok(
      removals.every(
        (args) => args[0] === 'compose' && args.at(-1) !== active && !args.includes('-v'),
      ),
    );
    if (profile === 'external') assert.ok(removals.some((args) => args.at(-1) === 'proxy-config'));
  }
});

test('initial issuance waits for rendering before reload and restarts renewal on failure', () => {
  const result = run(['tls:issue']);
  const render = result.calls.findIndex((args) => args.includes('dist/tools/render-proxy.js'));
  const reload = result.calls.findIndex((args) => args.includes('--reload'));
  assert.ok(render > 0 && reload > render);
  const failed = run(['tls:issue'], {}, 'certonly');
  assert.equal(failed.status, 1);
  assert.ok(failed.calls.some((args) => args.includes('start') && args.at(-1) === 'certbot'));
  assert.ok(!failed.calls.some((args) => args.includes('--reload')));
  assert.ok(run(['down', '-v']).calls.some((args) => args.at(-1) === '-v'));
});

test('up reloads a proxy it kept when the renderer was recreated with another TLS mode', () => {
  const up = (ids, mode = 'custom', profile = 'nginx') =>
    run(['up'], { RR_PROXY_PROFILE: profile, RR_TLS_MODE: mode }, '', {
      RR_TEST_IDS: JSON.stringify(ids),
    }).calls;
  const reloaded = (calls) => {
    const ready = calls.findIndex((args) => args.includes('--wait'));
    const render = calls.findIndex((args) => args.includes('dist/tools/render-proxy.js'));
    const reload = calls.findIndex((args) => args.includes('--reload'));
    if (reload < 0) return false;
    assert.ok(ready >= 0 && render > ready && reload > render);
    return true;
  };

  // acme → custom: Compose recreates proxy-config and keeps the proxy.
  for (const profile of ['nginx', 'caddy'])
    assert.ok(
      reloaded(
        up({ 'proxy-config': ['old', 'new'], [`proxy-${profile}`]: ['kept'] }, 'custom', profile),
      ),
      profile,
    );
  // A proxy created by this `up` read the new render when it started.
  assert.ok(!reloaded(up({ 'proxy-config': ['old', 'new'], 'proxy-nginx': ['old', 'new'] })));
  assert.ok(!reloaded(up({ 'proxy-config': ['', 'new'], 'proxy-nginx': ['', 'new'] })));
  // Nothing recreated: nothing to apply.
  assert.ok(!reloaded(up({ 'proxy-config': ['same'], 'proxy-nginx': ['same'] }, 'acme')));
});

test('up pulls a moving image tag before starting, never a release tag unless asked', () => {
  const pulledBeforeUp = (command, values) => {
    const calls = run(command, { RR_TLS_MODE: 'acme', ...values }).calls;
    const pull = calls.findIndex((args) => args.at(-1) === 'pull');
    const up = calls.findIndex((args) => args.includes('--wait'));
    assert.ok(up >= 0, 'up ran');
    if (pull < 0) return false;
    assert.ok(pull < up, 'pull comes before up');
    return true;
  };

  // A build from the images workflow (RR_VERSION=dev) is replaced under the
  // same tag: a copy left from an older build would otherwise start.
  assert.ok(pulledBeforeUp(['up'], { RR_VERSION: 'dev' }));
  // A release tag is upgraded explicitly (docs/upgrade.md), and a source
  // checkout builds its images under the release tag: pulling would replace
  // the local build.
  assert.ok(!pulledBeforeUp(['up'], {}));
  assert.ok(!pulledBeforeUp(['up'], { RR_VERSION: '1.2.3' }));
  assert.ok(pulledBeforeUp(['up', '--pull'], { RR_VERSION: '1.2.3' }));
  assert.ok(pulledBeforeUp(['up', '--pull', '--wait-timeout', '60'], {}));
});

// R78 and R81: a reset from the shell does what a reset from the console does.
test('the shell recovery ends the admin`s sessions and lifts password locks', () => {
  const script = readFileSync('scripts/admin-recovery.mjs', 'utf8');
  const resetPassword = script.slice(
    script.indexOf("action === 'reset-password'"),
    script.indexOf("action === 'reset-totp'"),
  );
  const resetTotp = script.slice(script.indexOf("action === 'reset-totp'"));
  assert.match(resetPassword, /endAdminSessions\(redis, target\.id\)/u);
  assert.match(resetPassword, /clearPasswordFailures\(redis, target\.email\)/u);
  assert.match(resetTotp, /endAdminSessions\(redis, target\.id\)/u);
});

// R59: `docs/upgrade.md` rolls back with `RR_VERSION=1.2.2 ./scripts/rr up`,
// but `rr` exported every `RR_VERSION` of `.env` over the environment — the
// reverse of compose's own precedence — so with `RR_VERSION=1` in `.env`
// the "rollback" started the newest release again.
test('an RR_VERSION or RR_REGISTRY given in the environment wins over .env', () => {
  const pinned = run(['config'], { RR_VERSION: '1', RR_REGISTRY: 'ghcr.io/remnaray' }, '', {
    RR_VERSION: '1.2.2',
    RR_REGISTRY: 'registry.example.test/mirror',
  });
  assert.equal(pinned.status, 0, pinned.stderr);
  assert.ok(pinned.environments.length > 0);
  for (const environment of pinned.environments)
    assert.deepEqual(environment, {
      RR_VERSION: '1.2.2',
      RR_REGISTRY: 'registry.example.test/mirror',
    });

  // Without one, `.env` still decides.
  const plain = run(['config'], { RR_VERSION: '1', RR_REGISTRY: 'ghcr.io/remnaray' });
  assert.equal(plain.status, 0, plain.stderr);
  for (const entry of plain.environments)
    assert.deepEqual(entry, { RR_VERSION: '1', RR_REGISTRY: 'ghcr.io/remnaray' });
});

// R59: a pre-migrate dump holds the schema of the version the upgrade left.
// `restore.sh` then started the stack on the version `.env` names — the new
// one — whose `migrate` applied the same irreversible migration again at
// once. After such a dump it stops with PostgreSQL alone and says what to do.
test('restore.sh leaves the stack stopped after a pre-migrate dump', () => {
  const root = mkdtempSync(join(tmpdir(), 'rr-restore-'));
  try {
    writeFileSync(
      join(root, 'docker'),
      `#!/bin/sh
echo "$*" >> "${join(root, 'calls')}"
cat > /dev/null
`,
      { mode: 0o755 },
    );
    writeFileSync(join(root, 'compose.yaml'), 'services: {}\n');
    const restore = (name) => {
      writeFileSync(join(root, name), 'dump');
      rmSync(join(root, 'calls'), { force: true });
      const result = spawnSync('sh', [resolve('deploy/backup/restore.sh'), join(root, name)], {
        cwd: root,
        encoding: 'utf8',
        input: '',
        timeout: 10000,
        env: {
          ...process.env,
          PATH: `${root}:${process.env.PATH}`,
          COMPOSE_FILE: join(root, 'compose.yaml'),
          RR_RESTORE_ASSUME_YES: 'true',
        },
      });
      const calls = readFileSync(join(root, 'calls'), 'utf8').trim().split('\n');
      return { ...result, calls };
    };
    const startsTheStack = (calls) =>
      calls.some((call) => / up -d$/u.test(call) && !call.endsWith('up -d postgres'));

    const premigrate = restore('pre-migrate-0012_ledger_entries_account_indexes.dump');
    assert.equal(premigrate.status, 0, premigrate.stderr);
    assert.ok(!startsTheStack(premigrate.calls), premigrate.calls.join('\n'));
    assert.match(premigrate.stdout, /RR_VERSION/u);

    const daily = restore('remnaray-20260928-0300.dump');
    assert.equal(daily.status, 0, daily.stderr);
    assert.ok(startsTheStack(daily.calls), daily.calls.join('\n'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
