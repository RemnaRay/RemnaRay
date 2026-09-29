import { createHash, createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  BalanceProvider,
  CryptoBotProvider,
  LavaProvider,
  PlategaProvider,
  RobokassaProvider,
  StarsProvider,
  YooKassaProvider,
  starsAmount,
} from './builtin-providers';

describe('payment provider boundaries', () => {
  it('checks YooKassa notification source against the documented ranges', () => {
    const provider = new YooKassaProvider();
    expect(provider.verifyWebhook(Buffer.from('{}'), {}, '185.71.76.2', {}).ok).toBe(true);
    expect(provider.verifyWebhook(Buffer.from('{}'), {}, '192.0.2.1', {}).ok).toBe(false);
  });

  it('verifies Lava with the additional webhook key', () => {
    const body = Buffer.from('{"orderId":"x","status":"paid"}');
    const provider = new LavaProvider();
    expect(
      provider.verifyWebhook(
        body,
        { Signature: createHmac('sha256', 'additional').update(body).digest('hex') },
        '',
        { additionalKey: 'additional' },
      ).ok,
    ).toBe(true);
  });

  it('verifies CryptoBot using the derived token key', () => {
    const body = Buffer.from('{"payload":{"invoice_id":1,"status":"paid"}}');
    const token = 'token';
    const key = createHash('sha256').update(token).digest();
    const signature = createHmac('sha256', key).update(body).digest('hex');
    expect(
      new CryptoBotProvider().verifyWebhook(body, { 'crypto-pay-api-signature': signature }, '', {
        token,
      }).ok,
    ).toBe(true);
  });

  it('gives Telegram Stars no HTTP webhook (section 11.3.6)', () => {
    const provider = new StarsProvider();
    expect(provider.capabilities.webhooks).toBe(false);
    expect(provider.verifyWebhook().ok).toBe(false);
    expect(provider.parseWebhook()).toBeNull();
  });

  it('marks Platega as polling-only', () => {
    expect(new PlategaProvider().verifyWebhook(Buffer.from('{}'), {}, '', {}).ok).toBe(false);
  });
});

describe('status polling (sections 7.3, 11.3)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // The poll stores what it saw as a payment event keyed by `eventId`. An id
  // that ignores the status is taken by the first `pending` poll, and the
  // later `paid` answer is dropped as its duplicate: the payment is never
  // applied.
  it.each([
    ['yookassa', new YooKassaProvider(), { status: 'pending' }, { status: 'succeeded' }],
    ['platega', new PlategaProvider(), { status: 'PENDING' }, { status: 'CONFIRMED' }],
    ['lava', new LavaProvider(), { status: 'created' }, { status: 'success' }],
    [
      'cryptobot',
      new CryptoBotProvider(),
      { result: { items: [{ status: 'active' }] } },
      { result: { items: [{ status: 'paid', amount: '299.00', fiat: 'RUB' }] } },
    ],
  ] as const)(
    '%s keys a paid answer apart from a pending one',
    async (_code, provider, pending, paid) => {
      let answer: object = pending;
      vi.stubGlobal('fetch', () => Promise.resolve(Response.json(answer)));
      const cfg = { baseUrl: 'http://provider.test' };

      const first = await provider.fetchStatus('77', cfg);
      answer = paid;
      const second = await provider.fetchStatus('77', cfg);

      expect([first.type, second.type]).toEqual(['pending', 'paid']);
      expect(second.eventId).not.toBe(first.eventId);
    },
  );
});

