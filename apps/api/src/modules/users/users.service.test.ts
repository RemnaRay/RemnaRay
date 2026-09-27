import { describe, expect, it } from 'vitest';

import { SettingsService } from '../settings/settings.service';
import { UsersService } from './users.service';
import type { ParsedStartPayload } from './users.schemas';
import type { UsersRepositoryPort, UserUpsertResult } from './users.repository';

class MemoryUsersRepository implements UsersRepositoryPort {
  findSummary() {
    return Promise.resolve(null);
  }

  calls: Array<{ defaultLanguage: string; payload: ParsedStartPayload }> = [];

  upsert(
    _input: Parameters<UsersRepositoryPort['upsert']>[0],
    payload: ParsedStartPayload,
    defaultLanguage: string,
  ): Promise<UserUpsertResult> {
    this.calls.push({ defaultLanguage, payload });
    return Promise.resolve({
      user: {
        id: 'user-1',
        telegramId: '123',
        username: null,
        firstName: null,
        language: defaultLanguage,
        referralCode: 'ABCD2345',
        isBanned: false,
      },
      created: true,
      attributed: Boolean(payload.referralCode),
      promoReserved: Boolean(payload.promoCode),
      ...(payload.planSlug ? { planSlug: payload.planSlug } : {}),
    });
  }
}

describe('UsersService', () => {
  it('uses the configured locale and returns parsed payload flags', async () => {
    const repository = new MemoryUsersRepository();
    const settings = {
      get: () => Promise.resolve('en'),
    } as unknown as SettingsService;
    const service = new UsersService(repository, settings);

    const result = await service.upsert({
      telegramId: '123',
      languageCode: 'xx',
      startPayload: 'ref_ABCD2345',
    });

    expect(result.user.language).toBe('en');
    expect(result.attributed).toBe(true);
    expect(repository.calls[0]?.payload).toEqual({ referralCode: 'ABCD2345' });
  });

  it('preserves the plan payload for the bot client', async () => {
    const repository = new MemoryUsersRepository();
    const settings = { get: () => Promise.resolve('ru') } as unknown as SettingsService;
    const service = new UsersService(repository, settings);

    const result = await service.upsert({ telegramId: 123, startPayload: 'plan_pro' });

    expect(result.planSlug).toBe('pro');
    expect(result.user.telegramId).toBe('123');
  });
});
