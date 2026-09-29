import { createHash, createHmac, randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Infrastructure } from '../../infra/infra.module';
import { encryptSetting } from '../settings/settings.crypto';
import { PaymentError } from './payments.errors';
import type { PaymentsRepository } from './payments.repository';
import { createPaymentProviderRegistry } from './payments.registry';
import { PaymentsService } from './payments.service';

function harness() {
  const db = {
    paymentProvider: {
      findUnique: vi.fn().mockResolvedValue({ code: 'stars', enabled: true, configEnc: null }),
    },
    invoice: { findFirst: vi.fn().mockResolvedValue({ id: 'invoice-1' }) },
    outboxJob: { create: vi.fn() },
  };
  const repository = {
    insertEvent: vi.fn().mockResolvedValue({ id: 'event-1', duplicate: false }),
    applyEvent: vi.fn(),
  };
  const service = new PaymentsService(
    { db } as unknown as Infrastructure,
    repository as unknown as PaymentsRepository,
    createPaymentProviderRegistry({}),
  );
  return { db, repository, service };
}

/** What anyone on the internet could POST at `/webhooks/stars`. */
const forgedStarsUpdate = Buffer.from(
  JSON.stringify({
    message: {
      successful_payment: {
        invoice_payload: 'invoice-1',
        total_amount: 1,
        currency: 'XTR',
        telegram_payment_charge_id: 'forged-charge',
      },
    },
  }),
);

describe('PaymentsService.receiveWebhook (sections 9.7, 11.3.6)', () => {
  it('refuses an HTTP webhook for Telegram Stars before storing or applying anything', async () => {
    const { db, repository, service } = harness();

    await expect(
      service.receiveWebhook('stars', forgedStarsUpdate, {}, '203.0.113.7'),
    ).rejects.toMatchObject({ name: 'PaymentError', code: 'WEBHOOK_NOT_SUPPORTED' });

    expect(repository.insertEvent).not.toHaveBeenCalled();
    expect(repository.applyEvent).not.toHaveBeenCalled();
    expect(db.outboxJob.create).not.toHaveBeenCalled();
  });

  it('refuses the other providers without an HTTP webhook the same way', async () => {
    for (const code of ['platega', 'balance']) {
      const { repository, service } = harness();
      await expect(
        service.receiveWebhook(code, Buffer.from('{}'), {}, '203.0.113.7'),
      ).rejects.toMatchObject({ code: 'WEBHOOK_NOT_SUPPORTED' });
      expect(repository.insertEvent).not.toHaveBeenCalled();
    }
  });
});

describe('PaymentsService.receiveWebhook storage masks (section 19.1, R28)', () => {
  it('stores a Robokassa event without its signature or the request`s secrets', async () => {
    const { db, repository, service } = harness();
    db.paymentProvider.findUnique.mockResolvedValue({
      code: 'robokassa',
      enabled: true,
      configEnc: null,
    });
    repository.applyEvent.mockResolvedValue(undefined);
    // An unconfigured Password2 is empty, so this signature verifies.
    const signature = createHash('md5').update('299.00:17::Shp_user=u1').digest('hex');
    const body = Buffer.from(
      `OutSum=299.00&InvId=17&Shp_user=u1&SignatureValue=${signature}&token=bodytoken`,
    );

    await service.receiveWebhook(
      'robokassa',
      body,
      {
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': 'Robokassa',
        'x-request-id': 'req-1',
        cookie: 'rr_sid=session',
        authorization: 'Bearer secret',
        signature: 'lava-signature',
        'crypto-pay-api-signature': 'cryptobot-signature',
        'x-secret': 'shared-secret',
      },
      '185.59.216.65',
    );

    const stored = repository.insertEvent.mock.calls[0]?.[0] as {
      raw: Record<string, unknown>;
      headers: Record<string, unknown>;
      signatureOk: boolean;
    };
    expect(stored.signatureOk).toBe(true);
    expect(stored.raw).toMatchObject({ OutSum: '299.00', InvId: '17', Shp_user: 'u1' });
    expect(JSON.stringify(stored.raw)).not.toContain(signature);
    expect(JSON.stringify(stored.raw)).not.toContain('bodytoken');
    expect(stored.headers).toEqual({
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': 'Robokassa',
      'x-request-id': 'req-1',
      ip: '185.59.216.65',
    });
  });
});

