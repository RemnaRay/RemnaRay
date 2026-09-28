import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z, ZodError } from 'zod';

import { decryptSetting, encryptSetting } from '../settings/settings.crypto';
import { ProvidersService } from './providers.service';

function service(
  rows: Record<string, unknown>[],
  health: { ok: boolean; latencyMs: number; error?: string },
) {
  const stored = [...rows];
  const db = {
    paymentProvider: {
      findMany: vi.fn().mockImplementation(() => Promise.resolve(stored)),
      findUnique: vi
        .fn()
        .mockImplementation(({ where }: { where: { code: string } }) =>
          Promise.resolve(stored.find((row) => row['code'] === where.code) ?? null),
        ),
      update: vi
        .fn()
        .mockImplementation(
          ({ where, data }: { where: { code: string }; data: Record<string, unknown> }) => {
            const row = stored.find((item) => item['code'] === where.code);
            if (row) Object.assign(row, data);
            return Promise.resolve(row);
          },
        ),
    },
  };
  const registry = {
    has: () => true,
    get: () => ({
      capabilities: { receipts: true, kind: 'redirect' },
      configSchema: z.object({ shopId: z.string().min(1), secretKey: z.string().min(1) }),
      healthcheck: vi.fn().mockResolvedValue(health),
    }),
  };
  return { stored, db, instance: new ProvidersService({ db } as never, registry as never) };
}

const row = {
  code: 'mock',
  enabled: true,
  sortOrder: 10,
  displayName: { ru: 'Mock', en: 'Mock' },
  configEnc: null,
  supportsReceipts: false,
  lastHealthcheckAt: null,
  lastHealthcheckOk: null,
  lastHealthcheckError: null,
};

describe('ProvidersService provider forms (FR-061)', () => {
  const appKey = randomBytes(32).toString('base64');
  afterEach(() => vi.unstubAllEnvs());

  it('lists the fields of each provider and keeps a secret the form left empty', async () => {
    vi.stubEnv('RR_APP_KEY', appKey);
    const test = service(
      [
        {
          ...row,
          configEnc: encryptSetting({ shopId: '1', secretKey: 'live_abc' }, appKey).enc,
        },
      ],
      { ok: true, latencyMs: 5 },
    );

    const listed = await test.instance.list();
    expect(listed.items[0]?.fields.map((field) => [field.key, field.secret])).toEqual([
      ['shopId', false],
      ['secretKey', true],
    ]);
    expect(listed.items[0]?.config).toMatchObject({ shopId: '1', secretKey: '••••_abc' });

    await test.instance.update('mock', { config: { shopId: '2', secretKey: '' } });
    expect(decryptSetting({ enc: String(test.stored[0]?.['configEnc']) }, appKey)).toEqual({
      shopId: '2',
      secretKey: 'live_abc',
    });
  });

  // R29: with a changed RR_APP_KEY the stored configuration no longer
  // decrypts, and `config()` read it as `{}`: the form's fields were merged
  // into nothing and encrypted under the new key, so the old configuration
  // was gone for good, a key rotation or a restored key notwithstanding.
  it('refuses to replace a stored configuration it cannot decrypt', async () => {
    vi.stubEnv('RR_APP_KEY', appKey);
    const otherKey = randomBytes(32).toString('base64');
    const stored = encryptSetting({ shopId: '1', secretKey: 'live_abc' }, otherKey).enc;
    const test = service([{ ...row, configEnc: stored }], { ok: true, latencyMs: 5 });

    await expect(
      test.instance.update('mock', { config: { shopId: '2', secretKey: 'live_new' } }),
    ).rejects.toMatchObject({ status: 409 });
    expect(test.stored[0]?.['configEnc']).toBe(stored);
    // Everything but the configuration still changes.
    await test.instance.update('mock', { enabled: false });
    expect(test.stored[0]?.['enabled']).toBe(false);
    expect(test.stored[0]?.['configEnc']).toBe(stored);
  });

  it('refuses a configuration the provider schema does not accept', async () => {
    vi.stubEnv('RR_APP_KEY', appKey);
    const test = service([{ ...row }], { ok: true, latencyMs: 5 });

    await expect(test.instance.update('mock', { config: { shopId: '' } })).rejects.toBeInstanceOf(
      ZodError,
    );
    expect(test.stored[0]?.['configEnc']).toBeNull();
  });
});

