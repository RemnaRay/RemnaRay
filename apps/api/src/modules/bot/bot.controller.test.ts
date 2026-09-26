import { describe, expect, it } from 'vitest';

import {
  BotAdminController,
  BotInternalController,
  TelegramWebhookController,
} from './bot.controller';

describe('bot ingress boundary', () => {
  it('writes a valid Telegram update to the Valkey stream', async () => {
    const calls: unknown[][] = [];
    const controller = new TelegramWebhookController(
      {
        redis: {
          eval: (...args: unknown[]) => {
            calls.push(args);
            return Promise.resolve('1-0');
          },
        },
      } as never,
      {
        get: (key: string) =>
          Promise.resolve(key === 'bot.webhook_secret_path' ? 'path-secret' : 'header-secret'),
      } as never,
    );
    await controller.receive(
      'path-secret',
      { 'x-telegram-bot-api-secret-token': 'header-secret' },
      { update_id: 7, message: { text: '/start' } },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('tg:updates');
    expect(calls[0]).toContain(JSON.stringify({ update_id: 7, message: { text: '/start' } }));
  });

  it('writes the support bot’s updates to its own stream, and refuses an unknown path (F35)', async () => {
    const calls: unknown[][] = [];
    const settings: Record<string, string> = {
      'bot.webhook_secret_path': 'shop-path',
      'bot.webhook_secret_token': 'shop-header',
      'bot.support_token': '777:support',
      'bot.support_webhook_secret_path': 'support-path',
      'bot.support_webhook_secret_token': 'support-header',
    };
    const controller = new TelegramWebhookController(
      {
        redis: {
          eval: (...args: unknown[]) => {
            calls.push(args);
            return Promise.resolve('1-0');
          },
        },
      } as never,
      { get: (key: string) => Promise.resolve(settings[key] ?? '') } as never,
    );
    await controller.receive(
      'support-path',
      { 'x-telegram-bot-api-secret-token': 'support-header' },
      { update_id: 8, message: { text: 'help' } },
    );
    expect(calls[0]).toContain('tg:support-updates:777');
    expect(calls[0]).toContain('tg:support-received:777:8');
    // One bot's path with the other's secret header is nobody's.
    await expect(
      controller.receive(
        'support-path',
        { 'x-telegram-bot-api-secret-token': 'shop-header' },
        { update_id: 9 },
      ),
    ).rejects.toMatchObject({ status: 403 });
    // Turned off: its address answers nobody, even with its old secrets.
    settings['bot.support_token'] = '';
    await expect(
      controller.receive(
        'support-path',
        { 'x-telegram-bot-api-secret-token': 'support-header' },
        { update_id: 10 },
      ),
    ).rejects.toMatchObject({ status: 403 });
    settings['bot.support_webhook_secret_path'] = '';
    settings['bot.support_webhook_secret_token'] = '';
    await expect(
      controller.receive('', { 'x-telegram-bot-api-secret-token': '' }, { update_id: 11 }),
    ).rejects.toMatchObject({ status: 403 });
    expect(calls).toHaveLength(1);
  });

  it('serves locale messages and a mode-aware bot configuration', async () => {
    const settings: Record<string, unknown> = {
      'bot.mode': 'webhook',
      'domain.main': 'shop.example.test',
      'bot.webhook_secret_path': 'path-secret',
      'bot.webhook_secret_token': 'header-secret',
      'brand.support_forward_chat_id': null,
      'brand.name': 'Manta VPN',
      'trial.days': 7,
      'trial.traffic_gb': 25,
      'locale.timezone': 'Asia/Yekaterinburg',
      'clients.items': [
        { id: 'happ', name: 'Happ', platforms: ['ios'], deepLinkTemplate: 'happ://add/{url}' },
      ],
    };
    const catalogs: Record<string, Record<string, string>> = {
      en: { 'bot.btn.buy': '🛒 Buy', 'bot.commands.start': 'Start the bot' },
      ru: { 'bot.btn.buy': '🛒 Купить', 'bot.commands.start': 'Запустить бота' },
    };
    const controller = new BotInternalController(
      { db: { admin: { findMany: () => Promise.resolve([{ telegramId: 123n }]) } } } as never,
      { get: (key: string) => Promise.resolve(settings[key]) } as never,
      { messages: (lang: string) => Promise.resolve(catalogs[lang] ?? {}) } as never,
    );
    await expect(controller.messages('en')).resolves.toMatchObject({
      lang: 'en',
      messages: { 'bot.btn.buy': '🛒 Buy' },
    });
    const config = await controller.config();
    expect(config).toMatchObject({
      mode: 'webhook',
      webUrl: 'https://shop.example.test',
      webhookUrl: 'https://shop.example.test/tg/webhook/path-secret',
      admins: ['123'],
      brandName: 'Manta VPN',
      trial: { days: 7, trafficGb: 25 },
      clients: [{ name: 'Happ', platforms: ['ios'] }],
      timezone: 'Asia/Yekaterinburg',
      supportBot: null,
    });
    expect(config.commands.en?.[0]).toEqual({ command: 'start', description: 'Start the bot' });

    // F35: the support bot comes with its own webhook, in the same mode.
    Object.assign(settings, {
      'bot.support_token': '777:support',
      'bot.support_username': 'manta_help_bot',
      'bot.support_webhook_secret_path': 'support-path',
      'bot.support_webhook_secret_token': 'support-header',
    });
    await expect(controller.config()).resolves.toMatchObject({
      supportBot: {
        token: '777:support',
        username: 'manta_help_bot',
        webhookUrl: 'https://shop.example.test/tg/webhook/support-path',
        secretToken: 'support-header',
      },
    });
  });

  it('authorizes bot admin extension and writes an audit record', async () => {
    let audited = false;
    const emitted: string[] = [];
    const controller = new BotAdminController({
      db: {
        admin: { findFirst: () => Promise.resolve({ id: 'admin-1', role: 'admin' }) },
        user: { findUnique: () => Promise.resolve({ id: 'user-1' }) },
        subscription: {
          findFirst: () =>
            Promise.resolve({ id: 'sub-1', expiresAt: new Date('2026-01-01T00:00:00.000Z') }),
        },
        $transaction: async (callback: (transaction: unknown) => Promise<void>) =>
          callback({
            subscription: {
              update: () =>
                Promise.resolve({
                  id: 'sub-1',
                  planId: null,
                  source: 'purchase',
                  status: 'active',
                  startsAt: new Date('2025-12-01T00:00:00.000Z'),
                  expiresAt: new Date('2026-01-08T00:00:00.000Z'),
                }),
            },
            user: { findUnique: () => Promise.resolve({ telegramId: 456n }) },
            outboxJob: {
              create: ({
                data,
              }: {
                data: { name: string; payload: { type?: string; reason?: string } };
              }) => {
                emitted.push(`${data.name} ${data.payload.type ?? data.payload.reason ?? ''}`);
                return Promise.resolve();
              },
            },
            transaction: { create: () => Promise.resolve() },
            auditLog: {
              create: () => {
                audited = true;
                return Promise.resolve();
              },
            },
          }),
      },
    } as never);
    await controller.extend('123', { telegramId: '456', days: 7 });
    expect(audited).toBe(true);
    // Section 9.8 and the panel sync (10.6), in the transaction that extends
    // the subscription.
    expect(emitted).toEqual([
      'webhooks.dispatch subscription.activated',
      'panel.sync-user bot-admin',
    ]);
  });
});