describe('PaymentsService provider configuration', () => {
  const appKey = randomBytes(32).toString('base64');
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('reads the configuration the console and the setup wizard store', async () => {
    vi.stubEnv('RR_APP_KEY', appKey);
    vi.stubEnv('RR_TELEGRAM_API_URL', 'http://telegram.test');
    const requests: string[] = [];
    vi.stubGlobal('fetch', (url: string) => {
      requests.push(url);
      return Promise.resolve(Response.json({ ok: true, result: 'https://t.me/$link' }));
    });
    const db = {
      paymentProvider: {
        findUnique: vi.fn().mockResolvedValue({
          code: 'stars',
          enabled: true,
          lastHealthcheckOk: true,
          // Exactly what ProvidersService.update and SetupService write.
          configEnc: encryptSetting({ starsPerRub: 0.75 }, appKey).enc,
        }),
      },
      user: {
        findUniqueOrThrow: vi
          .fn()
          .mockResolvedValue({ id: 'user-1', telegramId: 42n, email: null, language: 'ru' }),
      },
      $queryRaw: vi.fn().mockResolvedValue([{ id: '0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee' }]),
    };
    const repository = {
      findByIdempotencyKey: vi.fn().mockResolvedValue(null),
      createInvoice: vi
        .fn()
        .mockImplementation((input: Record<string, unknown>) =>
          Promise.resolve({ ...input, status: 'pending' }),
        ),
      findInvoice: vi.fn().mockResolvedValue({ id: 'found' }),
      nextInvoiceNumber: vi.fn().mockResolvedValue('06-00001'),
    };
    const service = new PaymentsService(
      { db } as unknown as Infrastructure,
      repository as unknown as PaymentsRepository,
      createPaymentProviderRegistry({}),
      {
        get: (key: string) => Promise.resolve(key === 'bot.token' ? '123:bot' : undefined),
      } as never,
    );

    await service.createInvoice({
      userId: 'user-1',
      kind: 'topup',
      provider: 'stars',
      amountMinor: 10000n,
      idempotencyKey: 'key-1',
    });

    expect(requests).toEqual(['http://telegram.test/bot123:bot/createInvoiceLink']);
    expect(repository.createInvoice).toHaveBeenCalledWith(
      expect.objectContaining({
        id: '0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee',
        providerInvoiceId: 'inv_0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee',
        providerAmount: '75',
        providerCurrency: 'XTR',
        paymentUrl: 'https://t.me/$link',
        number: '06-00001',
      }),
    );
    // Section 11.4: Stars invoices live `invoice.ttl_minutes_crypto`, 60 by default.
    const [created] = repository.createInvoice.mock.calls[0] as [{ expiresAt: Date }];
    const minutes = (created.expiresAt.getTime() - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(59);
    expect(minutes).toBeLessThanOrEqual(60);
  });
});

describe('PaymentsService.recheck (section 7.3 status polling)', () => {
  const appKey = randomBytes(32).toString('base64');
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('stores the amount a poll reports in roubles, so EX-12 sees an underpayment', async () => {
    vi.stubEnv('RR_APP_KEY', appKey);
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        Response.json({
          ok: true,
          result: { items: [{ status: 'paid', amount: '150.00', fiat: 'RUB' }] },
        }),
      ),
    );
    const db = {
      paymentProvider: {
        findUnique: vi.fn().mockResolvedValue({
          code: 'cryptobot',
          enabled: true,
          configEnc: encryptSetting({ token: 't', baseUrl: 'http://cryptobot.test/api' }, appKey)
            .enc,
        }),
      },
    };
    const repository = {
      findInvoice: vi
        .fn()
        .mockResolvedValue({ id: 'invoice-1', provider: 'cryptobot', providerInvoiceId: '77' }),
      insertEvent: vi.fn().mockResolvedValue({ id: 'event-1', duplicate: false }),
      applyEvent: vi.fn(),
    };
    const service = new PaymentsService(
      { db } as unknown as Infrastructure,
      repository as unknown as PaymentsRepository,
      createPaymentProviderRegistry({}),
    );

    await service.recheck('invoice-1');

    expect(repository.insertEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        externalId: 'poll:77:paid',
        raw: expect.objectContaining({ paidAmountMinorRub: '15000' }) as object,
      }),
    );
    expect(repository.applyEvent).toHaveBeenCalledWith('event-1');
  });
});

