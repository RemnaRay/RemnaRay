import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { NotifyService, notificationButtons } from './notify.service';

const catalog: Record<string, string> = {
  'notify.sub.expires_in_3d': 'Подписка заканчивается через 3 дня — {until}.',
  'notify.sub.expires_in_1d': 'Подписка заканчивается завтра — {until}.',
  'notify.trial.expires_in_1d': 'Пробный доступ заканчивается завтра.',
  'notify.btn.renew': 'Продлить',
  'notify.btn.buy': 'Купить',
  'notify.btn.buyPlan': 'Купить «{plan}»',
  'notify.btn.balance': 'Баланс',
  'notify.btn.plans': 'Тарифы',
  'notify.payment.to_balance': 'Баланс пополнен на {amount}. {plan}',
  'alerts.title': 'RemnaRay: {type}',
  'alerts.panel.down': 'Панель недоступна более 5 минут.',
};

type UserOverrides = Partial<{
  isBanned: boolean;
  botBlockedAt: Date | null;
  marketingOptOut: boolean;
  language: string;
}>;

function fixture(
  options: {
    user?: UserOverrides;
    lockTaken?: boolean;
    sendStatus?: number;
    messages?: Record<string, string>;
  } = {},
) {
  const log: Record<string, unknown>[] = [];
  const sent: unknown[] = [];
  const user = {
    id: '11111111-1111-7111-8111-111111111111',
    telegramId: 123n,
    language: 'ru',
    isBanned: false,
    botBlockedAt: null as Date | null,
    marketingOptOut: false,
    ...options.user,
  };
  const db = {
    user: {
      findUnique: vi.fn().mockResolvedValue(user),
      update: vi.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => {
        Object.assign(user, data);
        return Promise.resolve(user);
      }),
    },
    notificationLog: {
      create: vi.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => {
        if (
          log.some(
            (row) => row['dedupKey'] === data['dedupKey'] && row['userId'] === data['userId'],
          )
        )
          return Promise.reject(Object.assign(new Error('unique violation'), { code: 'P2002' }));
        log.push(data);
        return Promise.resolve(data);
      }),
      findFirst: vi
        .fn()
        .mockImplementation(({ where }: { where: Record<string, unknown> }) =>
          Promise.resolve(
            log.find(
              (row) => row['dedupKey'] === where['dedupKey'] && row['userId'] === where['userId'],
            ) ?? null,
          ),
        ),
    },
    subscription: { findMany: vi.fn().mockResolvedValue([]) },
    admin: { findMany: vi.fn().mockResolvedValue([{ telegramId: 777n }]) },
  };
  const locks = new Set<string>();
  const redis = {
    set: vi
      .fn()
      .mockImplementation(
        (key: string, _value: string, _mode: string, _ttl: number, flag?: string) => {
          if (key.startsWith('rr:alert:')) return Promise.resolve(options.lockTaken ? null : 'OK');
          if (flag === 'NX' && locks.has(key)) return Promise.resolve(null);
          locks.add(key);
          return Promise.resolve('OK');
        },
      ),
    del: vi.fn().mockImplementation((key: string) => {
      locks.delete(key);
      return Promise.resolve(1);
    }),
  };
  const settings = {
    get: (key: string) =>
      Promise.resolve(key === 'bot.token' ? 'bot-token' : key === 'admin.language' ? 'ru' : ''),
  };
  const i18n = { messages: () => Promise.resolve({ ...catalog, ...options.messages }) };

  const previousFetch = globalThis.fetch;
  globalThis.fetch = ((_input: unknown, init?: { body?: string }) => {
    sent.push(JSON.parse(init?.body ?? '{}'));
    const status = options.sendStatus ?? 200;
    return Promise.resolve(new Response('{}', { status }));
  }) as typeof fetch;

  return {
    db,
    log,
    sent,
    redis,
    restore: () => {
      globalThis.fetch = previousFetch;
    },
    service: new NotifyService({ db, redis } as never, settings as never, i18n as never),
  };
}