describe('Robokassa (section 11.3.4)', () => {
  const md5 = (value: string) => createHash('md5').update(value).digest('hex');
  const uuid = '0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee';
  const cfg = { merchantLogin: 'shop', password1: 'p1', password2: 'p2' };
  const params = (overrides: Record<string, unknown> = {}) => ({
    invoiceId: 'client-key',
    shopInvoiceId: uuid,
    shopInvoiceNumber: 42n,
    amountMinor: 29900n,
    currency: 'RUB' as const,
    description: 'Shop: Premium',
    user: { id: 'u', telegramId: 1n, email: 'buyer@example.com', language: 'en' },
    returnUrl: `https://shop.test/pay/${uuid}`,
    failUrl: `https://shop.test/pay/${uuid}`,
    webhookUrl: 'https://shop.test/webhooks/robokassa',
    expiresAt: new Date(Date.now() + 3_600_000),
    ...overrides,
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('builds the payment link with InvId = numeric_id and Shp_inv = the invoice id', async () => {
    const created = await new RobokassaProvider().createInvoice(params(), cfg);
    const url = new URL(created.paymentUrl);

    expect(`${url.origin}${url.pathname}`).toBe('https://auth.robokassa.ru/Merchant/Index.aspx');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      MerchantLogin: 'shop',
      OutSum: '299.00',
      InvId: '42',
      Description: 'Shop: Premium',
      Culture: 'en',
      Email: 'buyer@example.com',
      Shp_inv: uuid,
      SignatureValue: md5(`shop:299.00:42:p1:Shp_inv=${uuid}`),
    });
    expect(created.providerInvoiceId).toBe('42');
  });

  it('signs the URL-encoded receipt and sends that encoded value', async () => {
    const created = await new RobokassaProvider().createInvoice(
      params({
        receipt: {
          customer: {},
          items: [
            {
              description: 'Premium',
              quantity: '1.00',
              amountMinor: 29900n,
              vatCode: 1,
              paymentSubject: 'service',
              paymentMode: 'full_payment',
            },
          ],
        },
      }),
      { ...cfg, sno: 'usn_income', tax: 'none' },
    );
    const url = new URL(created.paymentUrl);
    const receipt = url.searchParams.get('Receipt') ?? '';

    expect(JSON.parse(decodeURIComponent(receipt))).toEqual({
      sno: 'usn_income',
      items: [
        {
          name: 'Premium',
          quantity: 1,
          sum: 299,
          payment_method: 'full_payment',
          payment_object: 'service',
          tax: 'none',
        },
      ],
    });
    expect(url.searchParams.get('SignatureValue')).toBe(
      md5(`shop:299.00:42:${receipt}:p1:Shp_inv=${uuid}`),
    );
  });

  it('uses the test passwords and IsTest=1 in test mode', async () => {
    const created = await new RobokassaProvider().createInvoice(params(), {
      ...cfg,
      isTest: true,
      testPassword1: 't1',
      testPassword2: 't2',
    });
    const url = new URL(created.paymentUrl);

    expect(url.searchParams.get('IsTest')).toBe('1');
    expect(url.searchParams.get('SignatureValue')).toBe(md5(`shop:299.00:42:t1:Shp_inv=${uuid}`));
  });

  it('refuses an InvId above 2^31 − 1', async () => {
    await expect(
      new RobokassaProvider().createInvoice(params({ shopInvoiceNumber: 2_147_483_648n }), cfg),
    ).rejects.toThrow(/InvId/u);
  });

  it('verifies ResultURL as MD5(OutSum:InvId:Password2:Shp_inv=…), case-insensitively', () => {
    const provider = new RobokassaProvider();
    const signature = md5(`299.000000:42:p2:Shp_inv=${uuid}`).toUpperCase();
    const body = Buffer.from(
      `OutSum=299.000000&InvId=42&SignatureValue=${signature}&Shp_inv=${uuid}&Fee=5.00`,
    );

    expect(provider.verifyWebhook(body, {}, '', cfg).ok).toBe(true);
    // The merchant login is not part of the ResultURL signature.
    const withLogin = Buffer.from(
      `OutSum=299.000000&InvId=42&Shp_inv=${uuid}&SignatureValue=${md5(`shop:299.000000:42:p2`)}`,
    );
    expect(provider.verifyWebhook(withLogin, {}, '', cfg).ok).toBe(false);
    // Shp_inv is signed: another invoice id breaks the signature.
    const swapped = Buffer.from(
      `OutSum=299.000000&InvId=42&SignatureValue=${signature}&Shp_inv=other`,
    );
    expect(provider.verifyWebhook(swapped, {}, '', cfg).ok).toBe(false);
  });

  it('answers OK<InvId> of the notification it was given', () => {
    const provider = new RobokassaProvider();
    const event = provider.parseWebhook(
      Buffer.from(`OutSum=299.000000&InvId=42&SignatureValue=x&Shp_inv=${uuid}`),
    );

    expect(event).toMatchObject({
      providerInvoiceId: '42',
      type: 'paid',
      paidAmount: { amount: '299.000000', currency: 'RUB' },
    });
    // Another notification parsed in between must not change this answer.
    provider.parseWebhook(Buffer.from('OutSum=1&InvId=43&SignatureValue=x'));
    expect(provider.ackResponse(event ?? undefined)).toEqual({
      status: 200,
      body: 'OK42',
      contentType: 'text/plain',
    });
  });

  it('polls OpStateExt and reads State.Code 100 as paid', async () => {
    const requests: string[] = [];
    let state = 5;
    vi.stubGlobal('fetch', (url: string) => {
      requests.push(url);
      return Promise.resolve(
        new Response(
          `<?xml version="1.0" encoding="utf-8"?><OperationStateResponse xmlns="http://merchant.roboxchange.com/WebService/"><Result><Code>0</Code></Result><State><Code>${String(state)}</Code><RequestDate>2026-09-25T10:00:00+03:00</RequestDate></State></OperationStateResponse>`,
          { headers: { 'content-type': 'text/xml' } },
        ),
      );
    });
    const provider = new RobokassaProvider();

    const pending = await provider.fetchStatus('42', cfg);
    state = 100;
    const paid = await provider.fetchStatus('42', cfg);

    expect(requests[0]).toBe(
      `https://auth.robokassa.ru/Merchant/WebService/Service.asmx/OpStateExt?MerchantLogin=shop&InvoiceID=42&Signature=${md5('shop:42:p2')}`,
    );
    expect(pending.type).toBe('pending');
    expect(paid.type).toBe('paid');
    expect(paid.eventId).not.toBe(pending.eventId);
  });

  it('keeps an unknown operation pending and does not poll in test mode', async () => {
    const fetch = vi.fn(() =>
      Promise.resolve(
        new Response(
          '<OperationStateResponse><Result><Code>3</Code></Result></OperationStateResponse>',
        ),
      ),
    );
    vi.stubGlobal('fetch', fetch);
    const provider = new RobokassaProvider();

    expect((await provider.fetchStatus('42', cfg)).type).toBe('pending');
    // OpStateExt does not serve test payments.
    fetch.mockClear();
    expect((await provider.fetchStatus('42', { ...cfg, isTest: true })).type).toBe('pending');
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('Lava invoice (section 11.3.3)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('points hookUrl at the shop webhook, not below the return page', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string) as Record<string, unknown>);
      return Promise.resolve(Response.json({ url: 'https://pay.lava.ru/x' }));
    });

    await new LavaProvider().createInvoice(
      {
        invoiceId: 'client-key',
        shopInvoiceId: '0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee',
        amountMinor: 29900n,
        currency: 'RUB',
        description: 'Premium',
        user: { id: 'u', telegramId: 1n, language: 'ru' },
        returnUrl: 'https://shop.test/pay/0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee',
        failUrl: 'https://shop.test/pay/0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee',
        webhookUrl: 'https://shop.test/webhooks/lava',
        expiresAt: new Date(Date.now() + 3_600_000),
      },
      { shopId: 'shop', secretKey: 'secret', baseUrl: 'http://lava.test' },
    );

    expect(bodies[0]).toMatchObject({
      hookUrl: 'https://shop.test/webhooks/lava',
      successUrl: 'https://shop.test/pay/0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee',
    });
  });
});

