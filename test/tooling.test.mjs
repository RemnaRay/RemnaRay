import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { cp, glob, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import test from 'node:test';

const packageManifest = JSON.parse(await readFile('package.json', 'utf8'));
const workspaceManifest = await readFile('pnpm-workspace.yaml', 'utf8');

test('the root pins the supported package manager and runtime', () => {
  assert.equal(packageManifest.packageManager, 'pnpm@11.26.0');
  assert.equal(packageManifest.engines.node, '>=24.21 <25');
});

test('the workspace includes application and package shells', () => {
  assert.match(workspaceManifest, /- apps\/\*/);
  assert.match(workspaceManifest, /- packages\/\*/);
});

test('the required repository tooling is configured', () => {
  assert.equal(packageManifest.scripts.lint, 'eslint .');
  assert.equal(packageManifest.scripts.typecheck, 'tsc --noEmit');
  assert.equal(packageManifest.scripts.prepare, 'husky');
  assert.ok(packageManifest.devDependencies['@changesets/cli']);
  assert.ok(packageManifest.devDependencies['@commitlint/cli']);
  assert.ok(packageManifest.devDependencies.husky);
  assert.ok(packageManifest.devDependencies['lint-staged']);
});

const packageManifests = {
  root: packageManifest,
  api: JSON.parse(await readFile('apps/api/package.json', 'utf8')),
  bot: JSON.parse(await readFile('apps/bot/package.json', 'utf8')),
  worker: JSON.parse(await readFile('apps/worker/package.json', 'utf8')),
  web: JSON.parse(await readFile('apps/web/package.json', 'utf8')),
  config: JSON.parse(await readFile('packages/config/package.json', 'utf8')),
  db: JSON.parse(await readFile('packages/db/package.json', 'utf8')),
  domain: JSON.parse(await readFile('packages/domain/package.json', 'utf8')),
  i18n: JSON.parse(await readFile('packages/i18n-core/package.json', 'utf8')),
  logger: JSON.parse(await readFile('packages/logger/package.json', 'utf8')),
  sdk: JSON.parse(await readFile('packages/remnawave-sdk/package.json', 'utf8')),
  theme: JSON.parse(await readFile('packages/theme-schema/package.json', 'utf8')),
  ui: JSON.parse(await readFile('packages/ui/package.json', 'utf8')),
  testFixtures: JSON.parse(await readFile('packages/test-fixtures/package.json', 'utf8')),
};

function dependencyVersion(manifest, name) {
  return (
    manifest.dependencies?.[name] ??
    manifest.devDependencies?.[name] ??
    manifest.peerDependencies?.[name]
  );
}

test('the section 6.1 JavaScript dependency matrix is pinned', () => {
  const expected = {
    '@types/node': ['root', '~24.13.6'],
    turbo: ['root', '~2.11.0'],
    typescript: ['root', '~7.0.2'],
    eslint: ['root', '~10.10.0'],
    prettier: ['root', '~3.9.8'],
    '@nestjs/cli': ['root', '12.0.3'],
    '@nestjs/testing': ['root', '12.0.3'],
    '@playwright/test': ['root', '~1.63.0'],
    testcontainers: ['root', '~12.1.0'],
    tsx: ['root', '~4.23.13'],
    vitest: ['root', '~5.0.1'],
    '@changesets/cli': ['root', '~3.0.3'],
    husky: ['root', '~9.1.7'],
    'lint-staged': ['root', '~17.5.1'],
    '@commitlint/cli': ['root', '~21.2.2'],
    '@commitlint/config-conventional': ['root', '~21.2.2'],
    '@nestjs/common': ['api', '12.0.3'],
    '@nestjs/core': ['api', '12.0.3'],
    '@nestjs/platform-fastify': ['api', '12.0.3'],
    '@nestjs/config': ['api', '12.0.0'],
    '@nestjs/swagger': ['api', '12.0.1'],
    '@nestjs/terminus': ['api', '12.0.0'],
    '@nestjs/throttler': ['api', '~6.7.0'],
    '@fastify/helmet': ['api', '~13.1.1'],
    fastify: ['api', '~5.12.5'],
    '@asteasolutions/zod-to-openapi': ['api', '~9.1.0'],
    '@scalar/nestjs-api-reference': ['api', '~1.2.19'],
    pino: ['api', '~10.3.1'],
    'nestjs-pino': ['api', '~5.2.0'],
    'pino-http': ['api', '~11.0.0'],
    undici: ['api', '~8.10.2'],
    dayjs: ['api', '~1.11.23'],
    'intl-messageformat': ['api', '~12.1.1'],
    zod: ['domain', '~4.6.5'],
    '@node-rs/argon2': ['api', '~2.2.1'],
    otpauth: ['api', '~9.5.2'],
    sharp: ['api', '~0.35.4'],
    grammy: ['bot', '~1.46.0'],
    '@grammyjs/conversations': ['bot', '~2.1.1'],
    '@grammyjs/menu': ['bot', '~1.5.0'],
    '@grammyjs/runner': ['bot', '~2.0.3'],
    '@grammyjs/auto-retry': ['bot', '~2.0.2'],
    '@grammyjs/ratelimiter': ['bot', '~1.2.1'],
    '@grammyjs/storage-redis': ['bot', '~2.6.0'],
    ioredis: ['bot', '~5.11.1'],
    '@nestjs/bullmq': ['worker', '12.0.0'],
    '@nestjs/schedule': ['worker', '12.0.2'],
    bullmq: ['worker', '~6.3.7'],
    prisma: ['db', '7.10.0'],
    '@prisma/client': ['db', '7.10.0'],
    '@prisma/adapter-pg': ['db', '7.10.0'],
    '@testcontainers/postgresql': ['testFixtures', '~12.1.0'],
    next: ['web', '~16.3.5'],
    'next-intl': ['web', '~4.14.5'],
    react: ['web', '~19.3.0'],
    'react-dom': ['web', '~19.3.0'],
    tailwindcss: ['web', '~4.3.3'],
    '@radix-ui/react-dialog': ['web', '~1.1.23'],
    'class-variance-authority': ['web', '~0.7.1'],
    'tailwind-merge': ['web', '~3.7.0'],
    'lucide-react': ['web', '~1.47.0'],
  };
  for (const [name, [manifest, version]] of Object.entries(expected)) {
    assert.equal(
      dependencyVersion(packageManifests[manifest], name),
      version,
      `${manifest}: ${name}`,
    );
  }
});

test('pnpm policy and Renovate exceptions are explicit', async () => {
  const npmrc = await readFile('.npmrc', 'utf8');
  const renovate = JSON.parse(await readFile('renovate.json', 'utf8'));
  assert.match(npmrc, /^engine-strict=true$/m);
  assert.match(npmrc, /^save-exact=false$/m);
  assert.match(npmrc, /^save-prefix=~$/m);
  assert.equal(packageManifest.packageManager, 'pnpm@11.26.0');
  assert.deepEqual(renovate.ignoreDeps, [
    'pnpm',
    'prisma',
    '@prisma/client',
    '@prisma/adapter-pg',
    'grammy',
    'ioredis',
  ]);
  assert.equal(renovate.minimumReleaseAge, '7 days');
  assert.equal(renovate.vulnerabilityAlerts.minimumReleaseAge, null);
});

test('the Caddy proxy image pins the verified release and rate-limit module', async () => {
  const dockerfile = await readFile('deploy/proxy/caddy/Dockerfile', 'utf8');
  assert.match(dockerfile, /^ARG CADDY_VERSION=2\.11\.4$/m);
  assert.match(dockerfile, /FROM caddy:\$\{CADDY_VERSION\}-builder-alpine AS builder/);
  // A version, never the module's default branch of the day.
  assert.match(dockerfile, /^ARG CADDY_RATELIMIT_VERSION=[0-9a-f]{40}$/mu);
  assert.match(
    dockerfile,
    /xcaddy build --with "github\.com\/mholt\/caddy-ratelimit@\$\{CADDY_RATELIMIT_VERSION\}"/u,
  );
  assert.doesNotMatch(dockerfile, /caddy-ratelimit\s*$/mu);
  assert.match(dockerfile, /http\.handlers\.rate_limit/);
});

test('the Remnawave contract verification is recorded', async () => {
  const adr = await readFile('docs/adr/ADR-010.md', 'utf8');
  assert.match(adr, /Remnawave API v3\.4\.4/);
  assert.match(adr, /bebc345543b82c66ee1f956333e65cddfb8aec46099bf4427de38fb43df69396/);
  for (const method of [
    'system.stats',
    'users.create',
    'users.update',
    'users.getByTelegramId',
    'squads.list',
    'hwid.remove',
  ]) {
    const row = adr.split('\n').find((line) => line.includes(`\`${method}\``));
    assert.ok(row?.includes('✓') || row?.includes('✗'), method);
  }
});

test('the four process shells expose their required health entrypoints', async () => {
  const api = await readFile('apps/api/src/health/health.controller.ts', 'utf8');
  const bot = await readFile('apps/bot/src/main.ts', 'utf8');
  const worker = await readFile('apps/worker/src/health/health.controller.ts', 'utf8');
  const web = await readFile('apps/web/app/api/healthz/route.ts', 'utf8');

  assert.match(api, /@Controller\('api\/v1\/health'\)/);
  assert.match(api, /@Get\('ready'\)/);
  assert.match(bot, /createServer/);
  assert.match(bot, /service: 'bot'/);
  assert.match(worker, /@Controller\('health'\)/);
  assert.match(worker, /service: 'worker'/);
  assert.match(web, /dynamic = 'force-dynamic'/);
  assert.match(web, /service: 'web'/);
});

test('the local deployment boundary includes Docker, Compose, and safe init scripts', async () => {
  const appDockerfile = await readFile('deploy/docker/app.Dockerfile', 'utf8');
  const webDockerfile = await readFile('deploy/docker/web.Dockerfile', 'utf8');
  const compose = await readFile('compose.yaml', 'utf8');
  const composeDev = await readFile('compose.dev.yaml', 'utf8');
  const initEnv = await readFile('scripts/init-env.sh', 'utf8');
  const wrapper = await readFile('scripts/rr', 'utf8');
  const mockServer = await readFile('scripts/dev-mock-server.mjs', 'utf8');

  assert.match(appDockerfile, /FROM node:24-alpine AS build/);
  assert.match(appDockerfile, /pnpm install --frozen-lockfile/);
  assert.match(appDockerfile, /pnpm deploy --filter=@remnaray\/runtime --prod \/out\/runtime/);
  assert.match(appDockerfile, /node_modules\/@remnaray\/api\/dist/);
  assert.match(appDockerfile, /node_modules\/@remnaray\/db/);
  assert.match(webDockerfile, /\.next\/standalone/);
  assert.match(compose, /172\.28\.0\.0\/16/);
  assert.match(compose, /read_only: true/);
  assert.match(compose, /no-new-privileges:true/);
  for (const service of ['remnawave-mock', 'payments-mock', 'telegram-mock']) {
    assert.match(composeDev, new RegExp(`^  ${service}:`, 'm'));
  }
  assert.match(initEnv, /umask 077/);
  assert.match(initEnv, /chmod 600/);
  assert.match(wrapper, /docker compose/);
  assert.match(mockServer, /request.url === '\/health'/);
});

// `compose.yaml` carries no build contexts, so a checkout with no published
// release has nothing to pull and every service stops at `denied`.
test('a source checkout can build the images compose resolves to', async () => {
  const wrapper = await readFile('scripts/rr', 'utf8');
  const makefile = await readFile('Makefile', 'utf8');
  const compose = await readFile('compose.yaml', 'utf8');
  const install = await readFile('docs/install.md', 'utf8');

  assert.match(wrapper, /^ {2}build\)$/mu);
  assert.match(makefile, /^build:/mu);
  // The tag the wrapper builds has to be the one compose looks for, or the
  // build succeeds and the start still pulls.
  for (const image of ['app', 'web', 'nginx', 'caddy', 'backup']) {
    const variable = `RR_${image.toUpperCase()}_IMAGE`;
    const reference =
      `\${${variable}:-` + `\${RR_REGISTRY:-ghcr.io/remnaray}/${image}:\${RR_VERSION:-1}}`;
    assert.ok(compose.includes(reference), `compose.yaml does not resolve ${image} that way`);
    assert.ok(wrapper.includes(reference), `scripts/rr does not tag ${image} that way`);
    assert.match(wrapper, new RegExp(`${image}\\) printf '%s' deploy/`, 'u'));
  }
  assert.match(install, /## Running from a source checkout/u);
});

// `tsc -p tsconfig.build.json` compiles whatever the config includes, and a
// test file that ships in `dist` is both dead weight in the app image and a
// build that fails on code no deployment runs.
test('no package compiles its tests into dist', async () => {
  const configs = await Array.fromAsync(glob('packages/*/tsconfig.build.json'));
  assert.ok(configs.length > 10, 'found almost no build configs');

  for (const path of configs) {
    const config = JSON.parse(await readFile(path, 'utf8'));
    assert.ok(
      config.exclude?.some((pattern) => pattern.endsWith('*.test.ts')),
      `${path} does not exclude its tests from the build`,
    );
  }
});

// A clone has to be able to run what the documentation tells it to run, and
// the `backup` image's crontab executes its entrypoint by path.
test('the scripts the documentation invokes are executable', () => {
  const scripts = [
    'scripts/rr',
    'scripts/init-env.sh',
    'scripts/ci-local.sh',
    'deploy/ci/proxy-smoke.sh',
    'deploy/ci/gen-selfsigned.sh',
    'deploy/backup/backup-entrypoint.sh',
    'deploy/backup/restore.sh',
    'scripts/floating-tags.sh',
  ];
  // The index, not the working tree: `core.fileMode=false` — which every
  // checkout on a Windows filesystem sets — hides a missing bit locally and
  // hands the clone a file it cannot run.
  const listing = execFileSync('git', ['ls-files', '-s', '--', ...scripts], {
    encoding: 'utf8',
  });

  for (const script of scripts) {
    assert.match(listing, new RegExp(`^100755 [0-9a-f]+ 0\\t${script}$`, 'mu'));
  }
});

// The image's entrypoint is the backup script, and the restore drives compose
// from the host: both wrappers used to name a script the callee then read as
// its subcommand, and neither ran.
test('the backup wrappers call what they mean to call', async () => {
  const wrapper = await readFile('scripts/rr', 'utf8');
  const entrypoint = await readFile('deploy/backup/Dockerfile', 'utf8');
  const restore = await readFile('deploy/backup/restore.sh', 'utf8');

  assert.match(entrypoint, /ENTRYPOINT \["\/bin\/sh", "\/scripts\/backup-entrypoint\.sh"\]/u);
  assert.match(wrapper, /run --rm backup once$/mu);
  assert.doesNotMatch(wrapper, /run --rm backup \/scripts\//u);
  // The restore stops the stack and starts it again, which nothing inside the
  // stack can do.
  assert.match(restore, /docker compose .* down/u);
  assert.match(wrapper, /deploy\/backup\/restore\.sh "\$1"/u);
});

// Type-aware linting reads generated types, and a fresh checkout has none:
// without the client every Prisma call lints as `any`, and without the route
// types `next/root-params` does too. Both are gitignored, so only an install
// can put them there — and CI lints before it builds.
test('installing generates the types the linter reads', async () => {
  const db = JSON.parse(await readFile('packages/db/package.json', 'utf8'));
  const web = JSON.parse(await readFile('apps/web/package.json', 'utf8'));
  const postinstall = packageManifest.scripts.postinstall ?? '';

  assert.match(postinstall, /pnpm --filter @remnaray\/db db:generate/u);
  assert.match(postinstall, /pnpm --filter @remnaray\/web typegen/u);
  assert.equal(db.scripts['db:generate'], 'prisma generate');
  assert.equal(web.scripts.typegen, 'next typegen');
  assert.match(db.exports['./generated'].types, /src\/generated\/prisma/u);
});

// Section 24.4 and 24.6: what the tag publishes must be what `compose.yaml`
// pulls, down to the last path segment.
test('the release and rebuild workflows publish the images compose pulls', async () => {
  const release = await readFile('.github/workflows/release.yml', 'utf8');
  const rebuild = await readFile('.github/workflows/rebuild.yml', 'utf8');
  const compose = await readFile('compose.yaml', 'utf8');

  for (const workflow of [release, rebuild]) {
    for (const image of ['app', 'web', 'nginx', 'caddy', 'backup']) {
      assert.match(workflow, new RegExp(`^ {10}- image: ${image}$`, 'mu'));
    }
    // A `remnaray-` prefix, or any other segment, is a name nothing pulls.
    assert.match(workflow, /\/\$\{\{ steps\.ns\.outputs\.owner \}\}\/\$\{\{ matrix\.image \}\}/u);
    assert.doesNotMatch(workflow, /outputs\.owner \}\}\/[a-z-]+\$\{\{ matrix\.image/u);
    // GHCR refuses an uppercase namespace, and an account's own spelling is
    // whatever the account chose.
    assert.match(workflow, /tr '\[:upper:\]' '\[:lower:\]'/u);
  }
  for (const image of ['app', 'web', 'nginx', 'caddy', 'backup']) {
    assert.ok(compose.includes(`ghcr.io/remnaray}/${image}:`), `compose.yaml never pulls ${image}`);
  }
});

// A package's tests import its dependencies through their `exports`, which
// point at `dist`. `pnpm -r test` builds nothing, so on a checkout that has
// never been built `@remnaray/queues` could not resolve `@remnaray/db` — and
// CI starts from exactly such a checkout.
test('workspace tests build what they import', async () => {
  const turbo = JSON.parse(await readFile('turbo.json', 'utf8'));
  const workflow = await readFile('.github/workflows/ci.yml', 'utf8');
  const contributing = await readFile('CONTRIBUTING.md', 'utf8');

  assert.deepEqual(turbo.tasks.test.dependsOn, ['^build']);
  assert.match(workflow, /run: pnpm turbo run test/u);
  assert.doesNotMatch(workflow, /run: pnpm -r test/u);
  assert.doesNotMatch(contributing, /pnpm -r test/u);
});

test('the CI workflow covers required quality and image gates', async () => {
  const workflow = await readFile('.github/workflows/ci.yml', 'utf8');
  assert.match(workflow, /pnpm install --frozen-lockfile/);
  assert.match(workflow, /pnpm lint/);
  assert.match(workflow, /pnpm format/);
  assert.match(workflow, /pnpm typecheck/);
  assert.match(workflow, /pnpm -r typecheck/);
  assert.match(workflow, /pnpm turbo run test/);
  assert.match(workflow, /pnpm i18n-check/);
  assert.match(workflow, /pnpm theme-validate themes\/manta/);
  assert.match(workflow, /pnpm build/);
  assert.match(workflow, /playwright install --with-deps chromium/);
  assert.match(workflow, /pnpm test:e2e/);
  assert.match(workflow, /node: \['24\.21\.0', '26\.x'\]/);
  assert.match(workflow, /deploy\/docker\/app\.Dockerfile/);
  assert.match(workflow, /deploy\/docker\/web\.Dockerfile/);
  assert.match(workflow, /push: false/);
});

test('CI runs on dev pushes and gathers the blocking jobs into one required check', async () => {
  const workflow = await readFile('.github/workflows/ci.yml', 'utf8');
  // The owner pushes to dev directly; without this nothing checks those pushes.
  assert.match(workflow, /^ {2}push:\n {4}branches: \[main, dev\]$/mu);

  // The `main` ruleset requires only `ci-ok`, whose name never changes with the
  // Node version in the quality matrix.
  const job = workflow.slice(workflow.indexOf('\n  ci-ok:'));
  assert.ok(job.startsWith('\n  ci-ok:'), 'ci.yml has no ci-ok job');
  assert.match(job, /^ {4}name: ci-ok$/mu);
  assert.match(job, /^ {4}if: \$\{\{ always\(\) \}\}$/mu);
  const needs = job.match(/^ {4}needs: \[(?<list>[^\]]+)\]$/mu)?.groups.list.split(/,\s*/u);
  assert.deepEqual(needs?.toSorted(), ['docker', 'e2e', 'proxy', 'proxy-smoke', 'quality']);
  // A skipped or cancelled job must not count as passed.
  assert.match(job, /needs\.\*\.result/u);
  for (const result of ['failure', 'cancelled', 'skipped'])
    assert.match(job, new RegExp(`contains\\(needs\\.\\*\\.result, '${result}'\\)`, 'u'));
});

const tsx = resolve('node_modules/.bin/tsx');
const i18nCheck = resolve('tools/i18n-check.ts');

/** Runs the locale check against the `locales` directory of `cwd`. */
function runI18nCheck(cwd) {
  try {
    return {
      ok: true,
      output: execFileSync(tsx, [i18nCheck], { cwd, encoding: 'utf8', stdio: 'pipe' }),
    };
  } catch (error) {
    return { ok: false, output: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
}

test('the locale check passes on the committed catalogs (CI quality gate)', () => {
  const { ok, output } = runI18nCheck(process.cwd());
  assert.ok(ok, output);
});

test('the locale check still flags English copy in ru, key by key', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rr-i18n-'));
  try {
    await cp('locales', join(dir, 'locales'), { recursive: true });
    const file = join(dir, 'locales/ru/admin.json');
    const catalog = JSON.parse(await readFile(file, 'utf8'));
    // A brand only passes under its own key, not because its neighbours are brands.
    catalog['admin.providers.name.yookassa'] = 'YooKassa';
    catalog['admin.title'] = 'Admin console';
    await writeFile(file, `${JSON.stringify(catalog, null, 2)}\n`);

    const { ok, output } = runI18nCheck(dir);
    assert.equal(ok, false);
    assert.match(output, /admin\.providers\.name\.yookassa still reads as English copy/u);
    assert.match(output, /admin\.title still reads as English copy/u);
    assert.match(output, /failed with 2 problem\(s\)/u);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the API OpenAPI document is generated from shared Zod contracts', async () => {
  const manifest = JSON.parse(await readFile('apps/api/package.json', 'utf8'));
  const document = JSON.parse(await readFile('apps/api/openapi.json', 'utf8'));
  const generator = await readFile('apps/api/src/openapi/generator.ts', 'utf8');

  assert.match(manifest.scripts.build, /dist\/openapi\/generator\.js/);
  assert.equal(document.openapi, '3.1.0');
  assert.ok(document.components?.schemas?.Money);
  assert.ok(document.components?.schemas?.ErrorEnvelope);
  assert.ok(Object.keys(document.paths).length >= 100);
  assert.match(generator, /OpenApiGeneratorV31/);
  assert.match(generator, /@remnaray\/domain/);
});

test('every workflow scans with the one Trivy action tag that exists', async () => {
  // `aquasecurity/trivy-action` tags are `v`-prefixed; `@0.28.0` does not
  // exist, so a workflow that used it failed at the scan and published
  // nothing. The nightly was corrected to v0.36.0; the rebuild kept 0.28.0.
  const workflows = ['.github/workflows/nightly.yml', '.github/workflows/rebuild.yml'];
  const tags = new Set();
  for (const path of workflows)
    for (const match of (await readFile(path, 'utf8')).matchAll(
      /aquasecurity\/trivy-action@(\S+)/gu,
    ))
      tags.add(match[1]);
  assert.deepEqual([...tags], ['v0.36.0']);
});

test('the worker reads the backup status the backup service writes (section 20.3)', async () => {
  const compose = await readFile('compose.yaml', 'utf8');
  const worker = /\n {2}worker:\n([\s\S]*?)\n {2}\w[\w-]*:\n/u.exec(compose)?.[1] ?? '';
  const backup =
    /\n {2}backup:\n([\s\S]*?)(?:\n {2}\w[\w-]*:\n|\nvolumes:)/u.exec(compose)?.[1] ?? '';
  // `maintenance.backup-check` reads `RR_BACKUP_DIR` (default /backups).
  assert.match(backup, /- \.\/backups:\/backups\n/u);
  assert.match(worker, /- \.\/backups:\/backups:ro\n/u, 'the worker never sees .last-status');
  // `maintenance.disk-check` statfs's the database volume (section 20.3).
  assert.match(worker, /- pgdata:\/pgdata:ro\n/u, 'the worker cannot see the database volume');
  // Its own list replaces the common one, so the common mounts must be there.
  for (const mount of ['./themes:/themes:ro', './locales:/locales:ro', 'uploads:/uploads'])
    assert.ok(worker.includes(`- ${mount}\n`), `the worker lost ${mount}`);
});

// Section 24.4: `X.Y` and `X` are what `RR_VERSION=1.2` and `1` resolve to,
// the newest release of their line. A patch to the previous minor (24.5) or a
// manual rebuild of an older version used to move them back onto it.
test('the floating tags move only for the newest final release of their line', async () => {
  const repository = await mkdtemp(join(tmpdir(), 'rr-tags-'));
  const git = (...args) =>
    execFileSync('git', ['-c', 'user.email=ci@example.test', '-c', 'user.name=ci', ...args], {
      cwd: repository,
      encoding: 'utf8',
    });
  const floating = (version) =>
    execFileSync('sh', [resolve('scripts/floating-tags.sh'), version], {
      cwd: repository,
      encoding: 'utf8',
    });
  try {
    git('init', '-q');
    git('commit', '-q', '--allow-empty', '-m', 'release');
    for (const tag of ['v1.1.5', 'v1.2.3', 'v1.2.10', 'v1.3.0-rc.1', 'v2.0.0']) git('tag', tag);

    // The newest of both lines, compared as versions rather than as text.
    assert.equal(floating('1.2.10'), 'minor=true\nmajor=true\n');
    // A rebuild of an older patch of the current minor moves neither.
    assert.equal(floating('1.2.3'), 'minor=false\nmajor=false\n');
    // A security patch to the previous minor takes `1.1`, not `1`.
    assert.equal(floating('1.1.6'), 'minor=true\nmajor=false\n');
    // A candidate moves neither, even as the highest version.
    assert.equal(floating('1.3.0-rc.1'), 'minor=false\nmajor=false\n');
    assert.equal(floating('1.10.0'), 'minor=true\nmajor=true\n');
    assert.equal(floating('2.0.1'), 'minor=true\nmajor=true\n');
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

test('the release and rebuild workflows move the floating tags by that rule', async () => {
  const release = await readFile('.github/workflows/release.yml', 'utf8');
  const rebuild = await readFile('.github/workflows/rebuild.yml', 'utf8');

  for (const workflow of [release, rebuild]) {
    assert.match(
      workflow,
      /run: scripts\/floating-tags\.sh '\$\{\{ steps\.\w+\.outputs\.\w+ \}\}' >> "\$GITHUB_OUTPUT"/u,
    );
    // The script reads the release tags, which only a full fetch brings.
    assert.match(workflow, /uses: actions\/checkout@v7\n {8}with:\n {10}fetch-depth: 0\n/u);
  }
  assert.match(
    release,
    /pattern=\{\{major\}\}\.\{\{minor\}\},enable=\$\{\{ steps\.floating\.outputs\.minor == 'true' \}\}/u,
  );
  assert.match(
    release,
    /pattern=\{\{major\}\},enable=\$\{\{ steps\.floating\.outputs\.major == 'true' \}\}/u,
  );
  // The rebuild decides on the default branch, before it checks out the old
  // release, whose tree may not carry the script.
  assert.ok(rebuild.indexOf('Decide the floating tags') < rebuild.indexOf('Checkout that release'));
  assert.match(
    rebuild,
    /if \[ "\$MOVE_MINOR" = true \]; then tags="\$tags \$\{VERSION%\.\*\}"; fi/u,
  );
  assert.match(
    rebuild,
    /if \[ "\$MOVE_MAJOR" = true \]; then tags="\$tags \$\{VERSION%%\.\*\}"; fi/u,
  );
  assert.doesNotMatch(rebuild, /for tag in "\$dated" "\$minor" "\$major"/u);
});

// Section 24.4 p. 1 and 5: a release is `vX.Y.Z`, a candidate `vX.Y.Z-rc.N`.
// `v*` also started the workflow on `v1.2` (no image tag, a failed run),
// `v1.2.3-beta.1` (published under `rc`) and `v1.2.3+build` (a final
// GitHub Release that the weekly rebuild then took as the latest and could
// not tag), with the tag handed to a shell unchecked.
test('the release workflow starts only on the two release tag forms', async () => {
  const release = await readFile('.github/workflows/release.yml', 'utf8');
  const filters = /on:\n {2}push:\n {4}tags:\n((?: {6}- .*\n)+)/u
    .exec(release)?.[1]
    .split('\n')
    .filter(Boolean)
    .map((line) => line.replace(/^ {6}- '(.*)'$/u, '$1'));
  assert.deepEqual(filters, ['v[0-9]+.[0-9]+.[0-9]+', 'v[0-9]+.[0-9]+.[0-9]+-rc.[0-9]+']);
  // GitHub's filter syntax as its cheat sheet gives it: `[]` a range, `+` one
  // or more of the preceding character, anything else itself.
  const glob = (pattern) => new RegExp(`^${pattern.replace(/\./gu, '\\.')}$`, 'u');
  const starts = (tag) => filters.some((filter) => glob(filter).test(tag));

  // The step that reads the tag, run as the workflow runs it.
  const step = /- name: Read the tag\n {8}id: version\n {8}run: \|\n((?: {10}.*\n)+)/u
    .exec(release)?.[1]
    .replace(/^ {10}/gmu, '');
  assert.ok(step);
  const directory = await mkdtemp(join(tmpdir(), 'rr-release-tag-'));
  const read = (tag) => {
    const output = join(directory, `${String(Math.random()).slice(2)}.out`);
    try {
      execFileSync('sh', ['-c', step], {
        env: { PATH: process.env.PATH, GITHUB_REF_NAME: tag, GITHUB_OUTPUT: output },
        stdio: ['ignore', 'ignore', 'ignore'],
      });
    } catch {
      return 'refused';
    }
    return readFileSync(output, 'utf8');
  };
  try {
    for (const [tag, outputs] of [
      ['v1.2.3', 'version=1.2.3\nprerelease=false\n'],
      ['v10.0.12', 'version=10.0.12\nprerelease=false\n'],
      ['v0.9.0-rc.1', 'version=0.9.0-rc.1\nprerelease=true\n'],
    ]) {
      assert.ok(starts(tag), tag);
      assert.equal(read(tag), outputs, tag);
    }
    for (const tag of ['v1.2', 'vfoo', 'v1.2.3-beta.1', 'v1.2.3+build', 'v1.2.3.4', 'v1.2.3-rc']) {
      assert.ok(!starts(tag), tag);
      assert.equal(read(tag), 'refused', tag);
    }
    // The glob admits leading zeros; the step does not.
    assert.ok(starts('v01.2.3'));
    assert.equal(read('v01.2.3'), 'refused');
    assert.equal(read("v1.2.3';id;'"), 'refused');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// A step's `run` block, run as the workflow runs it with `env`; true when it exits 0.
function runStep(workflow, name, env) {
  const script = new RegExp(
    `- name: ${name}\\n((?: {8}(?!run:).*\\n)*) {8}run: \\|\\n((?: {10}.*\\n|\\n)+)`,
    'u',
  )
    .exec(workflow)?.[2]
    .replace(/^ {10}/gmu, '');
  assert.ok(script, name);
  try {
    execFileSync('sh', ['-c', script], {
      env: { PATH: process.env.PATH, ...env },
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

// `images.yml` publishes an unsigned, unscanned build under a hand-typed tag,
// which `tags:` reads as a comma-separated list. `1` or `1.2.3` replaced what
// every `RR_VERSION=1` deployment pulls. `rebuild.yml` put a hand-typed
// version into a checkout ref, a shell and image tags unchecked.
test('the manual image workflows refuse release tags and malformed input', async () => {
  const images = await readFile('.github/workflows/images.yml', 'utf8');
  const rebuild = await readFile('.github/workflows/rebuild.yml', 'utf8');

  // The check runs first, and the shell sees the input only through `env`.
  assert.match(images, /steps:\n {6}(?:#.*\n {6})*- name: Check the tag\n/u);
  assert.doesNotMatch(images, /'\$\{\{ inputs\.tag \}\}'/u);
  assert.ok(rebuild.indexOf('Check the version') < rebuild.indexOf('Checkout the default branch'));

  const tag = (value) => runStep(images, 'Check the tag', { TAG: value });
  for (const value of ['dev', 'main', '1cb8686', 'feature_x.2', 'a'.repeat(128)])
    assert.ok(tag(value), value);
  for (const value of [
    '1',
    '1.2',
    '1.2.3',
    '1.2.3-rc.1',
    '1.2.3-20260925',
    'rc',
    'dev,ghcr.io/remnaray/app:1',
    '-dev',
    '.dev',
    'a'.repeat(129),
    "dev';id;'",
    '',
  ])
    assert.ok(!tag(value), value);

  const version = (value) => runStep(rebuild, 'Check the version', { VERSION: value });
  for (const value of ['1.2.3', '0.9.0-rc.1']) assert.ok(version(value), value);
  for (const value of ['1.2', '01.2.3', '1.2.3-beta', '1.2.3+build', "1.2.3';id;'", ''])
    assert.ok(!version(value), value);
});

// Section 20.3 and the 7.1 compose: failures while the API boots (Prisma,
// Nest, the first Valkey connection) do not count toward its retries for
// 30 s, nor the web's for 20 s; without it a slow first start marks the API
// unhealthy and `up` refuses the bot, the worker and the web behind it.
test('the api and web healthchecks give the process time to start', async () => {
  const compose = await readFile('compose.yaml', 'utf8');
  const block = (service) =>
    new RegExp(`\\n {2}${service}:\\n([\\s\\S]*?)\\n {2}\\w[\\w-]*:\\n`, 'u').exec(compose)?.[1] ??
    '';
  const healthcheck = (service) =>
    /\n {4}healthcheck:\n((?: {6}.*\n)+)/u.exec(`${block(service)}\n`)?.[1] ?? '';

  assert.match(healthcheck('api'), /^ {6}interval: 10s$/mu);
  assert.match(healthcheck('api'), /^ {6}start_period: 30s$/mu);
  assert.match(healthcheck('web'), /^ {6}interval: 10s$/mu);
  assert.match(healthcheck('web'), /^ {6}start_period: 20s$/mu);
});

// Section 24.6: `/admin/system` shows the running version and whether a newer
// release is out. The runtime image carries no package.json, so without the
// tag baked in every deployment read 0.0.0.
test('the app image knows its release, and releases mark security fixes', async () => {
  const dockerfile = await readFile('deploy/docker/app.Dockerfile', 'utf8');
  const release = await readFile('.github/workflows/release.yml', 'utf8');
  const rebuild = await readFile('.github/workflows/rebuild.yml', 'utf8');
  const notes = await readFile('.github/release.yml', 'utf8');
  const runtime = dockerfile.slice(dockerfile.lastIndexOf('\nFROM '));

  assert.match(runtime, /^ARG RR_APP_VERSION=0\.0\.0-dev$/mu);
  assert.match(runtime, /^ENV RR_APP_VERSION=\$\{RR_APP_VERSION\}$/mu);
  assert.match(release, /build-args: RR_APP_VERSION=\$\{\{ steps\.version\.outputs\.version \}\}/u);
  assert.match(rebuild, /build-args: RR_APP_VERSION=\$\{\{ steps\.release\.outputs\.result \}\}/u);
  // The generated notes put `security`-labelled pull requests under their
  // own heading, which the update check reads as the badge.
  assert.match(release, /generate_release_notes: true/u);
  assert.match(notes, /- title: Security\n\s+labels:\n\s+- security\n/u);
});

// Section 24.4 p. 3 and 26: the published images are signed with cosign. A
// provenance attestation alone is not that signature, whatever a comment says.
test('the release and rebuild workflows sign every image with cosign', async () => {
  const release = await readFile('.github/workflows/release.yml', 'utf8');
  const rebuild = await readFile('.github/workflows/rebuild.yml', 'utf8');

  for (const [name, workflow] of [
    ['release', release],
    ['rebuild', rebuild],
  ]) {
    // Keyless signing takes the workflow's OIDC token.
    assert.match(workflow, /^ {2}id-token: write$/mu);
    // v4 of the installer is what installs cosign 3; the tag exists.
    assert.match(workflow, /uses: sigstore\/cosign-installer@v4\.1\.2\n/u);
    // By digest, never by tag.
    assert.match(workflow, /cosign sign --yes "\$\{IMAGE\}@\$\{DIGEST\}"/u);
    assert.match(workflow, /DIGEST: \$\{\{ steps\.push\.outputs\.digest \}\}/u);
    assert.match(
      workflow,
      new RegExp(`certificate-identity-regexp '.*/\\\\.github/workflows/${name}\\\\.yml@'`, 'u'),
    );
    assert.match(
      workflow,
      /--certificate-oidc-issuer https:\/\/token\.actions\.githubusercontent\.com/u,
    );
  }
  // A rebuild signs only after the scan, and publishes no tag the signature
  // does not cover.
  assert.ok(
    rebuild.indexOf('Sign the image with cosign') > rebuild.indexOf('Scan the rebuilt image'),
  );
  assert.ok(
    rebuild.indexOf('Sign the image with cosign') <
      rebuild.indexOf('Publish the dated and floating tags'),
  );
  assert.match(rebuild, /if \[ "\$published" != "\$DIGEST" \]; then/u);
  assert.doesNotMatch(release, /Signs the image with the workflow's own identity/u);
});

// Section 22.x `nightly.yml`: trivy over every image a deployment runs. The
// release and rebuild publish five, and `backup` runs in every profile.
test('the nightly scan covers every published image', async () => {
  const nightly = await readFile('.github/workflows/nightly.yml', 'utf8');
  const trivy = /\n {2}trivy:\n([\s\S]*?)\n {2}\w[\w-]*:\n/u.exec(nightly)?.[1] ?? '';
  for (const image of ['app', 'web', 'nginx', 'caddy', 'backup'])
    assert.match(trivy, new RegExp(`^ {10}- image: ${image}$`, 'mu'), `${image} is never scanned`);
  assert.match(trivy, /^ {12}file: deploy\/backup\/Dockerfile$/mu);
});

// R13 (owner decision О-1): the compose network is IPv4 only, so Docker's
// userland proxy forwards a port published on the host's IPv6 addresses from
// the network's gateway, 172.28.0.1 — an address the proxy trusts for
// X-Forwarded-For. Publishing on 0.0.0.0 keeps the proxy ports off IPv6
// (Docker: "To restrict a published port to IPv4 only, the address must be
// included in the container's publishing options"), and the installation
// guide asks for an A record only.
test('the proxies publish their ports on IPv4 only', async () => {
  const compose = await readFile('compose.yaml', 'utf8');
  for (const service of ['proxy-nginx', 'proxy-caddy']) {
    const block = new RegExp(
      `^  ${service}:\\n(?:(?:    .*|)\\n)*?    ports: \\[([^\\]]*)\\]`,
      'mu',
    ).exec(compose);
    assert.ok(block, `${service} publishes no ports`);
    const ports = block[1].split(',').map((port) => port.trim().replace(/^'|'$/gu, ''));
    assert.deepEqual(ports, ['0.0.0.0:80:80', '0.0.0.0:443:443', '0.0.0.0:443:443/udp'], service);
  }
  const install = await readFile('docs/install.md', 'utf8');
  assert.doesNotMatch(install, /plus `AAAA`/u);
  assert.match(install, /no `AAAA`/u);
});
