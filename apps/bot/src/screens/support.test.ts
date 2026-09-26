import { describe, expect, it, vi } from 'vitest';

import { ApiClientError } from '../api-client.js';
import { endSupport, showSupport } from './index.js';
import type { RrContext } from '../types.js';

function screen(
  supportForwardChatId: number | null,
  supportContact = '@manta_help',
  supportBot: { username: string } | null = null,
) {
  const params: Record<string, unknown>[] = [];
  const shown: Array<{ text: string; buttons: string[]; urls: string[] }> = [];
  const ctx = {
    from: { id: 123 },
    session: {},
    t: (key: string, values: Record<string, unknown> = {}) => {
      params.push({ key, ...values });
      return key;
    },
    reply: (
      text: string,
      options: {
        reply_markup?: { inline_keyboard: Array<Array<{ callback_data?: string; url?: string }>> };
      },
    ) => {
      const buttons = (options.reply_markup?.inline_keyboard ?? []).flat();
      shown.push({
        text,
        buttons: buttons.map((button) => button.callback_data ?? ''),
        urls: buttons.flatMap((button) => (button.url ? [button.url] : [])),
      });
      return { message_id: 1 };
    },
  } as unknown as RrContext;
  const api = {
    getConfig: () => ({ supportForwardChatId, supportContact, supportBot }),
    openSupport: vi.fn().mockResolvedValue(undefined),
    closeSupport: vi.fn().mockResolvedValue(undefined),
  };
  return { ctx, api, params, shown };
}

describe('bot support screen (FR-124)', () => {
  it('shows the support contact when no operators chat is configured', async () => {
    const { ctx, api, params } = screen(null);
    await showSupport(ctx, api as never);
    expect(api.openSupport).not.toHaveBeenCalled();
    expect(params).toContainEqual({ key: 'bot.screen.support.details', contact: '@manta_help' });
  });

  it('opens a conversation with the operators until «Завершить» (F35)', async () => {
    const { ctx, api, shown } = screen(-100500);
    await showSupport(ctx, api as never);
    expect(api.openSupport).toHaveBeenCalledWith(123);
    expect(shown[0]?.text).toContain('bot.screen.support.open');
    expect(shown[0]?.text).toContain('bot.screen.support.details');
    expect(shown[0]?.buttons).toEqual(['support:end', 'home']);

    await endSupport(ctx, api as never);
    expect(api.closeSupport).toHaveBeenCalledWith(123);
    expect(shown[1]?.text).toBe('bot.screen.support.ended');
  });

  it('falls back to the contact when the operators cannot be reached', async () => {
    const { ctx, api, shown } = screen(-100500);
    api.openSupport.mockRejectedValue(new ApiClientError(409, 'SUPPORT_UNAVAILABLE'));
    await showSupport(ctx, api as never);
    expect(shown[0]?.text).toBe('bot.screen.support.details');
  });

  it('sends the customer to the support bot when one is configured (F35)', async () => {
    const { ctx, api, shown, params } = screen(-100500, '@manta_help', {
      username: 'manta_help_bot',
    });
    await showSupport(ctx, api as never);
    expect(api.openSupport).not.toHaveBeenCalled();
    expect(params).toContainEqual({ key: 'bot.screen.support.bot', username: 'manta_help_bot' });
    expect(shown[0]?.urls).toEqual(['https://t.me/manta_help_bot']);
  });
});
