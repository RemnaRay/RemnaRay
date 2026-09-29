import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import IntlMessageFormat from 'intl-messageformat';

export const SUPPORTED_LOCALES = ['ru', 'en'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

export type MessageCatalog = Record<string, string>;

export const namespaces = [
  'common',
  'landing',
  'account',
  'admin',
  'setup',
  'bot',
  'notify',
  'errors',
  'seo',
  'legal',
] as const;
export type Namespace = (typeof namespaces)[number];

/** Resolves the mounted `locales/` directory (compose mounts it at `/locales`). */
export function localeDirectory(cwd = process.cwd()): string {
  const candidates = [
    process.env.RR_LOCALES_DIR,
    '/locales',
    join(cwd, 'locales'),
    join(cwd, '..', '..', 'locales'),
  ].filter((value): value is string => Boolean(value));
  return candidates.find((candidate) => existsSync(candidate)) ?? '/locales';
}

/** Reads one shipped namespace file. Missing files are an empty catalog. */
export function readNamespace(root: string, lang: string, namespace: string): MessageCatalog {
  const file = join(root, lang, `${namespace}.json`);
  if (!existsSync(file)) return {};
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const catalog: MessageCatalog = {};
  for (const [key, value] of Object.entries(parsed)) {
    catalog[key] = typeof value === 'string' ? value : JSON.stringify(value);
  }
  return catalog;
}

/** Whole shipped catalog for a language, every namespace merged. */
export function readCatalog(root: string, lang: string): MessageCatalog {
  const catalog: MessageCatalog = {};
  for (const namespace of namespaces) Object.assign(catalog, readNamespace(root, lang, namespace));
  return catalog;
}

/** Throws when a template is not valid ICU for the locale. */
export function assertIcu(locale: Locale, key: string, template: string): void {
  try {
    new IntlMessageFormat(template, locale, undefined, { ignoreTag: true });
  } catch (error) {
    throw new Error(`Invalid ICU message ${key} (${locale})`, { cause: error });
  }
}

/** Named `{placeholders}` referenced by an ICU template. */
export function placeholdersOf(template: string): string[] {
  return [
    ...new Set([...template.matchAll(/\{\s*([A-Za-z0-9_]+)/gu)].map((match) => match[1] ?? '')),
  ]
    .filter(Boolean)
    .sort();
}

function render(
  locale: Locale,
  messages: MessageCatalog,
  key: string,
  values: Record<string, unknown>,
): string {
  return String(
    new IntlMessageFormat(messages[key] ?? key, locale, undefined, { ignoreTag: true }).format(
      values,
    ),
  );
}

/** For HTML output: string values are escaped. */
export function formatMessage(
  locale: Locale,
  messages: MessageCatalog,
  key: string,
  values: Record<string, unknown> = {},
): string {
  return render(
    locale,
    messages,
    key,
    Object.fromEntries(
      Object.entries(values).map(([name, value]) => [
        name,
        typeof value === 'string' ? escapeHtml(value) : value,
      ]),
    ),
  );
}

/** For plain text (Telegram button labels): values are kept verbatim. */
export function formatPlainMessage(
  locale: Locale,
  messages: MessageCatalog,
  key: string,
  values: Record<string, unknown> = {},
): string {
  return render(locale, messages, key, values);
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
