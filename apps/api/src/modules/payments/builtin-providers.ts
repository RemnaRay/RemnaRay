/* eslint-disable @typescript-eslint/no-base-to-string, @typescript-eslint/no-unnecessary-condition, @typescript-eslint/no-unused-vars, @typescript-eslint/require-await, @typescript-eslint/restrict-template-expressions */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { BlockList, isIP } from 'node:net';
import { z } from 'zod';

import type {
  PaymentProvider,
  ProviderConfig,
  ProviderEvent,
  CreateInvoiceParams,
  CreatedInvoice,
} from './payments.types';

const json = async (url: string, init: RequestInit = {}) => {
  const response = await fetch(url, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(10_000),
  });
  const body = (await response.json()) as Record<string, unknown>;
  if (!response.ok) throw new Error(`payment provider HTTP ${response.status}`);
  return body;
};
/** A provider healthcheck: an authenticated call, timed, its failure named. */
const probe = async (task: () => Promise<void>) => {
  const started = Date.now();
  try {
    await task();
    return { ok: true, latencyMs: Date.now() - started };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      error: error instanceof Error ? error.message : 'healthcheck failed',
    };
  }
};
const amount = (minor: bigint) => `${minor / 100n}.${(minor % 100n).toString().padStart(2, '0')}`;
const toMinor = (value: unknown) => {
  const [whole, fraction = ''] = String(value).split('.');
  return BigInt(whole || '0') * 100n + BigInt(fraction.padEnd(2, '0').slice(0, 2));
};
const safeEqual = (actual: string, expected: string) => {
  const a = Buffer.from(actual.toLowerCase());
  const b = Buffer.from(expected.toLowerCase());
  return a.length === b.length && timingSafeEqual(a, b);
};
const ipAllowed = (ip: string, ranges: string[]) => {
  const clean = ip.replace(/^::ffff:/, '');
  const family = isIP(clean) === 4 ? 'ipv4' : 'ipv6';
  const list = new BlockList();
  for (const range of ranges) {
    const [subnet, bits] = range.split('/');
    if (subnet && bits) list.addSubnet(subnet, Number(bits), isIP(subnet) === 4 ? 'ipv4' : 'ipv6');
  }
  return list.check(clean, family);
};
const base = (config: ProviderConfig, fallback: string) =>
  String(config.baseUrl ?? fallback).replace(/\/$/, '');
const ack = (body: string | object = { ok: true }) => ({
  status: 200,
  body,
  contentType: typeof body === 'string' ? 'text/plain' : 'application/json',
});