describe('NotifyService', () => {
  it('sends a rendered notification once per dedup key (AC-160)', async () => {
    const test = fixture();
    try {
      const first = await test.service.send({
        event: 'sub.expires_in_3d',
        userId: '11111111-1111-7111-8111-111111111111',
        dedupKey: 'sub.expires_in_3d:sub-1',
        params: { until: '2026-10-01' },
      });
      const second = await test.service.send({
        event: 'sub.expires_in_3d',
        userId: '11111111-1111-7111-8111-111111111111',
        dedupKey: 'sub.expires_in_3d:sub-1',
        params: { until: '2026-10-01' },
      });

      expect(first).toEqual({ status: 'sent' });
      expect(second).toEqual({ status: 'duplicate' });
      expect(test.sent).toHaveLength(1);
      expect(test.sent[0]).toMatchObject({
        chat_id: '123',
        parse_mode: 'HTML',
        text: 'Подписка заканчивается через 3 дня — 2026-10-01.',
      });
      expect(test.log[0]).toMatchObject({ status: 'sent' });
    } finally {
      test.restore();
    }
  });

  it('never delivers to a blocked or banned user', async () => {
    const blocked = fixture({ user: { botBlockedAt: new Date() } });
    try {
      await expect(
        blocked.service.send({
          event: 'sub.expired',
          userId: '11111111-1111-7111-8111-111111111111',
          dedupKey: 'sub.expired:sub-1',
        }),
      ).resolves.toEqual({ status: 'skipped_blocked' });
      expect(blocked.sent).toHaveLength(0);
    } finally {
      blocked.restore();
    }

    const banned = fixture({ user: { isBanned: true } });
    try {
      await expect(
        banned.service.send({
          event: 'sub.expired',
          userId: '11111111-1111-7111-8111-111111111111',
          dedupKey: 'sub.expired:sub-2',
        }),
      ).resolves.toEqual({ status: 'skipped' });
    } finally {
      banned.restore();
    }
  });

  it('marks the user blocked when Telegram answers 403', async () => {
    const test = fixture({ sendStatus: 403 });
    try {
      await expect(
        test.service.send({
          event: 'sub.expired',
          userId: '11111111-1111-7111-8111-111111111111',
          dedupKey: 'sub.expired:sub-3',
        }),
      ).resolves.toEqual({ status: 'skipped_blocked' });
      expect(test.db.user.update).toHaveBeenCalled();
    } finally {
      test.restore();
    }
  });

  it('picks the right expiry event per window and source', async () => {
    const test = fixture();
    const now = new Date('2026-09-20T00:00:00.000Z');
    test.db.subscription.findMany.mockResolvedValue([
      {
        id: '22222222-2222-7222-8222-222222222222',
        userId: '11111111-1111-7111-8111-111111111111',
        source: 'purchase',
        expiresAt: new Date(now.getTime() + 2.9 * 86_400_000),
      },
      {
        id: '33333333-3333-7333-8333-333333333333',
        userId: '11111111-1111-7111-8111-111111111111',
        source: 'purchase',
        expiresAt: new Date(now.getTime() + 0.5 * 86_400_000),
      },
      {
        id: '44444444-4444-7444-8444-444444444444',
        userId: '11111111-1111-7111-8111-111111111111',
        source: 'trial',
        expiresAt: new Date(now.getTime() + 0.4 * 86_400_000),
      },
    ]);
    try {
      await expect(test.service.scanExpiring(now)).resolves.toEqual({ queued: 3 });
      expect(test.log.map((row) => row['event'])).toEqual([
        'sub.expires_in_3d',
        'sub.expires_in_1d',
        'trial.expires_in_1d',
      ]);

      // A repeated window queues nothing new (AC-160).
      await expect(test.service.scanExpiring(now)).resolves.toEqual({ queued: 0 });
      expect(test.sent).toHaveLength(3);
    } finally {
      test.restore();
    }
  });

  it('deduplicates administrator alerts to one per type per hour (AC-163)', async () => {
    const first = fixture();
    try {
      await expect(first.service.alert({ type: 'panel.down' })).resolves.toEqual({
        delivered: 1,
        deduplicated: false,
      });
      expect(first.redis.set).toHaveBeenCalledWith('rr:alert:panel.down', '1', 'EX', 3600, 'NX');
      expect(first.sent[0]).toMatchObject({ chat_id: '777' });
    } finally {
      first.restore();
    }

    const repeated = fixture({ lockTaken: true });
    try {
      await expect(repeated.service.alert({ type: 'panel.down' })).resolves.toEqual({
        delivered: 0,
        deduplicated: true,
      });
      expect(repeated.sent).toHaveLength(0);
    } finally {
      repeated.restore();
    }
  });
});

