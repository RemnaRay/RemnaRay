import { describe, expect, it, vi } from 'vitest';

import { RATING_DATA, rateTicket, ratingKeyboard } from './support-rating.js';
import type { RrContext } from './types.js';

const id = '00000000-0000-4000-8000-000000000001';

function press(data: string) {
  const reply = vi.fn().mockResolvedValue({});
  const editMessageReplyMarkup = vi.fn().mockResolvedValue(true);
  const ctx = {
    from: { id: 42 },
    callbackQuery: { data },
    t: (key: string) => key,
    reply,
    editMessageReplyMarkup,
  } as unknown as RrContext;
  return { ctx, reply, editMessageReplyMarkup };
}

describe('ticket rating (F36)', () => {
  it('offers five stars carrying the ticket', () => {
    const buttons = ratingKeyboard(id).inline_keyboard.flat();
    expect(buttons.map((button) => button.text)).toEqual(['1★', '2★', '3★', '4★', '5★']);
    expect(buttons[4]).toMatchObject({ callback_data: `rate:${id}:5` });
    expect(RATING_DATA.test(`rate:${id}:5`)).toBe(true);
    expect(RATING_DATA.test(`rate:${id}:6`)).toBe(false);
  });

  it('thanks for the first rating, says when it was already counted, and drops the stars', async () => {
    const rateSupport = vi
      .fn()
      .mockResolvedValueOnce({ accepted: true, number: 3 })
      .mockResolvedValue({ accepted: false, number: 3 });
    const handler = rateTicket({ rateSupport });
    const first = press(`rate:${id}:4`);
    await handler(first.ctx);
    expect(rateSupport).toHaveBeenCalledWith(42, id, 4);
    expect(first.reply).toHaveBeenCalledWith('bot.support.rate.thanks');
    expect(first.editMessageReplyMarkup).toHaveBeenCalled();

    const second = press(`rate:${id}:1`);
    await handler(second.ctx);
    expect(second.reply).toHaveBeenCalledWith('bot.support.rate.already');
  });
});