describe('PaymentsService.recheck limit (FR-064, F30)', () => {
  const appKey = randomBytes(32).toString('base64');
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  function harness(fetchImpl: () => Promise<Response>) {
    vi.stubEnv('RR_APP_KEY', appKey);
    vi.stubGlobal('fetch', fetchImpl);
    const db = {
      invoice: { findMany: vi.fn().mockResolvedValue([{ id: 'invoice-1' }]) },
      paymentProvider: {
        findUnique: vi.fn().mockResolvedValue({
          code: 'cryptobot',
          enabled: true,
          configEnc: encryptSetting({ token: 't', baseUrl: 'http://cryptobot.test/api' }, appKey)
            .enc,
        }),
      },
    };
    const repository = {
      findInvoice: vi.fn().mockResolvedValue({
        id: 'invoice-1',
        provider: 'cryptobot',
        providerInvoiceId: '77',
        status: 'pending',
      }),
      insertEvent: vi.fn().mockResolvedValue({ id: 'event-1', duplicate: false }),
      applyEvent: vi.fn(),
    };
    return new PaymentsService(
      { db } as unknown as Infrastructure,
      repository as unknown as PaymentsRepository,
      createPaymentProviderRegistry({}),
    );
  }
  const active = () =>
    Promise.resolve(Response.json({ ok: true, result: { items: [{ status: 'active' }] } }));

  it('leaves the customer’s check free after the worker’s background poll', async () => {
    const service = harness(active);
    await expect(service.pollPending()).resolves.toBe(1);
    await expect(service.recheck('invoice-1')).resolves.toMatchObject({ id: 'invoice-1' });
  });

  it('refuses a second check of one invoice within 10 seconds', async () => {
    const service = harness(active);
    await service.recheck('invoice-1');
    await expect(service.recheck('invoice-1')).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('names a provider that did not answer', async () => {
    const service = harness(() => Promise.reject(new Error('connect ECONNREFUSED')));
    await expect(service.recheck('invoice-1')).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
    });
  });
});

describe('PaymentsService.recheck of a provider without status polling', () => {
  it('leaves a pending balance invoice as it is instead of asking fetchStatus', async () => {
    const invoice = {
      id: 'invoice-1',
      provider: 'balance',
      providerInvoiceId: 'key-1',
      status: 'pending',
    };
    const registry = createPaymentProviderRegistry({});
    const fetchStatus = vi.spyOn(registry.get('balance'), 'fetchStatus');
    const repository = {
      findInvoice: vi.fn().mockResolvedValue(invoice),
      insertEvent: vi.fn(),
      applyEvent: vi.fn(),
    };
    const service = new PaymentsService(
      { db: {} } as unknown as Infrastructure,
      repository as unknown as PaymentsRepository,
      registry,
    );

    await expect(service.recheck('invoice-1')).resolves.toBe(invoice);
    expect(fetchStatus).not.toHaveBeenCalled();
    expect(repository.insertEvent).not.toHaveBeenCalled();
    expect(repository.applyEvent).not.toHaveBeenCalled();
  });
});

describe('PaymentsService.createInvoice provider availability (FR-061, FR-071, AC-061)', () => {
  function harness(row: Record<string, unknown> | null) {
    const registry = createPaymentProviderRegistry({});
    const create = vi.spyOn(registry.get('yookassa'), 'createInvoice');
    const db = { paymentProvider: { findUnique: vi.fn().mockResolvedValue(row) } };
    const repository = {
      findByIdempotencyKey: vi.fn().mockResolvedValue(null),
      createInvoice: vi.fn(),
    };
    const service = new PaymentsService(
      { db } as unknown as Infrastructure,
      repository as unknown as PaymentsRepository,
      registry,
    );
    return { create, repository, service };
  }

  it.each([
    ['has no row', null],
    ['is disabled', { code: 'yookassa', enabled: false, lastHealthcheckOk: true }],
    ['was never checked', { code: 'yookassa', enabled: true, lastHealthcheckOk: null }],
    ['failed its last check', { code: 'yookassa', enabled: true, lastHealthcheckOk: false }],
  ])('refuses a provider that %s', async (_name, row) => {
    const { create, repository, service } = harness(row);
    await expect(
      service.createInvoice({
        userId: 'user-1',
        kind: 'topup',
        provider: 'yookassa',
        amountMinor: 10000n,
        idempotencyKey: 'key-1',
      }),
    ).rejects.toMatchObject({ name: 'PaymentError', code: 'PROVIDER_UNAVAILABLE' });
    expect(create).not.toHaveBeenCalled();
    expect(repository.createInvoice).not.toHaveBeenCalled();
  });

  it('refuses a top-up paid from the balance itself', async () => {
    const { repository, service } = harness(null);
    await expect(
      service.createInvoice({
        userId: 'user-1',
        kind: 'topup',
        provider: 'balance',
        amountMinor: 10000n,
        idempotencyKey: 'key-1',
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(repository.createInvoice).not.toHaveBeenCalled();
  });
});

describe('PaymentsService.createInvoice URLs handed to the provider', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('returns the payer to /pay/<id> and names the provider webhook path', async () => {
    vi.stubEnv('RR_DOMAIN', 'shop.example');
    const id = '0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee';
    const registry = createPaymentProviderRegistry({ RR_PAYMENTS_MOCK: 'true' });
    const create = vi.spyOn(registry.get('mock'), 'createInvoice');
    const db = {
      paymentProvider: { findUnique: vi.fn().mockResolvedValue(null) },
      user: {
        findUniqueOrThrow: vi
          .fn()
          .mockResolvedValue({ id: 'user-1', telegramId: 42n, email: null, language: 'ru' }),
      },
      $queryRaw: vi.fn().mockResolvedValue([{ id }]),
      outboxJob: { create: vi.fn() },
    };
    const repository = {
      findByIdempotencyKey: vi.fn().mockResolvedValue(null),
      createInvoice: vi
        .fn()
        .mockImplementation((input: Record<string, unknown>) =>
          Promise.resolve({ ...input, status: 'pending' }),
        ),
      findInvoice: vi.fn().mockResolvedValue({ id }),
      nextInvoiceNumber: vi.fn().mockResolvedValue('99-00001'),
    };
    const service = new PaymentsService(
      { db } as unknown as Infrastructure,
      repository as unknown as PaymentsRepository,
      registry,
    );

    await service.createInvoice({
      userId: 'user-1',
      kind: 'topup',
      provider: 'mock',
      amountMinor: 10000n,
      idempotencyKey: 'key-1',
    });

    // FR-134: `/pay/<id>` is the page that shows the invoice; `/pay/success`
    // was read as an invoice named "success".
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        returnUrl: `https://shop.example/pay/${id}`,
        failUrl: `https://shop.example/pay/${id}`,
        webhookUrl: 'https://shop.example/webhooks/mock',
      }),
      expect.anything(),
    );
  });
});