describe('payment.to_balance buttons (F37)', () => {
  it('offers the plan the top-up was for', () => {
    expect(
      notificationButtons('payment.to_balance', {
        hasPlan: 'yes',
        plan: 'Месяц',
        buyInvoice: '01a0ded7-ef45-767a-bbf5-fbd98a0d8762',
      }),
    ).toEqual([
      { key: 'buyPlan', callback: 'tb:01a0ded7-ef45-767a-bbf5-fbd98a0d8762' },
      { key: 'balance', callback: 'balance' },
    ]);
  });

  it('offers the plans after a plain top-up', () => {
    expect(
      notificationButtons('payment.to_balance', { hasPlan: 'no', plan: '', buyInvoice: '' }),
    ).toEqual([
      { key: 'plans', callback: 'plans' },
      { key: 'balance', callback: 'balance' },
    ]);
  });

  it('delivers the buy button with the plan name', async () => {
    const test = fixture();
    try {
      await test.service.send({
        event: 'payment.to_balance',
        userId: '11111111-1111-7111-8111-111111111111',
        dedupKey: 'payment.to_balance:inv-1',
        params: {
          amount: '100',
          hasPlan: 'yes',
          plan: 'Месяц',
          buyInvoice: '01a0ded7-ef45-767a-bbf5-fbd98a0d8762',
        },
      });
      expect(JSON.stringify(test.sent[0])).toContain('"text":"Купить «Месяц»"');
      expect(JSON.stringify(test.sent[0])).toContain(
        '"callback_data":"tb:01a0ded7-ef45-767a-bbf5-fbd98a0d8762"',
      );
    } finally {
      test.restore();
    }
  });

  it('keeps the plan name verbatim in the button and escaped in the body', async () => {
    const test = fixture();
    try {
      await test.service.send({
        event: 'payment.to_balance',
        userId: '11111111-1111-7111-8111-111111111111',
        dedupKey: 'payment.to_balance:inv-2',
        params: {
          amount: '100',
          hasPlan: 'yes',
          plan: "Tom & Jerry's",
          buyInvoice: '01a0ded7-ef45-767a-bbf5-fbd98a0d8762',
        },
      });
      expect(test.sent[0]).toMatchObject({
        text: 'Баланс пополнен на 100. Tom &amp; Jerry&#39;s',
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "Купить «Tom & Jerry's»",
                callback_data: 'tb:01a0ded7-ef45-767a-bbf5-fbd98a0d8762',
              },
              { text: 'Баланс', callback_data: 'balance' },
            ],
          ],
        },
      });
    } finally {
      test.restore();
    }
  });

  // Queued before the F37 deploy: the job carries `{amount}` only, the text now selects on more.
  it('delivers a payment.to_balance queued with the amount only', async () => {
    const ru = JSON.parse(
      readFileSync(join(__dirname, '../../../../../locales/ru/notify.json'), 'utf8'),
    ) as Record<string, string>;
    const test = fixture({
      messages: {
        'notify.payment.to_balance': ru['notify.payment.to_balance'] ?? '',
        'notify.btn.buyPlan': ru['notify.btn.buyPlan'] ?? '',
      },
    });
    try {
      await expect(
        test.service.send({
          event: 'payment.to_balance',
          userId: '11111111-1111-7111-8111-111111111111',
          dedupKey: 'payment.to_balance:inv-old',
          params: { amount: '150 ₽' },
        }),
      ).resolves.toEqual({ status: 'sent' });
      expect(test.sent[0]).toMatchObject({
        text: 'Баланс пополнен на 150 ₽.',
        reply_markup: {
          inline_keyboard: [
            [
              { text: 'Тарифы', callback_data: 'plans' },
              { text: 'Баланс', callback_data: 'balance' },
            ],
          ],
        },
      });
    } finally {
      test.restore();
    }
  });
});
