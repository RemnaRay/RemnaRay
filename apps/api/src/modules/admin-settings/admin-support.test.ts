import { afterEach, describe, expect, it, vi } from 'vitest';

import { Audited } from '../admin/audit.interceptor';
import { AdminBotController } from './admin-settings.controller';

function harness() {
  const values = new Map<string, unknown>([
    ['bot.token', '123:shop-token'],
    ['brand.support_contact', '@manta_help'],
    ['brand.support_forward_chat_id', null],
  ]);
  const settings = {
    get: (key: string) => Promise.resolve(values.has(key) ? values.get(key) : ''),
    set: (patch: Record<string, Record<string, unknown>>) => {
      for (const [group, entries] of Object.entries(patch))
        for (const [name, value] of Object.entries(entries)) values.set(`${group}.${name}`, value);
      return Promise.resolve();
    },
  };
  const publish = vi.fn().mockResolvedValue(1);
  const controller = new AdminBotController(settings as never, { redis: { publish } } as never);
  const request = { admin: { id: 'admin-1' } } as never;
  vi.stubGlobal('fetch', (url: string) => {
    const token = decodeURIComponent(url.split('/bot')[1]?.split('/')[0] ?? '');
    const bot =
      token === '777:help-token'
        ? { id: 777, username: 'manta_help_bot' }
        : token === '123:shop-token'
          ? { id: 123, username: 'manta_bot' }
          : null;
    return Promise.resolve(
      Response.json(bot ? { ok: true, result: bot } : { ok: false, error_code: 401 }),
    );
  });
  return { controller, values, publish, request };
}

describe('the console’s «Поддержка» (FR-124, F35)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('saves the operators’ chat and a support bot, showing its username and never its token', async () => {
    const { controller, values, publish, request } = harness();

    const result = await controller.updateSupport(
      { chatId: -100500, token: '777:help-token', reason: 'support bot' },
      request,
    );

    expect(result).toBeInstanceOf(Audited);
    await expect(controller.support()).resolves.toEqual({
      contact: '@manta_help',
      chatId: -100500,
      supportBot: { username: 'manta_help_bot' },
    });
    expect(values.get('bot.support_token')).toBe('777:help-token');
    expect(JSON.stringify(await controller.support())).not.toContain('777:help-token');
    expect(publish).toHaveBeenCalledWith('rr:bot.reconfigure', expect.any(String));

    // An empty token turns it off; an absent one keeps it.
    await controller.updateSupport({ contact: '@help' }, request);
    expect(values.get('bot.support_token')).toBe('777:help-token');
    await controller.updateSupport({ token: '' }, request);
    await expect(controller.support()).resolves.toMatchObject({ supportBot: null });
  });

  it('refuses a token Telegram does not know, and the shop bot’s own', async () => {
    const { controller, request } = harness();
    await expect(
      controller.updateSupport({ token: '999:nope-token' }, request),
    ).rejects.toMatchObject({ response: { error: { code: 'SUPPORT_BOT_INVALID' } } });
    await expect(
      controller.updateSupport({ token: '123:shop-token' }, request),
    ).rejects.toMatchObject({ response: { error: { code: 'SUPPORT_BOT_SAME' } } });
  });
});
