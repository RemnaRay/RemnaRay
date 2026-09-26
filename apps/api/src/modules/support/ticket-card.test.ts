import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { formatMessage } from '@remnaray/i18n-core';
import { describe, expect, it } from 'vitest';

import type { CardData } from './card-data';
import { cardKeyboard, cardText, formats, topicName } from './ticket-card';

const ru = JSON.parse(
  readFileSync(join(__dirname, '../../../../../locales/ru/bot.json'), 'utf8'),
) as Record<string, string>;
const t = (key: string, values: Record<string, unknown> = {}) =>
  formatMessage('ru', ru, key, values);

function data(overrides: Partial<CardData> = {}): CardData {
  return {
    ticket: {
      number: 128n,
      status: 'in_progress',
      assigneeName: 'Olga',
      createdAt: new Date('2026-09-27T10:00:00Z'),
      closedAt: null,
      closedSilently: false,
      rating: null,
    },
    user: {
      id: 'u1',
      telegramId: '42',
      firstName: 'Anna <b>',
      username: 'anna',
      language: 'ru',
      createdAt: new Date('2026-09-01T09:30:00Z'),
      lastSeenAt: new Date('2026-09-27T09:55:00Z'),
      isBanned: false,
      botBlocked: true,
      trialUsed: true,
      notes: 'VIP',
      referrer: '@bob',
    },
    subscription: {
      status: 'active',
      plan: 'Месяц',
      expiresAt: new Date('2026-10-18T00:00:00Z'),
      usedBytes: 13_207_024_435n,
      limitBytes: 0n,
      deviceLimit: 3,
      url: 'https://sub.example.test/abc',
    },
    money: {
      balanceMinor: 15_000n,
      lastPurchase: {
        plan: 'Месяц',
        amountMinor: 29_900n,
        at: new Date('2026-09-20T12:00:00Z'),
        provider: 'balance',
      },
      receivedMinor: 120_000n,
      payments: 4,
      pendingInvoices: 1,
    },
    support: {
      tickets: 3,
      previous: { number: 120n, at: new Date('2026-09-01T12:00:00Z'), rating: 4 },
    },
    ...overrides,
  };
}

describe('the ticket card (F36)', () => {
  const f = formats('ru', 'Europe/Moscow');

  it('shows the ticket, the customer, the subscription, money and support history', () => {
    const text = cardText(data(), t, f);
    expect(text).toContain('🎫 <b>Тикет #128</b> · 🟡 в работе');
    expect(text).toContain('В работе у: Olga');
    // What the customer typed as their name is shown, not interpreted.
    expect(text).toContain('<b>Anna &lt;b&gt;</b> @anna · <code>42</code> · ru');
    expect(text).toContain('Пригласил: @bob');
    expect(text).toContain('🚫 заблокировал бота · пробный период использован');
    expect(text).toContain('📦 Подписка: активна · Месяц · до 18.10.2026, 03:00');
    expect(text).toContain('Трафик: 12,3 GB из ∞ · устройств: 3');
    expect(text).toContain('Ссылка: https://sub.example.test/abc');
    expect(text).toContain('💰 Баланс: 150');
    expect(text).toContain('Последняя покупка: Месяц · 299');
    expect(text).toContain('с баланса');
    expect(text).toContain('(4 оплаты) · неоплаченных счетов: 1');
    expect(text).toContain('🆘 Обращений: 3 · прошлое #120 от 01.09.2026, 15:00, оценка ★4');
    expect(text).toContain('📝 Заметка: VIP');
  });

  it('says so when the customer has no subscription and it is their first request', () => {
    const text = cardText(
      data({ subscription: null, support: { tickets: 1, previous: null } }),
      t,
      f,
    );
    expect(text).toContain('📦 Подписки нет');
    expect(text).toContain('🆘 Первое обращение');
  });

  it('offers «Взять» until the ticket is taken, and only refresh once it is closed', () => {
    const url = 'https://shop.example.test/admin/users/u1';
    const id = '00000000-0000-4000-8000-000000000001';
    const open = cardKeyboard({ id, status: 'open', takenAt: null }, t, url);
    expect(open.inline_keyboard.flat().map((button) => button.text)).toEqual([
      '🙋 Взять в работу',
      '✅ Закрыть',
      '🤫 Закрыть тихо',
      '🔄 Обновить',
      '🖥 В консоли',
    ]);
    const taken = cardKeyboard({ id, status: 'in_progress', takenAt: new Date() }, t, url);
    expect(taken.inline_keyboard.flat()).toHaveLength(4);
    const closed = cardKeyboard({ id, status: 'closed', takenAt: new Date() }, t, url);
    expect(closed.inline_keyboard.flat()).toEqual([
      { text: '🔄 Обновить', callback_data: `st:card:${id}` },
      { text: '🖥 В консоли', url },
    ]);
    // Telegram's limit for callback data.
    expect(Buffer.byteLength(`st:silent:${id}`)).toBeLessThanOrEqual(64);
  });

  it('names the topic with the status, the name and the id', () => {
    const user = { firstName: null, username: 'anna', telegramId: '42' };
    expect(topicName('open', user)).toBe('🟢 anna · 42');
    expect(topicName('in_progress', { ...user, firstName: 'Anna' })).toBe('🟡 Anna · 42');
    expect(
      topicName('closed', { firstName: 'x'.repeat(200), username: null, telegramId: '1' }),
    ).toHaveLength(128);
  });
});