export class YooKassaProvider implements PaymentProvider {
  readonly code = 'yookassa' as const;
  readonly capabilities = {
    receipts: true,
    webhooks: true,
    statusPolling: true,
    kind: 'redirect' as const,
    currencies: ['RUB'],
    minAmountMinor: 100n,
  };
  readonly configSchema = z.object({
    shopId: z.string(),
    secretKey: z.string(),
    ipRanges: z
      .array(z.string())
      .default([
        '185.71.76.0/27',
        '185.71.77.0/27',
        '77.75.153.0/25',
        '77.75.156.11/32',
        '77.75.156.35/32',
        '77.75.154.128/25',
        '2a02:5180::/32',
      ]),
    baseUrl: z.url().default('https://api.yookassa.ru'),
  });
  async createInvoice(p: CreateInvoiceParams, cfg: ProviderConfig): Promise<CreatedInvoice> {
    const body = {
      amount: { value: amount(p.amountMinor), currency: 'RUB' },
      capture: true,
      confirmation: { type: 'redirect', return_url: p.returnUrl },
      description: p.description,
      metadata: { invoiceId: p.invoiceId },
      ...(p.receipt
        ? {
            receipt: {
              customer: p.receipt.customer,
              items: p.receipt.items.map((item) => ({
                description: item.description,
                quantity: item.quantity,
                amount: { value: amount(item.amountMinor), currency: 'RUB' },
                vat_code: item.vatCode,
                payment_subject: item.paymentSubject,
                payment_mode: item.paymentMode,
              })),
            },
          }
        : {}),
    };
    const result = await json(`${base(cfg, 'https://api.yookassa.ru')}/v3/payments`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${cfg.shopId}:${cfg.secretKey}`).toString('base64')}`,
        'content-type': 'application/json',
        'Idempotence-Key': p.invoiceId,
      },
      body: JSON.stringify(body),
    });
    return {
      providerInvoiceId: String(result.id),
      paymentUrl: String((result.confirmation as Record<string, unknown>)?.confirmation_url ?? ''),
      expiresAt: p.expiresAt,
      rawSafe: result,
    };
  }
  verifyWebhook(_raw: Buffer, _headers: Record<string, string>, ip: string, cfg: ProviderConfig) {
    return {
      ok: ipAllowed(
        ip,
        (cfg.ipRanges as string[] | undefined) ?? [
          '185.71.76.0/27',
          '185.71.77.0/27',
          '77.75.153.0/25',
          '77.75.156.11/32',
          '77.75.156.35/32',
          '77.75.154.128/25',
          '2a02:5180::/32',
        ],
      ),
    };
  }
  parseWebhook(raw: Buffer): ProviderEvent | null {
    const v = JSON.parse(raw.toString()) as { event?: string; object?: Record<string, unknown> };
    const object = v.object;
    if (!object?.id) return null;
    return {
      eventId: `${object.id}:${v.event ?? 'unknown'}`,
      providerInvoiceId: String(object.id),
      type:
        v.event === 'payment.succeeded'
          ? 'paid'
          : v.event === 'payment.canceled'
            ? 'canceled'
            : 'pending',
      ...(object.amount && typeof object.amount === 'object'
        ? {
            paidAmount: {
              amount: String((object.amount as Record<string, unknown>).value),
              currency: String((object.amount as Record<string, unknown>).currency),
            },
          }
        : {}),
    };
  }
  ackResponse() {
    return ack();
  }
  async fetchStatus(id: string, cfg: ProviderConfig) {
    const r = await json(
      `${base(cfg, 'https://api.yookassa.ru')}/v3/payments/${encodeURIComponent(id)}`,
      {
        headers: {
          authorization: `Basic ${Buffer.from(`${cfg.shopId}:${cfg.secretKey}`).toString('base64')}`,
        },
      },
    );
    return {
      eventId: `${id}:poll:${String(r.status)}`,
      providerInvoiceId: id,
      type: r.status === 'succeeded' ? 'paid' : r.status === 'canceled' ? 'canceled' : 'pending',
      ...(r.amount && typeof r.amount === 'object'
        ? {
            paidAmount: {
              amount: String((r.amount as Record<string, unknown>).value),
              currency: String((r.amount as Record<string, unknown>).currency),
            },
          }
        : {}),
    } as ProviderEvent;
  }
  async healthcheck(cfg: ProviderConfig) {
    const started = Date.now();
    try {
      await json(`${base(cfg, 'https://api.yookassa.ru')}/v3/me`, {
        headers: {
          authorization: `Basic ${Buffer.from(`${cfg.shopId}:${cfg.secretKey}`).toString('base64')}`,
        },
      });
      return { ok: true, latencyMs: Date.now() - started };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        error: error instanceof Error ? error.message : 'healthcheck failed',
      };
    }
  }
}

const md5 = (value: string) => createHash('md5').update(value).digest('hex');
/** Robokassa takes `InvId` as a signed 32-bit integer (section 11.3.4). */
const ROBOKASSA_MAX_INV_ID = 2_147_483_647n;

/** Test mode signs with the test passwords (section 11.3.4). */
function robokassaPasswords(cfg: ProviderConfig) {
  const test = cfg.isTest === true;
  return {
    password1: String((test ? cfg.testPassword1 : cfg.password1) ?? ''),
    password2: String((test ? cfg.testPassword2 : cfg.password2) ?? ''),
  };
}

