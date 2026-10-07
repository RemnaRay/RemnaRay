// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';

let config: unknown;
vi.mock('../lib/api', () => ({
  serverApi: () => ({ get: (_path: string, schema: z.ZodType) => schema.parse(config) }),
}));

const { getAdminLanguage } = await import('../lib/admin-config');

describe('administration language', () => {
  beforeEach(() => {
    config = undefined;
  });

  it('follows settings.admin.language rather than the site default', async () => {
    config = { locales: { default: 'ru', enabled: ['ru', 'en'], admin: 'en' } };
    expect(await getAdminLanguage()).toBe('en');
  });

  it('keeps the site default when the config carries no admin language', async () => {
    config = { locales: { default: 'en', enabled: ['ru', 'en'] } };
    expect(await getAdminLanguage()).toBe('en');
  });
});
