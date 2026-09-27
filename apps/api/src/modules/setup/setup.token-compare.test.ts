import { describe, expect, it, vi } from 'vitest';

const compared = vi.hoisted(() => ({ calls: 0 }));
vi.mock('node:crypto', async (importOriginal) => {
  const crypto = await importOriginal<typeof import('node:crypto')>();
  return {
    ...crypto,
    timingSafeEqual: (a: NodeJS.ArrayBufferView, b: NodeJS.ArrayBufferView) => {
      compared.calls += 1;
      return crypto.timingSafeEqual(a, b);
    },
  };
});

import { SetupService } from './setup.service';

describe('the setup token (R81)', () => {
  it('is compared with RR_SETUP_TOKEN in constant time', async () => {
    const previous = process.env.RR_SETUP_TOKEN;
    process.env.RR_SETUP_TOKEN = 'wizard-token';
    try {
      const values = new Map<string, string>();
      const infra = {
        redis: {
          incr: () => Promise.resolve(1),
          expire: () => Promise.resolve(1),
          del: () => Promise.resolve(1),
          set: (key: string, value: string) => {
            values.set(key, value);
            return Promise.resolve('OK');
          },
        },
        db: {
          setupState: {
            upsert: () => Promise.resolve({ id: 1, tokenHash: null }),
            update: () => Promise.resolve({}),
          },
        },
      };
      const unused = {} as never;
      const service = new SetupService(infra as never, unused, unused, unused, unused, unused);

      await expect(service.token({ token: 'wizard-tokeX' }, '10.0.0.9')).rejects.toMatchObject({
        status: 401,
      });
      expect(compared.calls).toBeGreaterThan(0);
    } finally {
      if (previous === undefined) delete process.env.RR_SETUP_TOKEN;
      else process.env.RR_SETUP_TOKEN = previous;
    }
  });
});