/** `Shp_*` parameters in alphabetical order as `Shp_key=value`, the signature tail. */
function shpTail(params: Iterable<[string, string]>): string[] {
  return [...params]
    .filter(([key]) => key.startsWith('Shp_'))
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`);
}

/**
 * Section 11.3.4, checked against docs.robokassa.ru (pay-interface,
 * notifications-and-redirects, fiscalization, xml-interfaces). The store must
 * select MD5 in its technical settings.
 */
export class RobokassaProvider implements PaymentProvider {
  readonly code = 'robokassa' as const;
  readonly capabilities = {
    receipts: true,
    webhooks: true,
    statusPolling: true,
    kind: 'redirect' as const,
    currencies: ['RUB'],
    minAmountMinor: 100n,
  };
  readonly configSchema = z.object({
    merchantLogin: z.string(),
    password1: z.string(),
    password2: z.string(),
    isTest: z.boolean().default(false),
    testPassword1: z.string().optional(),
    testPassword2: z.string().optional(),
    sno: z.string().optional(),
    tax: z.string().default('none'),
    baseUrl: z.url().default('https://auth.robokassa.ru'),
  });
  async createInvoice(p: CreateInvoiceParams, cfg: ProviderConfig) {
    const number = p.shopInvoiceNumber;
    if (number === undefined || number < 1n || number > ROBOKASSA_MAX_INV_ID)
      throw new Error('robokassa: InvId must be an integer from 1 to 2^31 - 1');
    const sum = amount(p.amountMinor);
    const invId = String(number);
    // The receipt is URL-encoded before it is signed, and that encoded text is
    // the value of the `Receipt` parameter.
    const receipt = p.receipt
      ? encodeURIComponent(
          JSON.stringify({
            ...(cfg.sno ? { sno: String(cfg.sno) } : {}),
            items: [
              {
                name: truncate(p.receipt.items[0]?.description ?? p.description, 128),
                quantity: 1,
                sum: Number(sum),
                payment_method: 'full_payment',
                payment_object: 'service',
                tax: String(cfg.tax ?? 'none'),
              },
            ],
          }),
        )
      : undefined;
    const shp: Array<[string, string]> = [['Shp_inv', p.shopInvoiceId]];
    const { password1 } = robokassaPasswords(cfg);
    const signature = md5(
      [
        String(cfg.merchantLogin),
        sum,
        invId,
        ...(receipt ? [receipt] : []),
        password1,
        ...shpTail(shp),
      ].join(':'),
    );
    const query = new URLSearchParams({
      MerchantLogin: String(cfg.merchantLogin),
      OutSum: sum,
      InvId: invId,
      // «до 100 символов» (docs/payments/robokassa.md); the receipt name above takes 128.
      Description: truncate(p.description, 100),
      Culture: p.user.language === 'en' ? 'en' : 'ru',
      ...(p.user.email ? { Email: p.user.email } : {}),
      ...Object.fromEntries(shp),
      ...(receipt ? { Receipt: receipt } : {}),
      ...(cfg.isTest === true ? { IsTest: '1' } : {}),
      SignatureValue: signature,
    });
    return {
      providerInvoiceId: invId,
      paymentUrl: `${base(cfg, 'https://auth.robokassa.ru')}/Merchant/Index.aspx?${query}`,
      expiresAt: p.expiresAt,
      rawSafe: {
        merchantLogin: cfg.merchantLogin,
        outSum: sum,
        invId,
        ...(receipt ? { receipt: true } : {}),
        ...(cfg.isTest === true ? { isTest: true } : {}),
      },
    };
  }
  verifyWebhook(raw: Buffer, _headers: Record<string, string>, _ip: string, cfg: ProviderConfig) {
    const params = new URLSearchParams(raw.toString());
    const expected = md5(
      [
        params.get('OutSum') ?? '',
        params.get('InvId') ?? '',
        robokassaPasswords(cfg).password2,
        ...shpTail(params),
      ].join(':'),
    );
    return { ok: safeEqual(params.get('SignatureValue') ?? '', expected) };
  }
  parseWebhook(raw: Buffer) {
    const p = new URLSearchParams(raw.toString());
    const id = p.get('InvId');
    if (!id) return null;
    return {
      eventId: `result:${id}:${p.get('OutSum')}`,
      providerInvoiceId: id,
      type: 'paid' as const,
      paidAmount: { amount: p.get('OutSum') ?? '0', currency: 'RUB' },
    };
  }
  /** `OK<InvId>` of this notification; a duplicate ResultURL gets the same answer. */
  ackResponse(event?: ProviderEvent) {
    return ack(`OK${event?.providerInvoiceId ?? ''}`);
  }
  async fetchStatus(id: string, cfg: ProviderConfig): Promise<ProviderEvent> {
    // OpStateExt serves live payments only; a test payment is known by its
    // ResultURL alone.
    if (cfg.isTest === true)
      return { eventId: `poll:${id}:test`, providerInvoiceId: id, type: 'pending' };
    const query = new URLSearchParams({
      MerchantLogin: String(cfg.merchantLogin),
      InvoiceID: id,
      Signature: md5(`${cfg.merchantLogin}:${id}:${robokassaPasswords(cfg).password2}`),
    });
    const response = await fetch(
      `${base(cfg, 'https://auth.robokassa.ru')}/Merchant/WebService/Service.asmx/OpStateExt?${query}`,
      { signal: AbortSignal.timeout(10_000) },
    );
    if (!response.ok) throw new Error(`payment provider HTTP ${response.status}`);
    const xml = await response.text();
    const result = /<Result>\s*<Code>(\d+)<\/Code>/u.exec(xml)?.[1];
    const state = /<State>\s*<Code>(\d+)<\/Code>/u.exec(xml)?.[1];
    // Result 0 is success; 3 is an operation the payer has not started yet.
    if (result !== '0')
      return { eventId: `poll:${id}:r${result}`, providerInvoiceId: id, type: 'pending' };
    return {
      eventId: `poll:${id}:${state}`,
      providerInvoiceId: id,
      type: state === '100' ? 'paid' : 'pending',
    };
  }
  healthcheck(cfg: ProviderConfig) {
    const { password1, password2 } = robokassaPasswords(cfg);
    const missing = !cfg.merchantLogin || !password1 || !password2;
    return Promise.resolve(
      missing
        ? { ok: false, latencyMs: 0, error: 'robokassa: merchantLogin and passwords are required' }
        : { ok: true, latencyMs: 0 },
    );
  }
}

export class LavaProvider implements PaymentProvider {
  readonly code = 'lava' as const;
  readonly capabilities = {
    // The invoice API takes no receipt data (docs/payments/lava.md); a
    // self-employed seller registers the receipt in «Мой налог» themselves.
    receipts: false,
    webhooks: true,
    statusPolling: true,
    kind: 'redirect' as const,
    currencies: ['RUB'],
    minAmountMinor: 100n,
  };
  readonly configSchema = z.object({
    shopId: z.string(),
    secretKey: z.string(),
    additionalKey: z.string(),
    baseUrl: z.url().default('https://api.lava.ru'),
  });
  async createInvoice(p: CreateInvoiceParams, cfg: ProviderConfig) {
    const body = {
      sum: Number(amount(p.amountMinor)),
      orderId: p.invoiceId,
      shopId: cfg.shopId,
      hookUrl: p.webhookUrl,
      successUrl: p.returnUrl,
      failUrl: p.failUrl,
    };
    const raw = JSON.stringify(body);
    const result = await json(`${base(cfg, 'https://api.lava.ru')}/business/invoice/create`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Accept: 'application/json',
        Signature: createHmac('sha256', String(cfg.secretKey)).update(raw).digest('hex'),
      },
      body: raw,
    });
    return {
      providerInvoiceId: p.invoiceId,
      paymentUrl: String(result.url ?? result.paymentUrl),
      expiresAt: p.expiresAt,
      rawSafe: result,
    };
  }
  verifyWebhook(raw: Buffer, headers: Record<string, string>, _ip: string, cfg: ProviderConfig) {
    return {
      ok: safeEqual(
        headers.signature ?? headers.Signature ?? '',
        createHmac('sha256', String(cfg.additionalKey)).update(raw).digest('hex'),
      ),
    };
  }
  parseWebhook(raw: Buffer) {
    const v = JSON.parse(raw.toString()) as {
      id?: string;
      orderId?: string;
      status?: string;
      sum?: number;
    };
    const id = v.orderId ?? v.id;
    if (!id) return null;
    return {
      eventId: v.id ?? id,
      providerInvoiceId: id,
      type:
        v.status === 'paid' || v.status === 'success' ? ('paid' as const) : ('pending' as const),
      ...(v.sum ? { paidAmount: { amount: String(v.sum), currency: 'RUB' } } : {}),
    };
  }
  ackResponse() {
    return ack();
  }
  async fetchStatus(id: string, cfg: ProviderConfig) {
    const raw = JSON.stringify({ orderId: id, shopId: cfg.shopId });
    const r = await json(`${base(cfg, 'https://api.lava.ru')}/business/invoice/status`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Signature: createHmac('sha256', String(cfg.secretKey)).update(raw).digest('hex'),
      },
      body: raw,
    });
    return {
      eventId: `poll:${id}:${String(r.status)}`,
      providerInvoiceId: id,
      type: r.status === 'paid' || r.status === 'success' ? 'paid' : 'pending',
    } as ProviderEvent;
  }
  /** Lava's read-only, signed `get-available-tariffs` answers only valid keys. */
  healthcheck(cfg: ProviderConfig) {
    return probe(async () => {
      const raw = JSON.stringify({ shopId: cfg.shopId });
      const r = await json(
        `${base(cfg, 'https://api.lava.ru')}/business/invoice/get-available-tariffs`,
        {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            Signature: createHmac('sha256', String(cfg.secretKey)).update(raw).digest('hex'),
          },
          body: raw,
        },
      );
      if (r.status_check !== true) throw new Error(`lava: ${String(r.error ?? 'refused')}`);
    });
  }
}

export class PlategaProvider implements PaymentProvider {
  readonly code = 'platega' as const;
  readonly capabilities = {
    receipts: false,
    webhooks: false,
    statusPolling: true,
    kind: 'redirect' as const,
    currencies: ['RUB'],
    minAmountMinor: 100n,
  };
  readonly configSchema = z.object({
    merchantId: z.string(),
    secret: z.string(),
    baseUrl: z.url().default('https://app.platega.io'),
  });
  async createInvoice(p: CreateInvoiceParams, cfg: ProviderConfig) {
    const body = {
      paymentDetails: { amount: Number(amount(p.amountMinor)), currency: 'RUB' },
      description: p.description,
      return: p.returnUrl,
      failedUrl: p.failUrl,
      payload: p.invoiceId,
      metadata: { userId: p.user.id },
    };
    const r = await json(`${base(cfg, 'https://app.platega.io')}/v2/transaction/process`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-MerchantId': String(cfg.merchantId),
        'X-Secret': String(cfg.secret),
      },
      body: JSON.stringify(body),
    });
    return {
      providerInvoiceId: String(r.transactionId),
      paymentUrl: String(r.url),
      expiresAt: p.expiresAt,
      rawSafe: r,
    };
  }
  verifyWebhook(_raw: Buffer, _headers: Record<string, string>, _ip: string, _cfg: ProviderConfig) {
    return { ok: false, reason: 'Platega is polled as the source of truth' };
  }
  parseWebhook() {
    return null;
  }
  ackResponse() {
    return ack();
  }
  async fetchStatus(id: string, cfg: ProviderConfig) {
    const r = await json(
      `${base(cfg, 'https://app.platega.io')}/transaction/${encodeURIComponent(id)}`,
      { headers: { 'X-MerchantId': String(cfg.merchantId), 'X-Secret': String(cfg.secret) } },
    );
    return {
      eventId: `poll:${id}:${String(r.status)}`,
      providerInvoiceId: id,
      type:
        r.status === 'CONFIRMED'
          ? 'paid'
          : r.status === 'CANCELED' || r.status === 'EXPIRED'
            ? 'canceled'
            : 'pending',
      ...(r.paymentDetails && typeof r.paymentDetails === 'object'
        ? {
            paidAmount: {
              amount: String((r.paymentDetails as Record<string, unknown>).amount),
              currency: String((r.paymentDetails as Record<string, unknown>).currency),
            },
          }
        : {}),
    } as ProviderEvent;
  }
  /** `GET /balance/all` answers 401 to wrong `X-MerchantId`/`X-Secret`. */
  healthcheck(cfg: ProviderConfig) {
    return probe(async () => {
      const response = await fetch(`${base(cfg, 'https://app.platega.io')}/balance/all`, {
        headers: { 'X-MerchantId': String(cfg.merchantId), 'X-Secret': String(cfg.secret) },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`payment provider HTTP ${response.status}`);
      if (!Array.isArray(await response.json())) throw new Error('platega: unexpected answer');
    });
  }
}

export class CryptoBotProvider implements PaymentProvider {
  readonly code = 'cryptobot' as const;
  readonly capabilities = {
    receipts: false,
    webhooks: true,
    statusPolling: true,
    kind: 'redirect' as const,
    currencies: ['RUB'],
    minAmountMinor: 100n,
  };
  readonly configSchema = z.object({
    token: z.string(),
    baseUrl: z.url().default('https://pay.crypt.bot/api'),
  });
  private auth(cfg: ProviderConfig) {
    return { 'Crypto-Pay-API-Token': String(cfg.token), 'content-type': 'application/json' };
  }
  async createInvoice(p: CreateInvoiceParams, cfg: ProviderConfig) {
    const r = await json(`${base(cfg, 'https://pay.crypt.bot/api')}/createInvoice`, {
      method: 'POST',
      headers: this.auth(cfg),
      body: JSON.stringify({
        currency_type: 'fiat',
        fiat: 'RUB',
        amount: amount(p.amountMinor),
        description: p.description,
        payload: p.invoiceId,
        expires_in: Math.max(1, Math.floor((p.expiresAt.getTime() - Date.now()) / 1000)),
      }),
    });
    const result = (r.result ?? r) as Record<string, unknown>;
    return {
      providerInvoiceId: String(result.invoice_id),
      paymentUrl: String(result.pay_url),
      expiresAt: p.expiresAt,
      rawSafe: r,
    };
  }
  verifyWebhook(raw: Buffer, headers: Record<string, string>, _ip: string, cfg: ProviderConfig) {
    const secret = createHash('sha256').update(String(cfg.token)).digest();
    return {
      ok: safeEqual(
        headers['crypto-pay-api-signature'] ?? '',
        createHmac('sha256', secret).update(raw).digest('hex'),
      ),
    };
  }
  parseWebhook(raw: Buffer) {
    const v = JSON.parse(raw.toString()) as {
      update_type?: string;
      payload?: Record<string, unknown>;
    };
    const p = v.payload;
    if (!p?.invoice_id) return null;
    return {
      eventId: String(p.invoice_id),
      providerInvoiceId: String(p.invoice_id),
      type: p.status === 'paid' ? ('paid' as const) : ('pending' as const),
      ...(p.amount
        ? { paidAmount: { amount: String(p.amount), currency: String(p.fiat ?? 'RUB') } }
        : {}),
    };
  }
  ackResponse() {
    return ack();
  }
  async fetchStatus(id: string, cfg: ProviderConfig) {
    const r = await json(
      `${base(cfg, 'https://pay.crypt.bot/api')}/getInvoices?invoice_ids=${encodeURIComponent(id)}`,
      { headers: this.auth(cfg) },
    );
    const result = (
      (r.result as Record<string, unknown>)?.items as Array<Record<string, unknown>> | undefined
    )?.[0];
    return {
      eventId: `poll:${id}:${String(result?.status)}`,
      providerInvoiceId: id,
      type: result?.status === 'paid' ? 'paid' : 'pending',
      ...(result?.amount
        ? { paidAmount: { amount: String(result.amount), currency: String(result.fiat ?? 'RUB') } }
        : {}),
    } as ProviderEvent;
  }
  /** Crypto Pay `getMe` exists to test the app token. */
  healthcheck(cfg: ProviderConfig) {
    return probe(async () => {
      const r = await json(`${base(cfg, 'https://pay.crypt.bot/api')}/getMe`, {
        headers: this.auth(cfg),
      });
      if (r.ok !== true) throw new Error('cryptobot: getMe refused');
    });
  }
}

const TELEGRAM_API = 'https://api.telegram.org';
const STAR_RATE_SCALE = 100_000_000n;

/**
 * Section 11.3.6 as changed by F37 (ADR-021): a Stars invoice is a top-up, so
 * it is priced by the rate only — `ceil(amount_minor / 100 × starsPerRub)`, at
 * least one star. `plans.price_overrides` is no longer read.
 */
export function starsAmount(amountMinor: bigint, starsPerRub: number): bigint {
  const rate = BigInt(starsPerRub.toFixed(8).replace('.', ''));
  const divisor = 100n * STAR_RATE_SCALE;
  const stars = (amountMinor * rate + divisor - 1n) / divisor;
  return stars > 0n ? stars : 1n;
}

/** `fx_rate = stars / (amount_minor / 100)`, truncated to the column's 8 places. */
function starsFxRate(stars: bigint, amountMinor: bigint): string {
  const scaled = (stars * 100n * STAR_RATE_SCALE) / amountMinor;
  return `${String(scaled / STAR_RATE_SCALE)}.${(scaled % STAR_RATE_SCALE).toString().padStart(8, '0')}`;
}

/** Length limits in characters, not UTF-16 units (Telegram's 1–32 and 1–255, Robokassa's 100 and 128). */
function truncate(text: string, limit: number): string {
  return Array.from(text).slice(0, limit).join('');
}

const starsConfigSchema = z.object({
  starsPerRub: z.number().positive().max(10_000),
  botToken: z.string().min(1),
  apiBase: z.url().default(TELEGRAM_API),
});

function starsConfig(cfg: ProviderConfig) {
  if (typeof cfg.starsPerRub !== 'number' || !(cfg.starsPerRub > 0))
    throw new Error('stars: starsPerRub is not configured');
  if (typeof cfg.botToken !== 'string' || !cfg.botToken)
    throw new Error('stars: the bot token is not configured');
  return starsConfigSchema.parse(cfg);
}

export class StarsProvider implements PaymentProvider {
  readonly code = 'stars' as const;
  readonly capabilities = {
    receipts: false,
    webhooks: false,
    statusPolling: false,
    kind: 'stars' as const,
    currencies: ['XTR'],
    minAmountMinor: 100n,
  };
  /**
   * What an administrator configures (section 11.3.6). The bot token comes
   * from `settings.bot.token` (ADR-012) and is added by `PaymentsService`.
   */
  readonly configSchema = z.object({ starsPerRub: z.number().positive().max(10_000) });
  async createInvoice(p: CreateInvoiceParams, cfg: ProviderConfig) {
    const config = starsConfig(cfg);
    const stars = starsAmount(p.amountMinor, config.starsPerRub);
    const title = truncate(p.description, 32) || 'RemnaRay';
    const description = truncate(p.description, 255) || title;
    const payload = `inv_${p.shopInvoiceId}`;
    const result = await json(
      `${config.apiBase.replace(/\/$/, '')}/bot${config.botToken}/createInvoiceLink`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title,
          description,
          payload,
          provider_token: '',
          currency: 'XTR',
          prices: [{ label: title, amount: Number(stars) }],
        }),
      },
    );
    if (result.ok !== true || typeof result.result !== 'string')
      throw new Error('stars: createInvoiceLink failed');
    return {
      providerInvoiceId: payload,
      starsInvoiceLink: result.result,
      providerAmount: {
        amount: String(stars),
        currency: 'XTR',
        fxRate: starsFxRate(stars, p.amountMinor),
      },
      expiresAt: p.expiresAt,
      // What the bot needs to send the same invoice with `sendInvoice`.
      rawSafe: {
        providerInvoiceId: payload,
        currency: 'XTR',
        stars: String(stars),
        title,
        description,
      },
    };
  }
  /**
   * Section 11.3.6: Stars have no HTTP webhook. `successful_payment` arrives as
   * a bot update and reaches the API through the internal bot boundary.
   */
  verifyWebhook() {
    return { ok: false, reason: 'Telegram Stars have no HTTP webhook' };
  }
  parseWebhook() {
    return null;
  }
  ackResponse() {
    return ack();
  }
  /** Telegram offers no status lookup; `successful_payment` is the only proof. */
  fetchStatus(id: string) {
    return Promise.resolve({
      eventId: `poll:${id}`,
      providerInvoiceId: id,
      type: 'pending' as const,
    });
  }
  async healthcheck(cfg: ProviderConfig) {
    const started = Date.now();
    try {
      const config = starsConfig(cfg);
      const result = await json(`${config.apiBase.replace(/\/$/, '')}/bot${config.botToken}/getMe`);
      if (result.ok !== true) throw new Error('stars: getMe failed');
      return { ok: true, latencyMs: Date.now() - started };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        error: error instanceof Error ? error.message : 'stars: healthcheck failed',
      };
    }
  }
}

export class BalanceProvider implements PaymentProvider {
  readonly code = 'balance' as const;
  readonly capabilities = {
    receipts: false,
    webhooks: false,
    statusPolling: false,
    kind: 'balance' as const,
    currencies: ['RUB'],
    minAmountMinor: 0n,
  };
  readonly configSchema = z.object({});
  createInvoice(p: CreateInvoiceParams) {
    return Promise.resolve({
      providerInvoiceId: p.invoiceId,
      expiresAt: p.expiresAt,
      rawSafe: { providerInvoiceId: p.invoiceId, kind: 'balance' },
    });
  }
  verifyWebhook() {
    return { ok: false, reason: 'balance has no webhooks' };
  }
  parseWebhook() {
    return null;
  }
  ackResponse() {
    return ack();
  }
  fetchStatus(id: string) {
    return Promise.resolve({ providerInvoiceId: id, type: 'paid' as const });
  }
  healthcheck() {
    return Promise.resolve({ ok: true, latencyMs: 0 });
  }
}

export const builtinProviders = [
  YooKassaProvider,
  RobokassaProvider,
  LavaProvider,
  PlategaProvider,
  CryptoBotProvider,
  StarsProvider,
  BalanceProvider,
];