describe('ProvidersService (AC-061)', () => {
  it('does not list a row for the built-in balance, which is no provider (FR-070)', async () => {
    const test = service([{ ...row, code: 'balance' }, { ...row }], { ok: true, latencyMs: 5 });

    expect((await test.instance.list()).items.map((item) => item.code)).toEqual(['mock']);
  });

  it('reports a provider as offered only after a successful healthcheck', async () => {
    const test = service([{ ...row }], { ok: true, latencyMs: 5 });

    const before = await test.instance.list();
    expect(before.items[0]).toMatchObject({ lastHealthcheckOk: null, offeredToUsers: false });

    await test.instance.healthcheck('mock');
    const after = await test.instance.list();
    expect(after.items[0]).toMatchObject({ lastHealthcheckOk: true, offeredToUsers: true });
  });

  it('stops offering a provider whose healthcheck fails', async () => {
    const test = service([{ ...row, lastHealthcheckOk: true }], {
      ok: false,
      latencyMs: 20,
      error: 'timeout',
    });

    await test.instance.healthcheck('mock');
    const result = await test.instance.list();

    expect(result.items[0]).toMatchObject({
      lastHealthcheckOk: false,
      lastHealthcheckError: 'timeout',
      offeredToUsers: false,
    });
  });

  it('records a thrown healthcheck as a failure instead of crashing', async () => {
    const test = service([{ ...row }], { ok: true, latencyMs: 1 });
    test.instance = new ProvidersService(
      { db: test.db } as never,
      {
        has: () => true,
        get: () => ({
          capabilities: { receipts: false, kind: 'redirect' },
          healthcheck: () => Promise.reject(new Error('connection refused')),
        }),
      } as never,
    );

    const result = await test.instance.healthcheck('mock');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('connection refused');
  });

  it('runs a healthcheck whenever the provider configuration changes', async () => {
    const test = service([{ ...row }], { ok: true, latencyMs: 3 });
    const result = await test.instance.update('mock', { enabled: true, reason: 'enable' });

    expect((result.after as { health: { ok: boolean } }).health.ok).toBe(true);
    expect(test.stored[0]?.['lastHealthcheckOk']).toBe(true);
  });

  it('masks provider secrets in the listing', async () => {
    process.env.RR_APP_KEY = Buffer.alloc(32, 5).toString('base64');
    const test = service([{ ...row }], { ok: true, latencyMs: 1 });
    const masked = await test.instance.update('mock', {
      config: { shopId: '123', secretKey: 'live_abcdef123456' },
      reason: 'configure',
    });

    expect(JSON.stringify(masked.after)).not.toContain('live_abcdef123456');
    expect(JSON.stringify(masked.after)).toContain('3456');
  });

  it('checks Stars with the bot token from settings (ADR-012)', async () => {
    const healthcheck = vi.fn().mockResolvedValue({ ok: true, latencyMs: 1 });
    const test = service([{ ...row, code: 'stars' }], { ok: true, latencyMs: 1 });
    test.instance = new ProvidersService(
      { db: test.db } as never,
      {
        has: () => true,
        get: () => ({ capabilities: { receipts: false, kind: 'stars' }, healthcheck }),
      } as never,
      {
        get: (key: string) => Promise.resolve(key === 'bot.token' ? '123:bot' : undefined),
      } as never,
    );

    await test.instance.healthcheck('stars');

    expect(healthcheck).toHaveBeenCalledWith(
      expect.objectContaining({ botToken: '123:bot', apiBase: expect.any(String) as string }),
    );
  });
});