describe('PaymentsService.createInvoice payer-visible description', () => {
  it('names a top-up by the default template when none is set (F37)', async () => {
    const registry = createPaymentProviderRegistry({ RR_PAYMENTS_MOCK: 'true' });
    const create = vi.spyOn(registry.get('mock'), 'createInvoice');
    const db = {
      user: {
        findUniqueOrThrow: vi
          .fn()
          .mockResolvedValue({ id: 'user-1', telegramId: 42n, email: null, language: 'ru' }),
      },
      paymentProvider: { findUnique: vi.fn().mockResolvedValue(null) },
      $queryRaw: vi.fn().mockResolvedValue([{ id: 'invoice-1' }]),
      outboxJob: { create: vi.fn() },
    };
    const repository = {
      findByIdempotencyKey: vi.fn().mockResolvedValue(null),
      createInvoice: vi
        .fn()
        .mockImplementation((input: Record<string, unknown>) =>
          Promise.resolve({ ...input, status: 'pending' }),
        ),
      findInvoice: vi.fn().mockResolvedValue({ id: 'invoice-1' }),
      nextInvoiceNumber: vi.fn().mockResolvedValue('99-00001'),
    };
    const service = new PaymentsService(
      { db } as unknown as Infrastructure,
      repository as unknown as PaymentsRepository,
      registry,
      {
        get: (key: string) =>
          Promise.resolve(
            ({ 'brand.name': 'Manta VPN', 'fiscal.mode': 'none' } as Record<string, unknown>)[key],
          ),
      } as never,
    );

    await service.createInvoice({
      userId: 'user-1',
      kind: 'topup',
      provider: 'mock',
      amountMinor: 10000n,
      idempotencyKey: 'key-1',
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ description: 'Пополнение баланса (#99-00001)' }),
      expect.anything(),
    );
  });
});

