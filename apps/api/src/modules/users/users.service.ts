import { Injectable, Optional } from '@nestjs/common';

import { RewardsService } from '../rewards/rewards.service';
import { SettingsService } from '../settings/settings.service';
import { parseStartPayload, userUpsertSchema } from './users.schemas';
import type { UserSummary, UsersRepositoryPort, UserUpsertResult } from './users.repository';

@Injectable()
export class UsersService {
  constructor(
    private readonly repository: UsersRepositoryPort,
    private readonly settings: SettingsService,
    @Optional() private readonly rewards?: RewardsService,
  ) {}

  /** The user by id; none for an unknown or anonymized one. */
  summary(id: string): Promise<UserSummary | null> {
    return this.repository.findSummary(id);
  }

  async upsert(value: unknown): Promise<UserUpsertResult> {
    const input = userUpsertSchema.parse(value);
    const configuredLanguage = await this.settings.get('locale.default');
    const defaultLanguage = configuredLanguage === 'en' ? configuredLanguage : 'ru';
    const result = await this.repository.upsert(
      input,
      parseStartPayload(input.startPayload),
      defaultLanguage,
    );
    // Section 15.2: the `signup` trigger grants the invitee bonus as soon as the
    // attribution exists, before any payment.
    if (result.attributed) await this.rewards?.grantSignupBonus(result.user.id);
    return result;
  }
}
