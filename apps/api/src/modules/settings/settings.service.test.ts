import { describe, expect, it } from 'vitest';

import { encryptSetting } from './settings.crypto';
import { settingRegistry } from './settings.schemas';
import { SettingsService } from './settings.service';
import type { SettingsChangedEvent, SettingsEventBusPort } from './settings.events';
import type { SettingsRepositoryPort, SettingWrite, StoredSetting } from './settings.repository';

const appKey = Buffer.alloc(32, 9).toString('base64');

class MemoryRepository implements SettingsRepositoryPort {
  values: StoredSetting[] = [];
  replaceCalls: SettingWrite[][] = [];

  list() {
    return Promise.resolve(this.values);
  }

  replace(values: SettingWrite[]) {
    this.replaceCalls.push(values);
    for (const value of values) {
      const existing = this.values.find((item) => item.key === value.key);
      if (existing) Object.assign(existing, value);
      else this.values.push({ ...value });
    }
    return Promise.resolve();
  }
}

class MemoryEventBus implements SettingsEventBusPort {
  events: SettingsChangedEvent[] = [];
  private handler: ((event: SettingsChangedEvent) => void) | undefined;

  publish(event: SettingsChangedEvent) {
    this.events.push(event);
    return Promise.resolve();
  }

  subscribe(handler: (event: SettingsChangedEvent) => void) {
    this.handler = handler;
    return Promise.resolve();
  }

  async close() {}

  emit(event: SettingsChangedEvent) {
    this.handler?.(event);
  }
}