describe('PaymentsService.createInvoice Idempotency-Key (sections 9.2, 9.3)', () => {
  const stored = {
    id: 'invoice-a',
    userId: 'user-a',
    kind: 'purchase',
    planId: 'plan-1',
    provider: 'balance',
    amountMinor: 29900n,
    status: 'paid',
  };
  function harness() {
    const registry = createPaymentProviderRegistry({ RR_PAYMENTS_MOCK: 'true' });
    const create = vi.spyOn(registry.get('balance'), 'createInvoice');
    const repository = {
      findByIdempotencyKey: vi.fn().mockResolvedValue(stored),
      createInvoice: vi.fn(),
    };
    const service = new PaymentsService(
      { db: {} } as unknown as Infrastructure,
      repository as unknown as PaymentsRepository,
      registry,
    );
    return { create, repository, service };
  }
  const request = (overrides: Record<string, unknown> = {}) => ({
    userId: 'user-a',
    kind: 'purchase' as const,
    planId: 'plan-1',
    provider: 'balance',
    idempotencyKey: 'key-1',
    ...overrides,
  });

  it('replays the same request of the same user', async () => {
    const { create, service } = harness();
    await expect(service.createInvoice(request())).resolves.toBe(stored);
    expect(create).not.toHaveBeenCalled();
  });

  it('never hands one user the invoice another user created under the key', async () => {
    const { create, service } = harness();
    await expect(service.createInvoice(request({ userId: 'user-b' }))).rejects.toMatchObject({
      name: 'PaymentError',
      code: 'IDEMPOTENCY_KEY_REUSED',
    });
    expect(create).not.toHaveBeenCalled();
  });

  it.each([
    ['another plan', { planId: 'plan-2' }],
    ['another provider', { provider: 'mock' }],
    ['another kind', { kind: 'plan_change' }],
  ])('refuses the key reused for %s', async (_name, overrides) => {
    const { service } = harness();
    await expect(service.createInvoice(request(overrides))).rejects.toMatchObject({
      code: 'IDEMPOTENCY_KEY_REUSED',
    });
  });

  it('refuses the key reused for another top-up amount', async () => {
    const { repository, service } = harness();
    repository.findByIdempotencyKey.mockResolvedValue({
      ...stored,
      kind: 'topup',
      planId: null,
      provider: 'mock',
      amountMinor: 10000n,
    });
    await expect(
      service.createInvoice(
        request({ kind: 'topup', planId: undefined, provider: 'mock', amountMinor: 20000n }),
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });
});

describe('PaymentsService event delivery when the inline apply fails', () => {
  function signed(body: string) {
    return {
      raw: Buffer.from(body),
      headers: {
        'x-mock-signature': createHmac('sha256', 'mock-secret').update(body).digest('hex'),
      },
    };
  }
  function harness() {
    const db = {
      paymentProvider: { findUnique: vi.fn().mockResolvedValue(null) },
      invoice: { findFirst: vi.fn().mockResolvedValue({ id: 'invoice-1' }) },
      outboxJob: { create: vi.fn().mockResolvedValue({}) },
    };
    const repository = {
      insertEvent: vi.fn().mockResolvedValue({ id: 'event-1', duplicate: false }),
      applyEvent: vi.fn().mockRejectedValue(new Error('deadlock detected')),
    };
    const service = new PaymentsService(
      { db } as unknown as Infrastructure,
      repository as unknown as PaymentsRepository,
      createPaymentProviderRegistry({ RR_PAYMENTS_MOCK: 'true' }),
    );
    return { db, repository, service };
  }
  const body = JSON.stringify({
    eventId: 'evt-1',
    providerInvoiceId: 'p-1',
    type: 'paid',
    paidAmountMinorRub: '100',
  });

  it('queues payments.apply-event before trying, so a failed try is retried', async () => {
    const { db, service } = harness();
    const { raw, headers } = signed(body);

    await expect(service.receiveWebhook('mock', raw, headers, '127.0.0.1')).resolves.toMatchObject({
      status: 200,
    });
    expect(db.outboxJob.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        name: 'payments.apply-event',
        jobId: 'evt:event-1',
      }) as object,
    });
  });

  it('applies a redelivered event that is still unprocessed, and asks for another try if it fails', async () => {
    const { repository, service } = harness();
    repository.insertEvent.mockResolvedValue({ id: 'event-1', duplicate: true });
    const { raw, headers } = signed(body);

    await expect(service.receiveWebhook('mock', raw, headers, '127.0.0.1')).rejects.toThrow(
      'deadlock detected',
    );
    expect(repository.applyEvent).toHaveBeenCalledWith('event-1');
  });
});

describe('PaymentsService receipts (FR-062)', () => {
  const appKey = randomBytes(32).toString('base64');
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function robokassaLink(mode: string): Promise<string> {
    vi.stubEnv('RR_APP_KEY', appKey);
    const db = {
      paymentProvider: {
        findUnique: vi.fn().mockResolvedValue({
          code: 'robokassa',
          enabled: true,
          lastHealthcheckOk: true,
          configEnc: encryptSetting(
            { merchantLogin: 'shop', password1: 'p1', password2: 'p2' },
            appKey,
          ).enc,
        }),
      },
      user: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          id: 'user-1',
          telegramId: 42n,
          email: 'buyer@example.test',
          language: 'ru',
        }),
      },
      $queryRaw: vi
        .fn()
        .mockResolvedValue([{ id: '0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee', numericId: 7n }]),
      outboxJob: { create: vi.fn() },
    };
    const repository = {
      findByIdempotencyKey: vi.fn().mockResolvedValue(null),
      createInvoice: vi
        .fn()
        .mockImplementation((input: Record<string, unknown>) =>
          Promise.resolve({ ...input, status: 'pending' }),
        ),
      findInvoice: vi.fn().mockResolvedValue({ id: 'found' }),
      nextInvoiceNumber: vi.fn().mockResolvedValue('04-00001'),
    };
    const settings: Record<string, unknown> = {
      'fiscal.mode': mode,
      'fiscal.vat_code': 1,
      'fiscal.fallback_email': '',
    };
    const service = new PaymentsService(
      { db } as unknown as Infrastructure,
      repository as unknown as PaymentsRepository,
      createPaymentProviderRegistry({}),
      { get: (key: string) => Promise.resolve(settings[key]) } as never,
    );
    await service.createInvoice({
      userId: 'user-1',
      kind: 'topup',
      provider: 'robokassa',
      amountMinor: 29900n,
      idempotencyKey: `receipt-${mode}`,
    });
    const [created] = repository.createInvoice.mock.calls[0] as [{ paymentUrl: string }];
    return created.paymentUrl;
  }

  it('sends the receipt through the provider in provider_receipt mode', async () => {
    expect(new URL(await robokassaLink('provider_receipt')).searchParams.get('Receipt')).toContain(
      'full_payment',
    );
  });

  it('sends no receipt in none mode', async () => {
    expect(new URL(await robokassaLink('none')).searchParams.has('Receipt')).toBe(false);
  });
});

