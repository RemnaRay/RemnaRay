import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join, normalize, resolve } from 'node:path';
import test from 'node:test';

/** Every Markdown file the delivery ships, excluding the specification. */
async function markdownFiles(directory = '.', found = []) {
  const skip = new Set(['node_modules', '.git', '.turbo', 'dist', '.next', 'task', 'test-results']);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.github') continue;
    if (skip.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await markdownFiles(path, found);
    else if (entry.name.endsWith('.md')) found.push(path);
  }
  return found;
}

const files = await markdownFiles();

/** `[text](target)`, keeping only the relative ones. */
function relativeLinks(markdown) {
  const links = [];
  for (const match of markdown.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/gu)) {
    const target = match[1];
    if (/^(https?:|mailto:|#)/u.test(target)) continue;
    links.push(target.split('#')[0]);
  }
  return links.filter((target) => target !== '');
}

test('the delivery ships the section 24.2 community files', async () => {
  for (const file of [
    'README.md',
    'README.ru.md',
    'LICENSE',
    'CONTRIBUTING.md',
    'CODE_OF_CONDUCT.md',
    'SECURITY.md',
    'CHANGELOG.md',
    'Makefile',
    '.github/PULL_REQUEST_TEMPLATE.md',
    '.github/CODEOWNERS',
    '.github/ISSUE_TEMPLATE/bug.yml',
    '.github/ISSUE_TEMPLATE/feature.yml',
    '.github/ISSUE_TEMPLATE/payment-provider.yml',
  ])
    assert.ok((await stat(file)).isFile(), `${file} is missing`);
});

test('the delivery ships a page for every section 24.3 topic', async () => {
  for (const page of [
    'install',
    'upgrade',
    'proxy',
    'external-proxy',
    'theming',
    'i18n',
    'admin',
    'api',
    'troubleshooting',
    'faq',
    'monitoring',
    'backup',
  ])
    assert.ok((await stat(`docs/${page}.md`)).isFile(), `docs/${page}.md is missing`);
});

test('every relative link in the documentation resolves', async () => {
  const broken = [];
  for (const file of files) {
    const markdown = await readFile(file, 'utf8');
    for (const target of relativeLinks(markdown)) {
      const path = normalize(resolve(dirname(file), target));
      try {
        await stat(path);
      } catch {
        broken.push(`${file} → ${target}`);
      }
    }
  }
  // The acceptance of TASK-M5-009: the links in the README resolve.
  assert.deepEqual(broken, []);
});

test('both READMEs cover the section 24.1 sections and point at each other', async () => {
  const english = await readFile('README.md', 'utf8');
  const russian = await readFile('README.ru.md', 'utf8');

  assert.ok(english.includes('](README.ru.md)'), 'README.md does not link the Russian version');
  assert.ok(russian.includes('](README.md)'), 'README.ru.md does not link the English version');

  for (const [name, markdown, headings] of [
    [
      'README.md',
      english,
      [
        'What this is',
        'Quick start',
        'Requirements',
        'Proxy profiles',
        'Payment providers',
        'Customisation without a fork',
        'Upgrading',
        'Compared with remnawave-tg-shop',
        'Architecture',
        'Contributing',
        'License',
      ],
    ],
    [
      'README.ru.md',
      russian,
      [
        'Что это',
        'Быстрый старт',
        'Требования',
        'Профили прокси',
        'Платёжные провайдеры',
        'Кастомизация без форка',
        'Обновление',
        'Сравнение с remnawave-tg-shop',
        'Архитектура',
        'Вклад',
        'Лицензия',
      ],
    ],
  ])
    for (const heading of headings)
      assert.ok(markdown.includes(`## ${heading}`), `${name} has no "${heading}" section`);

  // Badges: CI, release, licence (section 24.1).
  for (const markdown of [english, russian]) {
    assert.match(markdown, /workflows\/ci\.yml\/badge\.svg/u);
    assert.match(markdown, /img\.shields\.io\/github\/v\/release/u);
    assert.match(markdown, /license-MIT/u);
  }
});

test('the release workflows exist and publish on a version tag', async () => {
  const release = await readFile('.github/workflows/release.yml', 'utf8');
  const rebuild = await readFile('.github/workflows/rebuild.yml', 'utf8');

  // The acceptance: a tag `v0.9.0-rc.1` publishes images.
  assert.match(release, /^ {6}- 'v\[0-9\]\+\.\[0-9\]\+\.\[0-9\]\+-rc\.\[0-9\]\+'$/mu);
  assert.match(release, /push: true/u);
  for (const image of ['app', 'web', 'nginx', 'caddy'])
    assert.match(release, new RegExp(`- image: ${image}\\n`, 'u'), `${image} is never published`);
  // A candidate must not become what `RR_VERSION=1` resolves to.
  assert.match(
    release,
    /type=raw,value=rc,enable=\$\{\{ steps\.version\.outputs\.prerelease == 'true' \}\}/u,
  );
  // `floating-tags.sh` answers false for a candidate (tooling.test.mjs).
  assert.match(
    release,
    /pattern=\{\{major\}\},enable=\$\{\{ steps\.floating\.outputs\.major == 'true' \}\}/u,
  );
  assert.match(release, /platforms: linux\/amd64,linux\/arm64/u);
  assert.match(release, /sbom: true/u);

  // Section 24.6: the weekly rebuild on fresh bases, gated by trivy.
  assert.match(rebuild, /cron: '0 4 \* \* 1'/u);
  assert.match(rebuild, /no-cache: true/u);
  assert.match(rebuild, /trivy-action/u);
});

test('compose follows the major line, as section 24.4 requires', async () => {
  const compose = await readFile('compose.yaml', 'utf8');

  for (const image of ['app', 'web', 'nginx', 'caddy', 'backup'])
    assert.ok(
      compose.includes(`\${RR_REGISTRY:-ghcr.io/remnaray}/${image}:\${RR_VERSION:-1}`),
      `the ${image} image does not follow RR_REGISTRY and RR_VERSION`,
    );
});

// The repository moved to the RemnaRay organisation (owner decision О-2,
// 2026-09-27): the images, the signatures and the update check follow it.
test('the delivery names the repository RemnaRay/RemnaRay', async () => {
  const install = await readFile('docs/install.md', 'utf8');
  assert.match(
    install,
    /--certificate-identity-regexp '\^https:\/\/github\\\.com\/RemnaRay\/RemnaRay\/\\\.github\/workflows\/\(release\|rebuild\)\\\.yml@'/u,
  );
  for (const file of ['README.md', 'README.ru.md', 'docs/install.md'])
    assert.match(
      await readFile(file, 'utf8'),
      /git clone https:\/\/github\.com\/RemnaRay\/RemnaRay && cd RemnaRay/u,
      file,
    );
  assert.match(
    await readFile('apps/worker/src/queues/update-check.ts', 'utf8'),
    /UPDATE_REPOSITORY = 'RemnaRay\/RemnaRay'/u,
  );
  // Tracked files only; PROGRESS.md is history and keeps the old name.
  const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
    .split('\0')
    .filter((file) => file !== '' && file !== 'docs/development/PROGRESS.md');
  const stale = [];
  for (const file of tracked) {
    const content = await readFile(file).catch(() => Buffer.alloc(0));
    if (/VAQYBIN\/remnaray-astra/iu.test(content.toString('utf8'))) stale.push(file);
  }
  assert.deepEqual(stale, []);
});
