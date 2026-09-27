import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import process from 'node:process';
import test from 'node:test';

const table = await readFile('deploy/ci/expected-status.tsv', 'utf8');
const workflow = await readFile('.github/workflows/ci.yml', 'utf8');

/** The rows of `expected-status.tsv`, comments and blank lines dropped. */
const rows = table
  .split('\n')
  .filter((line) => line.trim() !== '' && !line.startsWith('#'))
  .map((line) => {
    const [vantage, method, path, status, why] = line.split('\t');
    return { vantage, method, path, status, why };
  });

test('the expected-status table is well formed', () => {
  assert.ok(rows.length >= 15, `only ${String(rows.length)} rows`);
  for (const row of rows) {
    assert.ok(['inside', 'outside'].includes(row.vantage), `bad vantage: ${row.vantage}`);
    assert.match(row.method, /^(GET|POST)$/u);
    assert.match(row.path, /^\//u);
    assert.match(row.status, /^[1-5]\d\d$/u);
    assert.ok(row.why && row.why.length > 0, `row ${row.path} has no reason`);
  }
});

test('every path of section 21.5 is compared between the profiles', () => {
  const paths = new Set(rows.map((row) => row.path));
  const covered = (prefix) => [...paths].some((path) => path.startsWith(prefix));

  for (const path of ['/', '/account', '/admin', '/setup', '/healthz', '/metrics'])
    assert.ok(paths.has(path), `section 21.5 path not covered: ${path}`);
  for (const prefix of [
    '/api/v1/public/config',
    '/api/admin/v1/auth/me',
    '/webhooks/',
    '/tg/webhook/',
    '/_next/static/',
    '/themes/',
  ])
    assert.ok(covered(prefix), `section 21.5 path not covered: ${prefix}`);
});

test('the invariants section 22.7 step 4 names are in the table', () => {
  const statusOf = (method, path) =>
    rows.find((row) => row.method === method && row.path === path)?.status;

  // A non-POST webhook answers 405 — not the 403 `limit_except` would give.
  assert.equal(statusOf('GET', '/webhooks/mock'), '405');
  assert.equal(statusOf('GET', '/tg/webhook/x'), '405');
  // An unsigned Telegram webhook is refused by `api`, not lost as a 404.
  assert.equal(statusOf('POST', '/tg/webhook/x'), '403');
  // `/metrics` is denied from outside the compose network, whatever the method.
  assert.equal(statusOf('GET', '/metrics'), '403');
  assert.equal(statusOf('POST', '/metrics'), '403');
  assert.ok(
    rows.some((row) => row.vantage === 'inside'),
    'nothing is checked from inside the compose network',
  );
});

test('the smoke scripts are executable and parse', async () => {
  for (const [script, shell] of [
    ['deploy/ci/proxy-smoke.sh', 'bash'],
    ['deploy/ci/gen-selfsigned.sh', 'sh'],
  ]) {
    const info = await stat(script);
    assert.ok(info.mode & 0o111, `${script} is not executable`);
    execFileSync(shell, ['-n', script]);
  }
  execFileSync(process.execPath, ['--check', 'deploy/ci/admin-session.mjs']);
});

test('CI runs the smoke against both profiles, and builds every image', () => {
  assert.match(workflow, /proxy-smoke:\n\s+name: proxy-smoke/u);
  assert.match(workflow, /profile: \[nginx, caddy\]/u);
  assert.match(workflow, /deploy\/ci\/proxy-smoke\.sh \$\{\{ matrix\.profile \}\}/u);
  for (const image of ['app', 'web', 'nginx', 'caddy', 'backup'])
    assert.match(workflow, new RegExp(`- image: ${image}\\n`, 'u'), `${image} is never built`);
});

test('both stands the browser suite runs on create the promo codes it types', async () => {
  const specs = await Promise.all(
    ['e2e/specs/account.spec.ts', 'e2e/specs/site.spec.ts'].map((file) => readFile(file, 'utf8')),
  );
  const codes = specs.flatMap((spec) =>
    [...spec.matchAll(/getByLabel\('Промокод'\)\.fill\('(?<code>[^']+)'\)/gu)].map(
      (match) => match.groups.code,
    ),
  );
  assert.ok(codes.length > 0, 'no spec types a promo code any more; drop this test');
  const local = await readFile('e2e/setup/stack.mjs', 'utf8');
  const smoke = await readFile('deploy/ci/proxy-smoke.sh', 'utf8');
  for (const code of codes) {
    const created = new RegExp(`code: '${code}'|VALUES \\('${code}'`, 'iu');
    assert.match(local, created, `e2e/setup/stack.mjs does not create ${code}`);
    assert.match(smoke, created, `deploy/ci/proxy-smoke.sh does not create ${code}`);
  }
});