const USER = 'user-1';
const PLAN = '0199aaaa-0000-7000-8000-000000000001';
const OTHER_PLAN = '0199aaaa-0000-7000-8000-000000000002';

/**
 * F37: a service over the mock provider. `receipts` lets the mock take a
 * receipt; `balance` lets the balance cover a purchase.
 */
function setup(
  options: { fiscal?: Record<string, unknown>; receipts?: boolean; balance?: boolean } = {},
) {
  const registry = createPaymentProviderRegistry({ RR_PAYMENTS_MOCK: 'true' });
  const mock = registry.get('mock');
  if (options.receipts) Object.assign(mock.capabilities, { receipts: true });
  const provider = { createInvoice: vi.spyOn(mock, 'createInvoice') };
  const db = {
    paymentProvider: { findUnique: vi.fn().mockResolvedValue(null) },
    user: {
      findUniqueOrThrow: vi.fn().mockResolvedValue({
        id: USER,
        telegramId: 42n,
        email: 'buyer@example.test',
        language: 'ru',
      }),
    },
    plan: {
      findFirst: vi.fn().mockResolvedValue({
        id: PLAN,
        slug: 'premium',
        name: { ru: 'Премиум' },
        priceMinor: 29900n,
        durationDays: 30,
      }),
    },
    $queryRaw: vi.fn().mockResolvedValue([{ id: 'invoice-1', numericId: 7n }]),
    outboxJob: { create: vi.fn() },
  };
  const stored = (input: Record<string, unknown>) => Promise.resolve({ ...input });
  const repository = {
    findByIdempotencyKey: vi.fn().mockResolvedValue(null),
    nextInvoiceNumber: vi.fn().mockResolvedValue('99-00001'),
    createInvoice: vi
      .fn()
      .mockImplementation((input: Record<string, unknown>) =>
        stored({ ...input, status: 'pending' }),
      ),
    createBalanceInvoice: options.balance
      ? vi
          .fn()
          .mockImplementation((input: Record<string, unknown>) =>
            stored({ ...input, status: 'paid' }),
          )
      : vi.fn().mockRejectedValue(new PaymentError('INSUFFICIENT_FUNDS')),
    findInvoice: vi.fn().mockResolvedValue({ id: 'invoice-1' }),
  };
  const settings: Record<string, unknown> = {
    'brand.name': 'Manta VPN',
    'fiscal.mode': 'none',
    'fiscal.vat_code': 1,
    'fiscal.fallback_email': '',
    'fiscal.item_name_template': 'Пополнение баланса (#{number})',
    ...Object.fromEntries(
      Object.entries(options.fiscal ?? {}).map(([key, value]) => [`fiscal.${key}`, value]),
    ),
  };
  const service = new PaymentsService(
    { db } as unknown as Infrastructure,
    repository as unknown as PaymentsRepository,
    registry,
    { get: (key: string) => Promise.resolve(settings[key]) } as never,
  );
  return { db, provider, repository, service };
}

