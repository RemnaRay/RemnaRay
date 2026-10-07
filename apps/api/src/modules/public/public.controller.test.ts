import { describe, expect, it, vi } from 'vitest';

import { PublicController, PublicReferralController } from './public.controller';

const settingValues: Record<string, unknown> = {
  'brand.name': 'Manta Shop',
  'brand.slogan': { ru: 'Спокойные подписки', en: 'Calm subscriptions' },
  'brand.support_contact': '@manta_support',
  'brand.hide_powered_by': false,
  'bot.username': 'manta_bot',
  'locale.default': 'ru',
  'locale.enabled': ['ru', 'en'],
  'admin.language': 'en',
  'trial.enabled': true,
  'trial.days': 3,
  'balance.topup_enabled': true,
  'referral.enabled': true,
  'legal.terms_updated_at': null,
  'legal.privacy_updated_at': null,
  'clients.items': [{ id: 'happ', name: 'Happ', platforms: ['ios'], storeUrls: {} }],
  'domain.main': 'shop.example.test',
};

function controller(overrides: Record<string, string> = {}) {
  const i18n = {
    namespace: vi.fn().mockResolvedValue({
      lang: 'ru',
      namespace: 'legal',
      messages: overrides,
      etag: '"abc"',
    }),
  };
  const settings = { get: (key: string) => Promise.resolve(settingValues[key]) };
  return new PublicController({} as never, i18n as never, settings as never);
}

describe('public API', () => {
  it('publishes the section 9.4 config shape', async () => {
    const config = await controller().config();

    expect(config).toMatchObject({
      brand: {
        name: 'Manta Shop',
        supportContact: '@manta_support',
        botUsername: 'manta_bot',
        hidePoweredBy: false,
      },
      locales: { default: 'ru', enabled: ['ru', 'en'], admin: 'en' },
      currency: 'RUB',
      features: { trial: { enabled: true, days: 3 }, topup: true, referral: true, promo: true },
    });
    expect(config.clients).toHaveLength(1);
  });

  it('substitutes brand, domain and support in the shipped legal text', async () => {
    const legal = await controller().legal('terms', 'ru');

    expect(legal.doc).toBe('terms');
    expect(legal.markdown).toContain('Manta Shop');
    expect(legal.markdown).toContain('shop.example.test');
    expect(legal.markdown).toContain('@manta_support');
    expect(legal.markdown).not.toContain('{brand}');
    expect(legal.markdown).not.toContain('{support}');
  });

  it('prefers the stored override over the shipped legal file', async () => {
    const legal = await controller({ 'legal.terms.markdown': '# Свои условия {brand}' }).legal(
      'terms',
      'ru',
    );

    expect(legal.markdown).toBe('# Свои условия Manta Shop');
  });

  it('rejects an unknown legal document', async () => {
    await expect(controller().legal('contract', 'ru')).rejects.toThrow();
  });
});

describe('referral link', () => {
  function referral(found: boolean) {
    const headers: Record<string, string> = {};
    const reply = {
      header: (name: string, value: string) => {
        headers[name] = value;
        return reply;
      },
      redirect: (target: string, status: number) => ({ target, status }),
    };
    const infra = {
      db: { user: { findUnique: () => Promise.resolve(found ? { id: 'user-1' } : null) } },
    };
    return { headers, reply, controller: new PublicReferralController(infra as never) };
  }

  it('stores a known code for 30 days and returns to the site', async () => {
    const test = referral(true);
    const result = await test.controller.referral('AB12CD34', test.reply as never);

    expect(result).toEqual({ target: '/', status: 302 });
    expect(test.headers['set-cookie']).toContain('rr_ref=AB12CD34');
    expect(test.headers['set-cookie']).toContain('Max-Age=2592000');
    expect(test.headers['set-cookie']).toContain('SameSite=Lax');
  });

  it('never stores an unknown or malformed code', async () => {
    const unknown = referral(false);
    await unknown.controller.referral('AB12CD34', unknown.reply as never);
    expect(unknown.headers['set-cookie']).toBeUndefined();

    const malformed = referral(true);
    await malformed.controller.referral('../etc', malformed.reply as never);
    expect(malformed.headers['set-cookie']).toBeUndefined();
  });
});
