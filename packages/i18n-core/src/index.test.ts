import { describe, expect, it } from 'vitest';

import {
  assertIcu,
  formatMessage,
  formatPlainMessage,
  localeDirectory,
  namespaces,
  placeholdersOf,
  readCatalog,
  readNamespace,
  SUPPORTED_LOCALES,
} from './index.js';

const root = localeDirectory();

describe('locale catalogs', () => {
  it('reads the shipped bot catalog from the locales directory', () => {
    for (const locale of SUPPORTED_LOCALES) {
      const catalog = readNamespace(root, locale, 'bot');
      expect(Object.keys(catalog).length).toBeGreaterThan(50);
      expect(catalog['bot.commands.start']).toBeTypeOf('string');
    }
  });

  it('merges every namespace into one catalog', () => {
    const catalog = readCatalog(root, 'ru');
    expect(catalog['bot.commands.start']).toBeTypeOf('string');
    expect(catalog['notify.payment.succeeded']).toBeTypeOf('string');
    expect(namespaces).toContain('legal');
  });

  it('formats ICU plural messages for both supported locales', () => {
    const ru = readCatalog(root, 'ru');
    const en = readCatalog(root, 'en');
    expect(formatMessage('ru', ru, 'bot.screen.trial.confirm', { days: 3, traffic: '10 ГБ' })).toBe(
      'Триал: 3 дня, трафик 10 ГБ.',
    );
    expect(formatMessage('en', en, 'bot.screen.trial.confirm', { days: 1, traffic: '10 GB' })).toBe(
      'Trial: 1 day, traffic 10 GB.',
    );
  });

  it('falls back to the key when a message is missing', () => {
    expect(formatMessage('ru', {}, 'missing.key')).toBe('missing.key');
  });

  it('validates ICU syntax and extracts placeholders', () => {
    expect(() => {
      assertIcu('ru', 'k', '{days, plural, one {# день} other {# дней}}');
    }).not.toThrow();
    expect(() => {
      assertIcu('ru', 'k', '{days, plural, one {# день}');
    }).toThrow();
    expect(
      placeholdersOf('{plan}: {price} for {days, plural, one {# day} other {# days}}.'),
    ).toEqual(['days', 'plan', 'price']);
  });
});

describe('plain and HTML formatting', () => {
  const catalog = { 'x.label': 'Купить «{plan}»' };

  it('keeps string values verbatim in plain text', () => {
    expect(formatPlainMessage('ru', catalog, 'x.label', { plan: 'A&B <5>' })).toBe(
      'Купить «A&B <5>»',
    );
  });

  it('still escapes string values for HTML', () => {
    expect(formatMessage('ru', catalog, 'x.label', { plan: 'A&B <5>' })).toBe(
      'Купить «A&amp;B &lt;5&gt;»',
    );
  });
});