describe('PaymentsService.createInvoice, purchases only from the balance (F37, ADR-021)', () => {
  it('numbers a provider invoice and names it by the template (F37)', async () => {
    const { service, provider, repository } = setup({
      fiscal: { mode: 'provider_receipt', item_name_template: 'Пополнение баланса (#{number})' },
      receipts: true,
    });
    repository.nextInvoiceNumber.mockResolvedValue('99-00007');
    await service.createInvoice({
      userId: USER,
      kind: 'topup',
      provider: 'mock',
      amountMinor: 5000n,
      idempotencyKey: 'k1',
    });
    const [params] = provider.createInvoice.mock.calls[0] ?? [];
    expect(repository.nextInvoiceNumber).toHaveBeenCalledWith('mock');
    expect(params?.description).toBe('Пополнение баланса (#99-00007)');
    expect(params?.receipt?.items[0]?.description).toBe('Пополнение баланса (#99-00007)');
    expect(repository.createInvoice).toHaveBeenCalledWith(
      expect.objectContaining({ number: '99-00007' }),
    );
  });

  it('fills the brand into the template', async () => {
    const { service, provider, repository } = setup({
      fiscal: { item_name_template: '{brand}: пополнение (#{number})' },
    });
    repository.nextInvoiceNumber.mockResolvedValue('99-00002');
    await service.createInvoice({
      userId: USER,
      kind: 'topup',
      provider: 'mock',
      amountMinor: 5000n,
      idempotencyKey: 'k6',
    });
    expect(provider.createInvoice).toHaveBeenCalledWith(
      expect.objectContaining({ description: 'Manta VPN: пополнение (#99-00002)' }),
      expect.anything(),
    );
  });

  it('refuses a purchase at a provider (F37: purchases only from the balance)', async () => {
    const { service, provider, repository } = setup();
    await expect(
      service.createInvoice({
        userId: USER,
        kind: 'purchase',
        planId: PLAN,
        provider: 'mock',
        idempotencyKey: 'k2',
      }),
    ).rejects.toMatchObject({ code: 'BALANCE_ONLY' });
    expect(provider.createInvoice).not.toHaveBeenCalled();
    expect(repository.nextInvoiceNumber).not.toHaveBeenCalled();
  });

  it('refuses a plan change at a provider the same way', async () => {
    const { service, provider } = setup();
    await expect(
      service.createInvoice({
        userId: USER,
        kind: 'plan_change',
        planId: PLAN,
        provider: 'mock',
        idempotencyKey: 'k7',
      }),
    ).rejects.toMatchObject({ code: 'BALANCE_ONLY' });
    expect(provider.createInvoice).not.toHaveBeenCalled();
  });

  it('stores the purpose of a top-up for a plan', async () => {
    const { service, repository } = setup();
    repository.nextInvoiceNumber.mockResolvedValue('99-00008');
    await service.createInvoice({
      userId: USER,
      kind: 'topup',
      provider: 'mock',
      amountMinor: 5000n,
      idempotencyKey: 'k3',
      target: { planId: PLAN, kind: 'purchase', promocode: 'SALE' },
    });
    expect(repository.createInvoice).toHaveBeenCalledWith(
      expect.objectContaining({ target: { planId: PLAN, kind: 'purchase', promocode: 'SALE' } }),
    );
  });

  it('takes no number for a purchase from the balance', async () => {
    const { service, repository } = setup({ balance: true });
    await service.createInvoice({
      userId: USER,
      kind: 'purchase',
      planId: PLAN,
      provider: 'balance',
      idempotencyKey: 'k4',
    });
    expect(repository.nextInvoiceNumber).not.toHaveBeenCalled();
    expect(repository.createBalanceInvoice).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'purchase', amountMinor: 29900n }),
    );
    const [input] = repository.createBalanceInvoice.mock.calls[0] as [Record<string, unknown>];
    expect(input).not.toHaveProperty('number');
  });

  it('charges a plan change from the balance the price less the remainder', async () => {
    const { db, service, repository } = setup({ balance: true });
    db.plan.findFirst.mockResolvedValue({
      id: OTHER_PLAN,
      slug: 'max',
      name: { ru: 'Максимум' },
      priceMinor: 59900n,
      durationDays: 30,
    });
    Object.assign(db, {
      subscription: {
        findFirst: vi.fn().mockResolvedValue({
          planId: PLAN,
          expiresAt: new Date(Date.now() + 15 * 86_400_000 + 60_000),
        }),
      },
    });
    Object.assign(db.plan, {
      findUnique: vi.fn().mockResolvedValue({ id: PLAN, priceMinor: 29900n, durationDays: 30 }),
    });
    await service.createInvoice({
      userId: USER,
      kind: 'plan_change',
      planId: OTHER_PLAN,
      provider: 'balance',
      idempotencyKey: 'k10',
    });
    const [input] = repository.createBalanceInvoice.mock.calls[0] as [{ amountMinor: bigint }];
    // 59 900 − ceil(29 900 × remaining / 30 days); the extra minute adds one kopeck of credit.
    expect(input.amountMinor).toBe(44_949n);
  });

  it('still refuses a free plan instead of charging one kopeck for it', async () => {
    const { db, service, repository } = setup({ balance: true });
    db.plan.findFirst.mockResolvedValue({
      id: PLAN,
      slug: 'free',
      name: { ru: 'Бесплатный' },
      priceMinor: 0n,
      durationDays: 30,
    });
    await expect(
      service.createInvoice({
        userId: USER,
        kind: 'purchase',
        planId: PLAN,
        provider: 'balance',
        idempotencyKey: 'k9',
      }),
    ).rejects.toMatchObject({ code: 'PLAN_UNAVAILABLE' });
    expect(repository.createBalanceInvoice).not.toHaveBeenCalled();
  });

  it('replays a top-up for a plan by its purpose, not its amount', async () => {
    const { service, repository } = setup();
    repository.findByIdempotencyKey.mockResolvedValue({
      id: 'inv',
      userId: USER,
      kind: 'topup',
      planId: null,
      provider: 'mock',
      amountMinor: 5000n,
      targetPlanId: PLAN,
      targetKind: 'purchase',
      targetPromocode: null,
    });
    await expect(
      service.replay({
        userId: USER,
        kind: 'topup',
        provider: 'mock',
        amountMinor: 7000n,
        idempotencyKey: 'k5',
        target: { planId: PLAN, kind: 'purchase' },
      }),
    ).resolves.toMatchObject({ id: 'inv' });
    await expect(
      service.replay({
        userId: USER,
        kind: 'topup',
        provider: 'mock',
        amountMinor: 5000n,
        idempotencyKey: 'k5',
        target: { planId: OTHER_PLAN, kind: 'purchase' },
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });

  it('never replays a top-up for a plan as a plain top-up, or the other way round', async () => {
    const { service, repository } = setup();
    repository.findByIdempotencyKey.mockResolvedValue({
      id: 'inv',
      userId: USER,
      kind: 'topup',
      planId: null,
      provider: 'mock',
      amountMinor: 5000n,
      targetPlanId: PLAN,
      targetKind: 'purchase',
      targetPromocode: null,
    });
    await expect(
      service.replay({
        userId: USER,
        kind: 'topup',
        provider: 'mock',
        amountMinor: 5000n,
        idempotencyKey: 'k8',
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    repository.findByIdempotencyKey.mockResolvedValue({
      id: 'inv',
      userId: USER,
      kind: 'topup',
      planId: null,
      provider: 'mock',
      amountMinor: 5000n,
      targetPlanId: null,
      targetKind: null,
      targetPromocode: null,
    });
    await expect(
      service.replay({
        userId: USER,
        kind: 'topup',
        provider: 'mock',
        amountMinor: 5000n,
        idempotencyKey: 'k8',
        target: { planId: PLAN, kind: 'purchase' },
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });

  it('gives the provider minimum for the top-up of a plan', () => {
    const { service } = setup();
    expect(service.minimumMinor('mock')).toBe(100n);
    expect(service.minimumMinor('balance')).toBe(0n);
  });
});

describe('PaymentsService.applyEvent for the payments.apply-event job (R49)', () => {
  it('answers the worker with a body once the event is applied', async () => {
    // An empty response failed every job after the apply had committed.
    const { repository, service } = harness();
    repository.applyEvent.mockResolvedValue(undefined);
    await expect(service.applyEvent('event-1')).resolves.toEqual({ applied: true });
    expect(repository.applyEvent).toHaveBeenCalledWith('event-1');
  });
});

describe('PaymentsService.reapplyUnapplied, the payments.reapply-events backstop', () => {
  const now = new Date('2026-09-28T10:00:00Z');

  function backstop(stuck: Array<{ id: string }>, alerted: object | null = null) {
    const { db, repository, service } = harness();
    const unapplied = vi
      .fn()
      .mockResolvedValueOnce([{ id: 'event-1' }, { id: 'event-2' }])
      .mockResolvedValueOnce(stuck);
    const markEventError = vi.fn();
    Object.assign(repository, { unappliedEvents: unapplied, markEventError });
    Object.assign(db.outboxJob, { findFirst: vi.fn().mockResolvedValue(alerted) });
    repository.applyEvent
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new PaymentError('PLAN_UNAVAILABLE'));
    return { db, repository, service, unapplied, markEventError };
  }

  it('applies every event older than two minutes and records why one failed', async () => {
    const { repository, service, unapplied, markEventError } = backstop([]);

    await expect(service.reapplyUnapplied(now)).resolves.toEqual({
      reapplied: 1,
      failed: 1,
      stuck: 0,
    });

    expect(unapplied).toHaveBeenNthCalledWith(1, new Date('2026-09-28T09:58:00Z'), 100);
    expect(repository.applyEvent).toHaveBeenCalledWith('event-1');
    expect(repository.applyEvent).toHaveBeenCalledWith('event-2');
    expect(markEventError).toHaveBeenCalledTimes(1);
    expect(markEventError).toHaveBeenCalledWith('event-2', 'PLAN_UNAVAILABLE');
  });

  it('alerts the administrators once for an event still unapplied after fifteen minutes', async () => {
    const { db, service, unapplied } = backstop([{ id: 'event-2' }]);

    await expect(service.reapplyUnapplied(now)).resolves.toMatchObject({ stuck: 1 });

    expect(unapplied).toHaveBeenNthCalledWith(2, new Date('2026-09-28T09:45:00Z'), 100);
    expect(db.outboxJob.create).toHaveBeenCalledWith({
      data: {
        queue: 'notify',
        name: 'notify.alert',
        payload: { type: 'payment.unapplied', details: 'payment event event-2' },
        jobId: 'alert:payment.unapplied:event-2',
      },
    });
  });

  it('does not queue a second alert for the same event', async () => {
    const { db, service } = backstop([{ id: 'event-2' }], { id: 'outbox-1' });

    await service.reapplyUnapplied(now);

    expect(db.outboxJob.create).not.toHaveBeenCalled();
  });
});
