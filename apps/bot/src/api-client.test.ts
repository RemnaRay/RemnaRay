import { describe, expect, it } from 'vitest';

import { ApiClient } from './api-client.js';

describe('ApiClient', () => {
  it('sends the internal token and acting Telegram identity', async () => {
    const requests: Request[] = [];
    const api = new ApiClient({
      baseUrl: 'http://api.test',
      internalToken: 'internal-secret',
      fetchImpl: (input, init) => {
        requests.push(new Request(input, init));
        return Promise.resolve(
          new Response(
            JSON.stringify({
              user: {
                id: 'u1',
                telegramId: '123',
                username: null,
                firstName: null,
                language: 'ru',
                referralCode: 'ABCD2345',
                isBanned: false,
              },
              created: true,
              attributed: false,
              promoReserved: false,
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        );
      },
    });

    const result = await api.request<{ user: { telegramId: string } }>('/api/internal/v1/me', {
      method: 'GET',
      userId: 123,
    });

    expect(result.user.telegramId).toBe('123');
    expect(requests[0]?.headers.get('x-internal-token')).toBe('internal-secret');
    expect(requests[0]?.headers.get('x-acting-user')).toBe('123');
  });

  it('names the customer whose payment methods it asks for', async () => {
    const requests: Request[] = [];
    const api = new ApiClient({
      baseUrl: 'http://api.test',
      internalToken: 'internal-secret',
      fetchImpl: (input, init) => {
        requests.push(new Request(input, init));
        return Promise.resolve(Response.json({ items: [] }));
      },
    });

    await api.getPaymentMethods(123);

    // `GET /me/payment-methods` resolves the customer from `x-acting-user`
    // and answers 403 without it.
    expect(requests[0]?.url).toBe('http://api.test/api/internal/v1/me/payment-methods');
    expect(requests[0]?.headers.get('x-acting-user')).toBe('123');
  });

  it('reuses the bot configuration for a while, and fetches it afresh on request', async () => {
    let calls = 0;
    const api = new ApiClient({
      baseUrl: 'http://api.test',
      internalToken: 'internal-secret',
      fetchImpl: () => {
        calls += 1;
        return Promise.resolve(Response.json({ brandName: `Shop ${String(calls)}` }));
      },
    });

    expect((await api.getConfig()).brandName).toBe('Shop 1');
    expect((await api.getConfig()).brandName).toBe('Shop 1');
    expect((await api.getConfig({ fresh: true })).brandName).toBe('Shop 2');
    expect((await api.getConfig()).brandName).toBe('Shop 2');
  });

  it('turns structured API errors into ApiClientError', async () => {
    const api = new ApiClient({
      fetchImpl: () =>
        Promise.resolve(
          new Response(JSON.stringify({ code: 'PANEL_UNAVAILABLE' }), { status: 503 }),
        ),
    });
    await expect(api.request('/failure')).rejects.toMatchObject({
      status: 503,
      code: 'PANEL_UNAVAILABLE',
    });
  });

  it('hands the operators the customer’s message by its id, to be copied (F35)', async () => {
    let body = '';
    let actingUser: string | null = null;
    const api = new ApiClient({
      fetchImpl: (_input, init) => {
        body = typeof init?.body === 'string' ? init.body : '';
        actingUser = new Headers(init?.headers).get('x-acting-user');
        return Promise.resolve(Response.json({ acknowledge: true }));
      },
    });
    await expect(api.forwardSupport(42, 7, { requireOpen: true })).resolves.toEqual({
      acknowledge: true,
    });
    expect(JSON.parse(body)).toEqual({ messageId: 7, requireOpen: true });
    expect(actingUser).toBe('42');
  });

  it('reads the code of a section 9.3 error envelope', async () => {
    const api = new ApiClient({
      fetchImpl: () =>
        Promise.resolve(
          Response.json(
            { error: { code: 'INVOICE_EXPIRED', message: 'INVOICE_EXPIRED' } },
            { status: 409 },
          ),
        ),
    });
    await expect(api.request('/failure')).rejects.toMatchObject({
      status: 409,
      code: 'INVOICE_EXPIRED',
    });
  });

  it('hands Telegram Stars payment updates to the section 9.5 endpoints', async () => {
    const requests: Array<{ url: string; body: unknown; actingUser: string | null }> = [];
    const api = new ApiClient({
      baseUrl: 'http://api.test',
      fetchImpl: (input, init) => {
        const request = new Request(input, init);
        requests.push({
          url: request.url,
          body: JSON.parse(init?.body as string) as unknown,
          actingUser: request.headers.get('x-acting-user'),
        });
        return Promise.resolve(Response.json({ ok: true }));
      },
    });
    await api.starsCreateLink(42, 'invoice-1');
    await api.starsPrecheckout({
      telegramId: 42,
      invoicePayload: 'inv_1',
      totalAmount: 225,
      currency: 'XTR',
    });
    await api.starsSuccessfulPayment({
      telegramId: 42,
      telegramPaymentChargeId: 'charge',
      providerPaymentChargeId: 'provider',
      invoicePayload: 'inv_1',
      totalAmount: 225,
      currency: 'XTR',
    });
    expect(requests.map((request) => request.url)).toEqual([
      'http://api.test/api/internal/v1/stars/create-link',
      'http://api.test/api/internal/v1/stars/precheckout',
      'http://api.test/api/internal/v1/stars/successful-payment',
    ]);
    expect(requests[0]).toMatchObject({ body: { invoiceId: 'invoice-1' }, actingUser: '42' });
    expect(requests[2]?.body).toMatchObject({ telegramPaymentChargeId: 'charge' });
  });

  it('raises an alert to the administrators through the internal notify endpoint (R102)', async () => {
    const requests: Request[] = [];
    const api = new ApiClient({
      baseUrl: 'http://api.test',
      internalToken: 'internal-secret',
      fetchImpl: (input, init) => {
        requests.push(new Request(input, init));
        return Promise.resolve(new Response('{"delivered":1,"deduplicated":false}'));
      },
    });

    await api.alert({ type: 'payment.stars_stuck', details: 'update 6' });

    expect(requests[0]?.method).toBe('POST');
    expect(requests[0]?.url).toBe('http://api.test/api/internal/v1/notify/alert');
    expect(await requests[0]?.json()).toEqual({ type: 'payment.stars_stuck', details: 'update 6' });
  });
});