describe('SettingsService', () => {
  it('exposes registry defaults and masks secrets', async () => {
    const repository = new MemoryRepository();
    const events = new MemoryEventBus();
    const service = new SettingsService(repository, events, appKey);
    await service.onModuleInit();

    const settings = await service.getAll(false);
    expect(settings.setup?.completed).toBe(false);
    expect(settings.panel?.api_token).toEqual({ set: false });
    expect(settings.locale?.enabled).toEqual(['ru', 'en']);
    expect(service.schema().some((item) => item.key === 'webhooks.outgoing')).toBe(true);
  });

  // R58: these three values are pasted into the nginx and Caddy
  // configurations as they are. A domain with `{`, `;` or a newline, or an
  // allowlist entry `0.0.0.0/0; allow all`, added directives of its own —
  // in Caddy a site serving the TLS keys under `/data`.
  it('accepts only host names and IP ranges for what the proxy renders', async () => {
    const service = new SettingsService(new MemoryRepository(), new MemoryEventBus(), appKey);
    await service.onModuleInit();

    for (const main of [
      'shop.example.com {\n}\nevil.example.com {\n\troot * /data\n\tfile_server browse\n}\nshop.example.com',
      'shop.example.com;',
      'shop example.com',
      'shop.example.com\n',
      '-shop.example.com',
    ])
      await expect(service.set({ domain: { main } }), JSON.stringify(main)).rejects.toThrow();
    await expect(
      service.set({ domain: { extra_domains: ['www.example.com }'] } }),
    ).rejects.toThrow();
    for (const entry of [
      '0.0.0.0/0; allow all',
      '10.0.0.1/33',
      '::/129',
      '10.0.0.0/8 ',
      'localhost',
      '1.2.3.4/',
    ])
      await expect(
        service.set({ admin: { ip_allowlist: [entry] } }),
        JSON.stringify(entry),
      ).rejects.toThrow();

    await service.set({
      domain: {
        main: 'Shop-1.example.com',
        extra_domains: ['www.example.com', 'xn--80ak6aa92e.com'],
      },
      admin: { ip_allowlist: ['203.0.113.0/24', '198.51.100.7', '2001:db8::/32', '::1'] },
    });
    expect(await service.get('admin.ip_allowlist')).toEqual([
      '203.0.113.0/24',
      '198.51.100.7',
      '2001:db8::/32',
      '::1',
    ]);
  });

  // R29: with another RR_APP_KEY every secret failed to decrypt, was logged
  // as «invalid» and replaced by its default — an empty bot and panel token —
  // and the API reported itself healthy. Section 17.2 wants a wrong key to
  // stop the start; one unreadable value among readable ones is still the
  // section 17.5 case (logged, default, the process starts).
  it('refuses to start when the key decrypts none of the stored secrets', async () => {
    const otherKey = Buffer.alloc(32, 3).toString('base64');
    const repository = new MemoryRepository();
    repository.values.push(
      { key: 'bot.token', value: encryptSetting('123:abc', otherKey), isSecret: true },
      { key: 'panel.api_token', value: encryptSetting('panel', otherKey), isSecret: true },
    );
    const service = new SettingsService(repository, new MemoryEventBus(), appKey);
    await expect(service.onModuleInit()).rejects.toThrow(/RR_APP_KEY decrypts none of the 2/u);

    const mixed = new MemoryRepository();
    mixed.values.push(
      { key: 'bot.token', value: encryptSetting('123:abc', appKey), isSecret: true },
      { key: 'panel.api_token', value: encryptSetting('panel', otherKey), isSecret: true },
    );
    const started = new SettingsService(mixed, new MemoryEventBus(), appKey);
    await started.onModuleInit();
    expect(await started.get('bot.token')).toBe('123:abc');
  });

  it('validates a whole group, encrypts secrets, and publishes invalidation', async () => {
    const repository = new MemoryRepository();
    const events = new MemoryEventBus();
    const service = new SettingsService(repository, events, appKey);
    await service.onModuleInit();

    await service.set({
      domain: { main: 'shop.example.com', extra_domains: ['www.example.com'] },
      panel: { api_token: 'panel-secret' },
    });

    const stored = repository.values.find((item) => item.key === 'panel.api_token');
    expect(stored?.isSecret).toBe(true);
    expect(JSON.stringify(stored?.value)).not.toContain('panel-secret');
    expect(await service.get('panel.api_token')).toBe('panel-secret');
    expect((await service.exportSnapshot()).settings.panel?.api_token).toEqual({ set: true });
    expect(events.events.at(-1)?.keys).toEqual([
      'domain.main',
      'domain.extra_domains',
      'panel.api_token',
    ]);

    await expect(service.set({ locale: { default: 'de' } })).rejects.toThrow();
    // An unknown time zone would break every date the bot and the site format.
    await expect(service.set({ locale: { timezone: 'Mars/Olympus' } })).rejects.toThrow();
    expect(repository.replaceCalls).toHaveLength(1);
    await service.set({ locale: { timezone: 'Asia/Yekaterinburg' } });
    expect(repository.replaceCalls).toHaveLength(2);
  });

  it('preserves a secret when an exported marker is imported', async () => {
    const repository = new MemoryRepository();
    const events = new MemoryEventBus();
    const service = new SettingsService(repository, events, appKey);
    await service.onModuleInit();
    await service.set({ bot: { token: 'bot-secret' } });

    await service.importSnapshot({
      version: 1,
      settings: { bot: { token: { set: true } } },
    });

    expect(await service.get('bot.token')).toBe('bot-secret');
    expect(repository.replaceCalls).toHaveLength(1);
  });

  it('imports an export that still carries a retired key (F37: referral.count_topups)', async () => {
    const repository = new MemoryRepository();
    const service = new SettingsService(repository, new MemoryEventBus(), appKey);
    await service.onModuleInit();

    await expect(
      service.importSnapshot({
        version: 1,
        settings: { referral: { count_topups: true, percent: 30 } },
      }),
    ).resolves.toBeUndefined();

    expect(await service.get('referral.percent')).toBe(30);
    expect(repository.values.map((item) => item.key)).not.toContain('referral.count_topups');
    // A key no release ever had is still refused.
    await expect(service.set({ referral: { counts_topups: true } })).rejects.toThrow(
      'Unknown setting key: referral.counts_topups',
    );
  });

  // Spec §2 / ADR-021: every pre-F37 export carries the old default receipt
  // template (the export writes defaults too); it imports as the new default.
  it('imports a full pre-F37 export with the old default receipt template', async () => {
    const repository = new MemoryRepository();
    const service = new SettingsService(repository, new MemoryEventBus(), appKey);
    await service.onModuleInit();
    // A configured shop: every secret is set, so the export carries `{ set: true }`.
    for (const definition of settingRegistry.filter((item) => item.secret))
      await service.set({ [definition.group]: { [definition.name]: definition.defaultValue } });
    const exported = await service.exportSnapshot();
    exported.settings.fiscal = {
      ...exported.settings.fiscal,
      item_name_template: 'Subscription {plan}',
    };
    exported.settings.referral = { ...exported.settings.referral, count_topups: false };

    // The dry run shows no change for the template the import rewrites.
    expect((await service.diff(exported)).map((item) => item.key)).not.toContain(
      'fiscal.item_name_template',
    );
    await expect(service.importSnapshot(exported)).resolves.toBeUndefined();

    expect(await service.get('fiscal.item_name_template')).toBe('Пополнение баланса (#{number})');
    expect(repository.values.find((item) => item.key === 'fiscal.item_name_template')?.value).toBe(
      'Пополнение баланса (#{number})',
    );
    // A template the owner customised with `{plan}` is still refused.
    await expect(service.set({ fiscal: { item_name_template: 'VPN {plan}' } })).rejects.toThrow(
      'Only {number} and {brand} are allowed.',
    );
  });

  it('invalidates only the keys announced by another process', async () => {
    const repository = new MemoryRepository();
    const events = new MemoryEventBus();
    const service = new SettingsService(repository, events, appKey);
    await service.onModuleInit();
    expect(await service.get('brand.name')).toBe('RemnaRay Shop');

    repository.values.push({ key: 'brand.name', value: 'Updated', isSecret: false });
    events.emit({ keys: ['brand.name'], version: Date.now() });

    expect(await service.get('brand.name')).toBe('Updated');
  });
});

