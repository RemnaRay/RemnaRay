import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpException } from '@nestjs/common';
import * as OTPAuth from 'otpauth';
import { z, ZodError } from 'zod';

import { decryptSetting } from '../settings/settings.crypto';
import { SetupService } from './setup.service';

const APP_KEY = Buffer.alloc(32, 7).toString('base64');

/** A Valkey stand-in with just the commands the wizard uses. */
function redis() {
  const store = new Map<string, string>();
  return {
    store,
    published: [] as { channel: string; message: string }[],
    get: (key: string) => Promise.resolve(store.get(key) ?? null),
    set: (key: string, value: string) => {
      store.set(key, value);
      return Promise.resolve('OK');
    },
    del: (key: string) => Promise.resolve(store.delete(key) ? 1 : 0),
    exists: (key: string) => Promise.resolve(store.has(key) ? 1 : 0),
    expire: () => Promise.resolve(1),
    incr(key: string) {
      const next = Number(store.get(key) ?? '0') + 1;
      store.set(key, String(next));
      return Promise.resolve(next);
    },
    publish(channel: string, message: string) {
      this.published.push({ channel, message });
      return Promise.resolve(1);
    },
  };
}

function db() {
  const setupState: Record<string, unknown> = {
    id: 1,
    completed: false,
    currentStep: null,
    data: {},
    tokenHash: null,
  };
  const admins: Record<string, unknown>[] = [];
  const providers: Record<string, unknown>[] = [];
  const outbox: Record<string, unknown>[] = [];
  const audit: Record<string, unknown>[] = [];
  const client = {
    setupState: {
      upsert: () => Promise.resolve({ ...setupState }),
      update: ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(setupState, data);
        return Promise.resolve({ ...setupState });
      },
    },
    admin: {
      upsert: ({ create }: { create: Record<string, unknown> }) => {
        const row = { id: `admin-${String(admins.length + 1)}`, ...create };
        admins.push(row);
        return Promise.resolve(row);
      },
    },
    plan: { findUnique: () => Promise.resolve(null) },
    paymentProvider: {
      upsert: ({ create }: { create: Record<string, unknown> }) => {
        providers.push(create);
        return Promise.resolve(create);
      },
    },
    outboxJob: {
      create: ({ data }: { data: Record<string, unknown> }) => {
        outbox.push(data);
        return Promise.resolve(data);
      },
    },
    auditLog: {
      create: ({ data }: { data: Record<string, unknown> }) => {
        audit.push(data);
        return Promise.resolve(data);
      },
    },
    $transaction: (run: (tx: unknown) => Promise<unknown>) => run(client),
  };
  return { client, setupState, admins, providers, outbox, audit };
}

function settings() {
  const values = new Map<string, unknown>();
  return {
    values,
    get: (key: string) => Promise.resolve(values.get(key) ?? ''),
    set: (patch: Record<string, Record<string, unknown>>) => {
      for (const [group, entries] of Object.entries(patch))
        for (const [name, value] of Object.entries(entries)) values.set(`${group}.${name}`, value);
      return Promise.resolve();
    },
  };
}

function build() {
  const cache = redis();
  const store = db();
  const config = settings();
  const plans = { create: vi.fn().mockResolvedValue({ id: 'plan-1', slug: 'month' }) };
  const themes = { list: () => [{ slug: 'manta', builtin: false }], load: vi.fn() };
  const registry = {
    has: () => true,
    get: () => ({
      capabilities: { receipts: false, kind: 'redirect' },
      configSchema: z.looseObject({}) as z.ZodType,
      healthcheck: vi.fn().mockResolvedValue({ ok: true, latencyMs: 3 }),
    }),
    list: () => [
      {
        code: 'mock',
        capabilities: { receipts: false, kind: 'redirect' },
        configSchema: z.looseObject({}) as z.ZodType,
      },
    ],
  };
  const notify = { alert: vi.fn().mockResolvedValue({ delivered: 1, deduplicated: false }) };
  const service = new SetupService(
    { db: store.client, redis: cache } as never,
    config as never,
    plans as never,
    themes as never,
    registry as never,
    notify as never,
  );
  return { service, cache, store, config, plans, themes, registry, notify };
}

async function failure(run: Promise<unknown>): Promise<{ status: number; code: string }> {
  try {
    await run;
    return { status: 200, code: 'OK' };
  } catch (error) {
    if (!(error instanceof HttpException)) throw error;
    const body = error.getResponse() as { error?: { code?: string } };
    return { status: error.getStatus(), code: body.error?.code ?? 'NONE' };
  }
}

