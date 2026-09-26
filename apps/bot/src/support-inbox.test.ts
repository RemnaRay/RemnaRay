import { describe, expect, it, vi } from 'vitest';

import { ApiClientError } from './api-client.js';
import { supportInbox } from './support-inbox.js';
import type { RrContext } from './types.js';

function message(fields: Record<string, unknown>, chatType = 'private') {
  const reply = vi.fn().mockResolvedValue({});
  const ctx = {
    chat: { id: 42, type: chatType },
    from: { id: 42 },
    message: { message_id: 5, ...fields },
    t: (key: string) => key,
    reply,
  } as unknown as RrContext;
  return { ctx, reply };
}

describe('support inbox (FR-124, F35)', () => {
  it('hands the operators a photo, file, voice or text of an open conversation', async () => {
    const forwardSupport = vi.fn().mockResolvedValue({ acknowledge: false });
    const inbox = supportInbox({ forwardSupport });
    for (const fields of [
      { text: 'It does not connect' },
      { photo: [{ file_id: 'p1' }] },
      { document: { file_id: 'd1' } },
      { voice: { file_id: 'v1' } },
    ]) {
      const { ctx, reply } = message(fields);
      const next = vi.fn();
      await inbox(ctx, next);
      expect(next).not.toHaveBeenCalled();
      expect(reply).not.toHaveBeenCalled();
    }
    expect(forwardSupport).toHaveBeenCalledTimes(4);
    expect(forwardSupport).toHaveBeenCalledWith(42, 5, { requireOpen: true });
  });

  it('confirms the first message after «Поддержка»', async () => {
    const inbox = supportInbox({
      forwardSupport: vi.fn().mockResolvedValue({ acknowledge: true }),
    });
    const { ctx, reply } = message({ text: 'Hello' });
    await inbox(ctx, vi.fn());
    expect(reply).toHaveBeenCalledWith('bot.screen.support.sent');
  });

  it('leaves a message outside a conversation, a command and a group message alone', async () => {
    const forwardSupport = vi.fn().mockRejectedValue(new ApiClientError(409, 'SUPPORT_CLOSED'));
    const inbox = supportInbox({ forwardSupport });
    for (const [fields, chatType] of [
      [{ text: 'hello' }, 'private'],
      [{ text: '/unknown' }, 'private'],
      [{ text: 'hello' }, 'supergroup'],
    ] as const) {
      const { ctx, reply } = message(fields, chatType);
      const next = vi.fn();
      await inbox(ctx, next);
      expect(next).toHaveBeenCalled();
      expect(reply).not.toHaveBeenCalled();
    }
    expect(forwardSupport).toHaveBeenCalledTimes(1);
  });

  it('says so when the message did not reach the operators', async () => {
    const inbox = supportInbox({
      forwardSupport: vi.fn().mockRejectedValue(new ApiClientError(502, 'SUPPORT_UNAVAILABLE')),
    });
    const { ctx, reply } = message({ text: 'Hello' });
    await inbox(ctx, vi.fn());
    expect(reply).toHaveBeenCalledWith('bot.error.support_unavailable');
  });

  it('points to the support bot when support moved there during a conversation (F35)', async () => {
    const t = vi.fn((key: string) => key);
    const inbox = supportInbox({
      forwardSupport: vi.fn().mockRejectedValue(
        new ApiClientError(409, 'SUPPORT_MOVED', {
          error: { code: 'SUPPORT_MOVED', details: { username: 'manta_help_bot' } },
        }),
      ),
    });
    const { ctx, reply } = message({ text: 'Hello' });
    (ctx as unknown as { t: typeof t }).t = t;
    await inbox(ctx, vi.fn());
    expect(t).toHaveBeenCalledWith('bot.screen.support.bot', { username: 'manta_help_bot' });
    expect(reply).toHaveBeenCalledWith('bot.screen.support.bot');
  });
});