describe('CryptoBot invoice (section 11.3.5)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('bills the fiat RUB amount as a decimal string in roubles', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string) as Record<string, unknown>);
      return Promise.resolve(
        Response.json({ ok: true, result: { invoice_id: 7, pay_url: 'https://t.me/pay' } }),
      );
    });

    await new CryptoBotProvider().createInvoice(
      {
        invoiceId: 'client-key',
        shopInvoiceId: '0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee',
        amountMinor: 29950n,
        currency: 'RUB',
        description: 'Premium',
        user: { id: 'u', telegramId: 1n, language: 'ru' },
        returnUrl: 'https://shop.test/pay/success',
        failUrl: 'https://shop.test/pay/fail',
        webhookUrl: 'https://shop.test/webhooks/x',
        expiresAt: new Date(Date.now() + 3_600_000),
      },
      { token: 'token', baseUrl: 'http://cryptobot.test/api' },
    );

    // Crypto Pay `amount` is a String "in float" of the fiat currency; the
    // 299.50 ₽ invoice was sent as 2.995.
    expect(bodies[0]).toMatchObject({ currency_type: 'fiat', fiat: 'RUB', amount: '299.50' });
  });
});

describe('Telegram Stars pricing and invoice link (section 11.3.6)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('converts roubles with ceil(price / 100 × starsPerRub), never below one star', () => {
    expect(starsAmount(29900n, 0.75)).toBe(225n);
    expect(starsAmount(29901n, 0.75)).toBe(225n);
    expect(starsAmount(30000n, 0.75)).toBe(225n);
    expect(starsAmount(30001n, 0.75)).toBe(226n);
    expect(starsAmount(1n, 0.75)).toBe(1n);
    expect(starsAmount(10000n, 1.1)).toBe(110n);
  });

  it('prices a plan by price_overrides.XTR, scaled by any discount', () => {
    const plan = { priceMinor: 29900n, priceOverrides: { XTR: 200 } };
    expect(starsAmount(29900n, 0.75, plan)).toBe(200n);
    // 19900 / 29900 of 200 stars is 133.1 → 134, not the rate's 150.
    expect(starsAmount(19900n, 0.75, plan)).toBe(134n);
    // A one-kopeck discount keeps the plan's own star price.
    expect(starsAmount(29899n, 0.75, plan)).toBe(200n);
    expect(starsAmount(1n, 0.75, plan)).toBe(1n);
    expect(starsAmount(29900n, 0.75, { priceMinor: 29900n, priceOverrides: {} })).toBe(225n);
    expect(starsAmount(29900n, 0.75, { priceMinor: 29900n, priceOverrides: { XTR: 0 } })).toBe(
      225n,
    );
  });

  it('creates the invoice link with payload inv_<invoiceId> and an empty provider token', async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
      requests.push({ url, body: JSON.parse(init.body as string) as Record<string, unknown> });
      return Promise.resolve(Response.json({ ok: true, result: 'https://t.me/$abc' }));
    });
    const expiresAt = new Date('2026-09-25T12:00:00Z');
    const created = await new StarsProvider().createInvoice(
      {
        invoiceId: 'client-key',
        shopInvoiceId: '0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee',
        amountMinor: 29900n,
        currency: 'RUB',
        description: 'Премиум на 30 дней с огромным описанием тарифа',
        user: { id: 'u', telegramId: 1n, language: 'ru' },
        returnUrl: 'https://shop.test/pay/success',
        failUrl: 'https://shop.test/pay/fail',
        webhookUrl: 'https://shop.test/webhooks/x',
        expiresAt,
        plan: { priceMinor: 29900n, priceOverrides: {} },
      },
      { starsPerRub: 0.75, botToken: '123:token', apiBase: 'http://telegram.test' },
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe('http://telegram.test/bot123:token/createInvoiceLink');
    expect(requests[0]?.body).toEqual({
      title: 'Премиум на 30 дней с огромным оп',
      description: 'Премиум на 30 дней с огромным описанием тарифа',
      payload: 'inv_0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee',
      provider_token: '',
      currency: 'XTR',
      prices: [{ label: 'Премиум на 30 дней с огромным оп', amount: 225 }],
    });
    expect(created).toMatchObject({
      providerInvoiceId: 'inv_0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee',
      starsInvoiceLink: 'https://t.me/$abc',
      providerAmount: { amount: '225', currency: 'XTR', fxRate: '0.75250836' },
      expiresAt,
    });
  });

  it('keeps fx_rate finite below one rouble', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(Response.json({ ok: true, result: 'link' })));
    const created = await new StarsProvider().createInvoice(
      {
        invoiceId: 'k',
        shopInvoiceId: 'id',
        amountMinor: 50n,
        currency: 'RUB',
        description: 'Top-up',
        user: { id: 'u', telegramId: 1n, language: 'ru' },
        returnUrl: '',
        failUrl: '',
        webhookUrl: 'https://shop.test/webhooks/x',
        expiresAt: new Date(),
      },
      { starsPerRub: 0.75, botToken: 't', apiBase: 'http://telegram.test' },
    );
    expect(created.providerAmount).toEqual({ amount: '1', currency: 'XTR', fxRate: '2.00000000' });
  });

  it('refuses to create a link without a rate or a bot token', async () => {
    const params = {
      invoiceId: 'k',
      shopInvoiceId: 'id',
      amountMinor: 100n,
      currency: 'RUB' as const,
      description: 'x',
      user: { id: 'u', telegramId: 1n, language: 'ru' },
      returnUrl: '',
      failUrl: '',
      webhookUrl: 'https://shop.test/webhooks/x',
      expiresAt: new Date(),
    };
    await expect(new StarsProvider().createInvoice(params, { botToken: 't' })).rejects.toThrow(
      'starsPerRub',
    );
    await expect(new StarsProvider().createInvoice(params, { starsPerRub: 0.75 })).rejects.toThrow(
      'bot token',
    );
  });

  it('is healthy only with a rate and a bot token Telegram accepts', async () => {
    const provider = new StarsProvider();
    await expect(provider.healthcheck({ botToken: 't' })).resolves.toMatchObject({ ok: false });
    await expect(provider.healthcheck({ starsPerRub: 0.75 })).resolves.toMatchObject({ ok: false });
    const urls: string[] = [];
    vi.stubGlobal('fetch', (url: string) => {
      urls.push(url);
      return Promise.resolve(Response.json({ ok: true, result: { id: 1, is_bot: true } }));
    });
    await expect(
      provider.healthcheck({ starsPerRub: 0.75, botToken: 't', apiBase: 'http://telegram.test' }),
    ).resolves.toMatchObject({ ok: true });
    expect(urls).toEqual(['http://telegram.test/bott/getMe']);
  });
});