beforeEach(() => {
  process.env.RR_APP_KEY = APP_KEY;
  process.env.RR_SETUP_TOKEN = 'wizard-token';
});

describe('SetupService token step (section 17.4 step 0)', () => {
  it('rejects a wrong token and blocks the address after five attempts', async () => {
    const test = build();

    for (let attempt = 0; attempt < 5; attempt += 1)
      expect(await failure(test.service.token({ token: 'wrong' }, '10.0.0.1'))).toEqual({
        status: 401,
        code: 'UNAUTHENTICATED',
      });

    expect(await failure(test.service.token({ token: 'wizard-token' }, '10.0.0.1'))).toEqual({
      status: 429,
      code: 'RATE_LIMITED',
    });
  });

  it('accepts the environment token once, then verifies against the stored hash', async () => {
    const test = build();

    const { sessionId } = await test.service.token({ token: 'wizard-token' }, '10.0.0.2');
    expect(sessionId).toHaveLength(43);
    expect(test.store.setupState['tokenHash']).toMatch(/^\$argon2/u);

    delete process.env.RR_SETUP_TOKEN;
    const second = await test.service.token({ token: 'wizard-token' }, '10.0.0.3');
    expect(second.sessionId).toHaveLength(43);
  });
});

describe('SetupService state', () => {
  it('serves the draft only to a wizard session', async () => {
    const test = build();
    expect(await test.service.state('')).toMatchObject({ authenticated: false, step: '0' });

    const { sessionId } = await test.service.token({ token: 'wizard-token' }, '10.0.0.4');
    const state = await test.service.state(sessionId);
    expect(state).toMatchObject({ authenticated: true, completed: false, step: '1' });
  });
});

describe('SetupService steps', () => {
  it('creates the administrator only after the TOTP code is confirmed', async () => {
    const test = build();
    const { sessionId } = await test.service.token({ token: 'wizard-token' }, '10.0.0.5');
    const credentials = {
      email: 'owner@example.test',
      password: 'SetupPassword123',
      passwordConfirm: 'SetupPassword123',
    };

    const enrolment = (await test.service.submit('1', credentials, sessionId)) as {
      confirmed: boolean;
      otpauthUrl: string;
      qrPng: string;
    };
    expect(enrolment.confirmed).toBe(false);
    expect(enrolment.qrPng.length).toBeGreaterThan(100);
    expect(test.store.admins).toHaveLength(0);

    expect(
      await failure(test.service.submit('1', { ...credentials, code: '000000' }, sessionId)),
    ).toMatchObject({ status: 401, code: 'ADMIN_TOTP_INVALID' });

    const code = OTPAuth.URI.parse(enrolment.otpauthUrl).generate();
    const confirmed = (await test.service.submit('1', { ...credentials, code }, sessionId)) as {
      confirmed: boolean;
    };
    expect(confirmed.confirmed).toBe(true);
    expect(test.store.admins[0]).toMatchObject({
      email: 'owner@example.test',
      role: 'admin',
      totpEnabled: true,
    });
    expect(test.store.setupState['currentStep']).toBe('2');
    expect(test.config.values.get('setup.step')).toBe('2');
  });

  it('refuses a password shorter than the twelve characters section 17.4 requires', async () => {
    const test = build();
    const { sessionId } = await test.service.token({ token: 'wizard-token' }, '10.0.0.6');
    await expect(
      test.service.submit(
        '1',
        { email: 'owner@example.test', password: 'short', passwordConfirm: 'short' },
        sessionId,
      ),
    ).rejects.toThrow();
  });

  it('writes the domain into settings and advances the draft', async () => {
    const test = build();
    const { sessionId } = await test.service.token({ token: 'wizard-token' }, '10.0.0.7');

    await test.service.submit(
      '2',
      { main: 'shop.example.com', acmeEmail: 'ops@example.com' },
      sessionId,
    );

    expect(test.config.values.get('domain.main')).toBe('shop.example.com');
    expect(test.config.values.get('domain.acme_email')).toBe('ops@example.com');
    expect(test.store.setupState['currentStep']).toBe('3');
  });

  it('creates the first plan from the untransformed body and saves the trial', async () => {
    const test = build();
    const { sessionId } = await test.service.token({ token: 'wizard-token' }, '10.0.0.10');
    const plan = {
      slug: 'month',
      name: { ru: 'Месяц', en: 'Month' },
      durationDays: 30,
      deviceLimit: 3,
      squads: ['00000000-0000-4000-8000-000000000001'],
      priceMinor: '29900',
    };

    await test.service.submit(
      '6',
      {
        plan,
        trial: { enabled: true, days: 3, traffic_gb: 10, device_limit: 1, squads: [] },
      },
      sessionId,
    );

    // `PlansService.create` parses its own input, so it must never be handed
    // the already transformed plan: `priceMinor` would arrive as a bigint.
    expect(test.plans.create).toHaveBeenCalledWith(plan);
    expect(test.config.values.get('trial.days')).toBe(3);
    expect(test.store.setupState['currentStep']).toBe('7');
  });

  it('needs a wizard session for every step', async () => {
    const test = build();
    expect(
      await failure(test.service.submit('2', { main: 'x.test', acmeEmail: '' }, 'nope')),
    ).toMatchObject({ status: 401 });
  });
});

