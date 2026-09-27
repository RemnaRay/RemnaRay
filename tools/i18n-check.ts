import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  assertIcu,
  namespaces,
  placeholdersOf,
  SUPPORTED_LOCALES,
  type Locale,
} from '../packages/i18n-core/src/index.js';

const root = join(process.cwd(), 'locales');
const base: Locale = 'en';
const locales = readdirSync(root).filter((entry) => !entry.startsWith('.'));
const legalDocuments = ['terms', 'privacy', 'offer'];
/** Keys whose Russian value is intentionally not Cyrillic (brands, endonyms). */
const nonCyrillicRussianKeys = new Set([
  'common.brand',
  'common.language.en',
  'bot.lang.en',
  'account.email',
  'admin.login.email',
  'admin.users.telegramId',
  'admin.users.username',
  'notify.admin.message',
  'alerts.title',
  'admin.bot.username',
  'admin.bot.test',
  'admin.legal.markdown',
  'admin.admins.email',
  'admin.admins.totp',
  'admin.providers.health',
  'setup.admin.email',
  // Payment brands, operating systems and the English path of CryptoBot's own menus.
  'admin.providers.name.robokassa',
  'admin.providers.name.lava',
  'admin.providers.name.platega',
  'admin.providers.name.cryptobot',
  'admin.providers.name.stars',
  'admin.providers.name.mock',
  'admin.providers.hint.token',
  'setup.payments.providerName.robokassa',
  'setup.payments.providerName.lava',
  'setup.payments.providerName.platega',
  'setup.payments.providerName.cryptobot',
  'setup.payments.providerName.stars',
  'setup.payments.providerName.mock',
  'setup.payments.hint.token',
  'bot.btn.guide.android',
  'bot.btn.guide.windows',
  'bot.btn.guide.macos',
  'bot.btn.guide.linux',
]);
const cyrillic = /[\u0400-\u04FF]/u;

/**
 * The words a reader sees: HTML tags, entities and ICU argument names are
 * markup, so `<code>{code}</code>` is not English copy.
 */
function visibleText(template: string): string {
  return template
    .replaceAll(/<[^>]*>/gu, ' ')
    .replaceAll(/&(?:[a-z]+|#\d+);/giu, ' ')
    .replaceAll(/\{\s*[A-Za-z_]\w*\s*(?:,\s*[a-z]+\s*,?)?\s*\}?/gu, ' ');
}

const failures: string[] = [];

/** Flattens the JSON namespace file, expanding arrays and objects into leaf keys. */
function flatten(value: unknown, prefix: string, into: Map<string, string>): void {
  if (typeof value === 'string') {
    into.set(prefix, value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      flatten(item, `${prefix}[${String(index)}]`, into);
    });
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) flatten(item, `${prefix}.${key}`, into);
  }
}

function read(locale: string, namespace: string): Map<string, string> {
  const file = join(root, locale, `${namespace}.json`);
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  const leaves = new Map<string, string>();
  for (const [key, value] of Object.entries(parsed)) flatten(value, key, leaves);
  return leaves;
}

function isSupported(locale: string): locale is Locale {
  return SUPPORTED_LOCALES.includes(locale as Locale);
}

let checked = 0;
for (const namespace of namespaces) {
  const expected = read(base, namespace);
  for (const locale of locales) {
    const actual = read(locale, namespace);
    for (const key of expected.keys())
      if (!actual.has(key)) failures.push(`${locale}/${namespace}: missing key ${key}`);
    for (const key of actual.keys())
      if (!expected.has(key)) failures.push(`${locale}/${namespace}: key ${key} is not in ${base}`);

    for (const [key, template] of actual) {
      checked += 1;
      if (isSupported(locale)) {
        try {
          assertIcu(locale, `${namespace}.${key}`, template);
        } catch (error) {
          failures.push(String(error));
        }
      }
      const reference = expected.get(key);
      if (reference === undefined) continue;
      const left = placeholdersOf(reference).join(',');
      const right = placeholdersOf(template).join(',');
      if (left !== right)
        failures.push(
          `${locale}/${namespace}: placeholders differ for ${key} (${base}: ${left || '—'}, ${locale}: ${right || '—'})`,
        );
    }
  }
}

for (const namespace of namespaces) {
  for (const [key, template] of read('ru', namespace)) {
    if (nonCyrillicRussianKeys.has(key)) continue;
    const text = visibleText(template);
    if (!/[A-Za-z]{4}/u.test(text)) continue;
    if (!cyrillic.test(text)) failures.push(`ru/${namespace}: ${key} still reads as English copy`);
  }
}

for (const locale of locales) {
  for (const document of legalDocuments) {
    const file = join(root, locale, 'legal', `${document}.md`);
    if (!existsSync(file)) {
      failures.push(`${locale}: missing legal/${document}.md`);
      continue;
    }
    const markdown = readFileSync(file, 'utf8');
    if (!markdown.trim().startsWith('# '))
      failures.push(`${locale}/legal/${document}.md must start with a level-one heading`);
    for (const token of ['{brand}', '{domain}', '{support}'])
      if (!markdown.includes(token))
        failures.push(`${locale}/legal/${document}.md never uses ${token}`);
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(failure);
  throw new Error(`i18n check failed with ${String(failures.length)} problem(s).`);
}

console.log(
  `Checked ${String(locales.length)} locales, ${String(namespaces.length)} namespaces, ${String(checked)} messages and ${String(locales.length * legalDocuments.length)} legal documents.`,
);