describe('provider healthchecks call the provider (FR-061)', () => {
  afterEach(() => vi.unstubAllGlobals());

  function stub(answer: (url: string, init: RequestInit) => Response) {
    const requests: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
      requests.push({ url, init });
      return Promise.resolve(answer(url, init));
    });
    return requests;
  }

  it('checks CryptoBot with getMe and its token', async () => {
    const requests = stub(() => Response.json({ ok: true, result: { app_id: 1 } }));
    await expect(
      new CryptoBotProvider().healthcheck({ token: 't-1', baseUrl: 'http://cryptobot.test/api' }),
    ).resolves.toMatchObject({ ok: true });
    expect(requests[0]?.url).toBe('http://cryptobot.test/api/getMe');
    expect(new Headers(requests[0]?.init.headers).get('crypto-pay-api-token')).toBe('t-1');

    stub(() =>
      Response.json({ ok: false, error: { code: 401, name: 'UNAUTHORIZED' } }, { status: 401 }),
    );
    await expect(
      new CryptoBotProvider().healthcheck({ token: 'bad', baseUrl: 'http://cryptobot.test/api' }),
    ).resolves.toMatchObject({ ok: false });
  });

  it('checks Platega with its balances and the merchant credentials', async () => {
    const requests = stub(() => Response.json([{ amount: 1, currency: 'RUB' }]));
    await expect(
      new PlategaProvider().healthcheck({
        merchantId: 'm-1',
        secret: 's-1',
        baseUrl: 'http://platega.test',
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(requests[0]?.url).toBe('http://platega.test/balance/all');
    const headers = new Headers(requests[0]?.init.headers);
    expect([headers.get('x-merchantid'), headers.get('x-secret')]).toEqual(['m-1', 's-1']);

    stub(
      () => new Response('{}', { status: 401, headers: { 'content-type': 'application/json' } }),
    );
    await expect(
      new PlategaProvider().healthcheck({
        merchantId: 'm',
        secret: 'bad',
        baseUrl: 'http://platega.test',
      }),
    ).resolves.toMatchObject({ ok: false });
  });

  it('checks Lava with the shop tariffs, signed with the secret key', async () => {
    const requests = stub(() => Response.json({ data: [], status: 200, status_check: true }));
    await expect(
      new LavaProvider().healthcheck({
        shopId: 'shop-1',
        secretKey: 'secret',
        baseUrl: 'http://lava.test',
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(requests[0]?.url).toBe('http://lava.test/business/invoice/get-available-tariffs');
    const body = requests[0]?.init.body as string;
    expect(body).toBe('{"shopId":"shop-1"}');
    expect(new Headers(requests[0]?.init.headers).get('signature')).toBe(
      createHmac('sha256', 'secret').update(body).digest('hex'),
    );

    stub(() =>
      Response.json(
        { error: 'Invalid signature', data: null, status: null, status_check: null },
        { status: 422 },
      ),
    );
    await expect(
      new LavaProvider().healthcheck({
        shopId: 'shop-1',
        secretKey: 'bad',
        baseUrl: 'http://lava.test',
      }),
    ).resolves.toMatchObject({ ok: false });
  });

  it('declares the verified minimum of every provider (F37, docs/payments/README.md)', () => {
    for (const provider of [
      new YooKassaProvider(),
      new RobokassaProvider(),
      new LavaProvider(),
      new PlategaProvider(),
      new CryptoBotProvider(),
      new StarsProvider(),
    ])
      expect(provider.capabilities.minAmountMinor).toBe(100n);
    expect(new BalanceProvider().capabilities.minAmountMinor).toBe(0n);
  });
});