describe('SetupService finish (step 8)', () => {
  it('refuses to launch while a required step is missing', async () => {
    const test = build();
    const { sessionId } = await test.service.token({ token: 'wizard-token' }, '10.0.0.8');

    expect(await failure(test.service.finish(sessionId))).toMatchObject({
      status: 400,
      code: 'VALIDATION_ERROR',
    });
  });

  it('completes the setup, queues the reconciliation and alerts the administrators', async () => {
    const test = build();
    const { sessionId } = await test.service.token({ token: 'wizard-token' }, '10.0.0.9');
    Object.assign(test.store.setupState, {
      data: { admin: {}, domain: {}, panel: {}, bot: {}, brand: {}, plan: {} },
    });
    test.config.values.set('bot.username', 'manta_bot');
    test.config.values.set('domain.main', 'shop.example.com');

    const result = await test.service.finish(sessionId);

    expect(result).toEqual({
      completed: true,
      botLink: 'https://t.me/manta_bot',
      adminUrl: 'https://shop.example.com/admin',
    });
    expect(test.config.values.get('setup.completed')).toBe(true);
    expect(test.store.setupState['completed']).toBe(true);
    expect(test.store.outbox[0]).toMatchObject({ queue: 'panel', name: 'panel.reconcile-all' });
    expect(test.cache.published.map((item) => item.channel)).toContain('rr:bot.reconfigure');
    expect(test.notify.alert).toHaveBeenCalledWith({ type: 'setup.completed' });
    expect(test.cache.store.has(`rr:setup:${sessionId}`)).toBe(false);
  });
});

