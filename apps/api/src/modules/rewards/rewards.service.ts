import { Injectable } from '@nestjs/common';

import { Infrastructure } from '../../infra/infra.module';
import type { RewardHooksPort } from '../payments/payments.repository';
import { SettingsService } from '../settings/settings.service';
import { accrueReferralReward, grantInviteeBonus, reverseReferralReward } from './referrals.engine';
import { applyReservedPromocode, releaseReservedPromocode } from './promocodes.engine';
import type { ReferralConfig, TrialLimits, Tx } from './rewards.types';

@Injectable()
export class RewardsService implements RewardHooksPort {
  constructor(
    private readonly infra: Infrastructure,
    private readonly settings: SettingsService,
  ) {}

  async config(): Promise<ReferralConfig> {
    const bonus = (await this.settings.get('referral.invitee_bonus')) as {
      type: 'none' | 'days' | 'balance';
      value: number;
    };
    return {
      enabled: Boolean(await this.settings.get('referral.enabled')),
      mode: (await this.settings.get('referral.mode')) as ReferralConfig['mode'],
      percent: Number(await this.settings.get('referral.percent')),
      fixedMinor: BigInt(String(await this.settings.get('referral.fixed_minor'))),
      allMonths: Number(await this.settings.get('referral.all_months')),
      inviteeBonus: bonus,
      inviteeBonusTrigger: (await this.settings.get(
        'referral.invitee_bonus_trigger',
      )) as ReferralConfig['inviteeBonusTrigger'],
      holdHours: Number(await this.settings.get('referral.hold_hours')),
      maxRewardsPerDay: Number(await this.settings.get('referral.max_rewards_per_day')),
      minSourceAmountMinor: BigInt(
        String(await this.settings.get('referral.min_source_amount_minor')),
      ),
      countTopups: Boolean(await this.settings.get('referral.count_topups')),
    };
  }

  async trialLimits(): Promise<TrialLimits> {
    return {
      days: Number(await this.settings.get('trial.days')),
      trafficGb: Number(await this.settings.get('trial.traffic_gb')),
      deviceLimit: Number(await this.settings.get('trial.device_limit')),
      squads: (await this.settings.get('trial.squads')) as string[],
    };
  }

  async onPaid(
    tx: Tx,
    source: { id: string; userId: string; type: string; amountMinor: bigint },
  ): Promise<void> {
    await accrueReferralReward(tx, await this.config(), source, await this.trialLimits());
  }

  async onRefund(
    tx: Tx,
    source: { id: string; amountMinor: bigint },
    refundedMinor: bigint,
  ): Promise<void> {
    await reverseReferralReward(tx, source.id, refundedMinor, source.amountMinor);
  }

  async onInvoiceSettled(tx: Tx, invoiceId: string): Promise<void> {
    await applyReservedPromocode(tx, invoiceId);
  }

  async onInvoiceReleased(tx: Tx, invoiceId: string): Promise<void> {
    await releaseReservedPromocode(tx, invoiceId);
  }

  /** Cron `maintenance.referral-release`: held rewards become spendable. */
  async releaseHeld(now = new Date()): Promise<{ released: number }> {
    const result = await this.infra.db.referralReward.updateMany({
      where: { status: 'held', holdUntil: { lte: now } },
      data: { status: 'released' },
    });
    return { released: result.count };
  }

  /** Invitee bonus at sign-up, used by the attribution path. */
  async grantSignupBonus(userId: string): Promise<void> {
    const config = await this.config();
    if (!config.enabled || config.inviteeBonusTrigger !== 'signup') return;
    const trial = await this.trialLimits();
    await this.infra.db.$transaction(async (tx) => {
      await grantInviteeBonus(tx, config, userId, trial);
    });
  }

  /**
   * Manual reversal from the admin console (section 15.4). The source
   * transaction is locked first, as a refund locks it (repair queue R17):
   * both then take the accounts and the reward row in the same order and
   * never deadlock; the second finds the first's reversal.
   */
  async reverseReward(rewardId: string): Promise<{ reversedMinor: number }> {
    return this.infra.db.$transaction(async (tx) => {
      const reward = await tx.referralReward.findUnique({ where: { id: rewardId } });
      if (!reward || reward.status === 'reversed') return { reversedMinor: 0 };
      await tx.$queryRaw`
        SELECT id FROM transactions WHERE id = ${reward.sourceTransactionId}::uuid FOR UPDATE`;
      const source = await tx.transaction.findUnique({
        where: { id: reward.sourceTransactionId },
      });
      const amount = await reverseReferralReward(
        tx,
        reward.sourceTransactionId,
        source?.amountMinor ?? reward.amountMinor,
        source?.amountMinor ?? reward.amountMinor,
      );
      return { reversedMinor: Number(amount) };
    });
  }
}
