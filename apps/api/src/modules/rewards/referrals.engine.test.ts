import { describe, expect, it } from 'vitest';

import { accrueReferralReward } from './referrals.engine';
import type { ReferralConfig, Tx } from './rewards.types';

const config: ReferralConfig = {
  enabled: true,
  mode: 'percent_all',
  percent: 20,
  fixedMinor: 0n,
  allMonths: 0,
  inviteeBonus: { type: 'none', value: 0 },
  inviteeBonusTrigger: 'first_paid',
  holdHours: 0,
  maxRewardsPerDay: 20,
  minSourceAmountMinor: 0n,
};
const trial = { days: 3, trafficGb: 10, deviceLimit: 1, squads: [] };

/** A transaction that fails the test if the engine reads or writes anything. */
const untouched = new Proxy({} as Tx, {
  get(_target, property) {
    throw new Error(`the engine touched tx.${String(property)}`);
  },
});

describe('accrueReferralReward (F37, ADR-021)', () => {
  it.each(['purchase', 'plan_change', 'refund', 'referral_reward', 'promo_bonus'])(
    'never takes a %s as a source (R135: a purchase spends a top-up)',
    async (type) => {
      await expect(
        accrueReferralReward(
          untouched,
          config,
          { id: 'source', userId: 'referee', type, amountMinor: 29900n },
          trial,
        ),
      ).resolves.toBeNull();
    },
  );

  it('reads the attribution for a top-up', async () => {
    await expect(
      accrueReferralReward(
        untouched,
        config,
        { id: 'source', userId: 'referee', type: 'topup', amountMinor: 29900n },
        trial,
      ),
    ).rejects.toThrow('the engine touched tx.referralAttribution');
  });
});