describe('SetupService payment providers (section 17.4 step 7)', () => {
  it('describes each provider form and stores a configuration its schema accepts (FR-061)', async () => {
    const test = build();
    const healthcheck = vi.fn().mockResolvedValue({ ok: true, latencyMs: 1 });
    const provider = {
      code: 'mock',
      capabilities: { receipts: false, kind: 'redirect' },
      configSchema: z.object({
        shopId: z.string().min(1),
        secretKey: z.string().min(1),
        baseUrl: z.url().default('https://api.provider.test'),
      }) as z.ZodType,
      healthcheck,
    };
    test.registry.get = () => provider;
    test.registry.list = () => [provider];
    const { sessionId } = await test.service.token({ token: 'wizard-token' }, '10.0.0.7');

    const state = (await test.service.state(sessionId)) as {
      providers: { code: string; fields: { key: string; secret: boolean }[] }[];
    };
    expect(state.providers[0]?.fields.map((field) => [field.key, field.secret])).toEqual([
      ['shopId', false],
      ['secretKey', true],
      ['baseUrl', false],
    ]);

    await expect(
      test.service.checkProvider({ code: 'mock', config: { shopId: '1' } }, sessionId),
    ).rejects.toBeInstanceOf(ZodError);
    await expect(
      test.service.submit(
        '7',
        { providers: [{ code: 'mock', config: { shopId: '1' } }] },
        sessionId,
      ),
    ).rejects.toBeInstanceOf(ZodError);
    expect(test.store.providers).toHaveLength(0);

    await test.service.submit(
      '7',
      { providers: [{ code: 'mock', config: { shopId: '1', secretKey: 's' } }] },
      sessionId,
    );
    const stored = decryptSetting({ enc: String(test.store.providers[0]?.['configEnc']) }, APP_KEY);
    expect(stored).toEqual({ shopId: '1', secretKey: 's', baseUrl: 'https://api.provider.test' });
  });

  it('neither offers nor saves the built-in balance as a provider (FR-070)', async () => {
    const test = build();
    test.registry.list = () => [
      {
        code: 'mock',
        capabilities: { receipts: false, kind: 'redirect' },
        configSchema: z.looseObject({}),
      },
      {
        code: 'balance',
        capabilities: { receipts: false, kind: 'balance' },
        configSchema: z.object({}),
      },
    ];
    test.registry.get = (code?: string) => ({
      capabilities: { receipts: false, kind: code === 'balance' ? 'balance' : 'redirect' },
      configSchema: z.looseObject({}),
      healthcheck: vi.fn().mockResolvedValue({ ok: true, latencyMs: 1 }),
    });
    const { sessionId } = await test.service.token({ token: 'wizard-token' }, '10.0.0.8');

    const state = (await test.service.state(sessionId)) as { providers: { code: string }[] };
    expect(state.providers.map((provider) => provider.code)).toEqual(['mock']);
    expect(
      await failure(test.service.checkProvider({ code: 'balance', config: {} }, sessionId)),
    ).toMatchObject({ status: 404 });
    expect(
      await failure(
        test.service.submit('7', { providers: [{ code: 'balance', config: {} }] }, sessionId),
      ),
    ).toMatchObject({ status: 404 });
    expect(test.store.providers).toHaveLength(0);
  });

  it('checks Telegram Stars with the bot token saved in step 4 (ADR-012)', async () => {
    const test = build();
    const healthcheck = vi.fn().mockResolvedValue({ ok: true, latencyMs: 1 });
    test.registry.get = () => ({
      capabilities: { receipts: false, kind: 'stars' },
      configSchema: z.object({ starsPerRub: z.number() }),
      healthcheck,
    });
    await test.config.set({ bot: { token: '123:bot' } });
    const { sessionId } = await test.service.token({ token: 'wizard-token' }, '10.0.0.9');

    await test.service.checkProvider({ code: 'stars', config: { starsPerRub: 0.75 } }, sessionId);

    expect(healthcheck).toHaveBeenCalledWith(
      expect.objectContaining({ starsPerRub: 0.75, botToken: '123:bot' }),
    );
  });

  it('takes an optional support bot and the operators’ chat in step 4 (F35)', async () => {
    const test = build();
    const bots: Record<string, { id: number; username: string }> = {
      '123:shop-token': { id: 123, username: 'manta_bot' },
      '777:help-token': { id: 777, username: 'manta_help_bot' },
    };
    vi.stubGlobal('fetch', (url: string) => {
      const token = decodeURIComponent(url.split('/bot')[1]?.split('/')[0] ?? '');
      const bot = bots[token];
      return Promise.resolve(
        Response.json(bot ? { ok: true, result: bot } : { ok: false, error_code: 401 }),
      );
    });
    const { sessionId } = await test.service.token({ token: 'wizard-token' }, '10.0.0.10');
    const step = { token: '123:shop-token', supportContact: '@manta_help' };
    try {
      expect(
        await failure(
          test.service.submit('4', { ...step, supportBotToken: '999:nope-token' }, sessionId),
        ),
      ).toEqual({ status: 400, code: 'SUPPORT_BOT_INVALID' });
      expect(
        await failure(
          test.service.submit('4', { ...step, supportBotToken: '123:shop-token' }, sessionId),
        ),
      ).toEqual({ status: 400, code: 'SUPPORT_BOT_SAME' });

      await expect(
        test.service.submit(
          '4',
          { ...step, supportBotToken: '777:help-token', supportChatId: -100500 },
          sessionId,
        ),
      ).resolves.toMatchObject({ saved: true, supportBot: 'manta_help_bot' });
      expect(test.config.values.get('bot.support_token')).toBe('777:help-token');
      expect(test.config.values.get('bot.support_username')).toBe('manta_help_bot');
      expect(test.config.values.get('bot.support_webhook_secret_path')).toMatch(/^[\w-]{32}$/u);
      expect(test.config.values.get('brand.support_forward_chat_id')).toBe(-100500);

      // Without the optional fields, support stays in the shop bot.
      const plain = build();
      const second = await plain.service.token({ token: 'wizard-token' }, '10.0.0.11');
      await plain.service.submit('4', step, second.sessionId);
      expect(plain.config.values.has('bot.support_token')).toBe(false);
      expect(plain.config.values.has('brand.support_forward_chat_id')).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