describe('section 17.6 reaction matrix', () => {
  it('asks the right process to reconfigure for each key prefix', () => {
    expect(SettingsService.sideEffects(['bot.token']).channels).toEqual(['rr:bot.reconfigure']);
    expect(SettingsService.sideEffects(['domain.main']).channels).toEqual(['rr:proxy.reload']);
    expect(SettingsService.sideEffects(['theme.slug']).channels).toEqual(['rr:theme.changed']);
    expect(SettingsService.sideEffects(['locale.enabled']).channels).toEqual(['rr:i18n.changed']);
    expect(SettingsService.sideEffects(['brand.name']).channels).toEqual([]);
  });

  it('deduplicates channels and reports no restart for v1 keys', () => {
    const result = SettingsService.sideEffects([
      'bot.token',
      'bot.mode',
      'theme.slug',
      'invoice.ttl_minutes',
    ]);

    expect(result.channels).toEqual(['rr:bot.reconfigure', 'rr:theme.changed']);
    expect(result.restartRequired).toEqual([]);
  });

  it('defaults the receipt line to the numbered top-up template (F37)', async () => {
    const service = new SettingsService(new MemoryRepository(), new MemoryEventBus(), appKey);
    await service.onModuleInit();
    expect(await service.get('fiscal.item_name_template')).toBe('Пополнение баланса (#{number})');
  });

  it('refuses a receipt template with an unknown placeholder', async () => {
    const service = new SettingsService(new MemoryRepository(), new MemoryEventBus(), appKey);
    await service.onModuleInit();
    await expect(service.set({ fiscal: { item_name_template: 'Тариф {plan}' } })).rejects.toThrow();
    await expect(
      service.set({ fiscal: { item_name_template: '{brand} (#{number})' } }),
    ).resolves.toBeUndefined();
  });
});
