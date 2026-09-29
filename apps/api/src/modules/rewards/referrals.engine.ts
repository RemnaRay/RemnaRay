import { queuePanelSync } from '../remnawave/panel-jobs';
import { emitWebhook, minor, subscriptionData } from '../webhooks/outgoing';
import type { ReferralConfig, SourceTransaction, TrialLimits, Tx } from './rewards.types';

/** F37 (ADR-021): money received is the source — a top-up; a purchase spends it. */
const SOURCE_TYPES = new Set(['topup']);

async function accountId(tx: Tx, kind: string, userId?: string): Promise<string> {
  if (kind === 'user' && userId) {
    await tx.$executeRawUnsafe(
      `INSERT INTO accounts (kind, user_id, currency) VALUES ('user'::account_kind, $1::uuid, 'RUB') ON CONFLICT DO NOTHING`,
      userId,
    );
    const rows = await tx.$queryRawUnsafe<{ id: string }[]>(
      `SELECT id FROM accounts WHERE kind = 'user'::account_kind AND user_id = $1::uuid LIMIT 1`,
      userId,
    );
    if (!rows[0]) throw new Error('ACCOUNT_NOT_FOUND');
    return rows[0].id;
  }
  const existing = await tx.$queryRawUnsafe<{ id: string }[]>(
    `SELECT id FROM accounts WHERE kind = $1::account_kind AND currency = 'RUB' LIMIT 1`,
    kind,
  );
  if (existing[0]) return existing[0].id;
  const created = await tx.$queryRawUnsafe<{ id: string }[]>(
    `INSERT INTO accounts (kind, currency) VALUES ($1::account_kind, 'RUB') RETURNING id`,
    kind,
  );
  if (!created[0]) throw new Error('ACCOUNT_NOT_FOUND');
  return created[0].id;
}

async function post(
  tx: Tx,
  input: {
    userId: string;
    type: 'referral_reward' | 'referral_reversal' | 'promo_bonus';
    amountMinor: bigint;
    parentId?: string;
    debitKind: string;
    creditKind: string;
    creditUserId?: string;
    debitUserId?: string;
    reason?: string;
  },
): Promise<{ id: string }> {
  const debit = await accountId(tx, input.debitKind, input.debitUserId);
  const credit = await accountId(tx, input.creditKind, input.creditUserId);
  // Section 11.7: both accounts locked in `id` order before either moves.
  // Inside a payment the payment already holds them; the console's reversal
  // (15.4) takes them here.
  await tx.$queryRawUnsafe(
    `SELECT id FROM accounts WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
    [debit, credit],
  );
  const transaction = await tx.transaction.create({
    data: {
      userId: input.userId,
      type: input.type,
      status: 'completed',
      amountMinor: input.amountMinor,
      currency: 'RUB',
      ...(input.parentId ? { parentId: input.parentId } : {}),
      ...(input.reason ? { reason: input.reason } : {}),
    },
  });
  await tx.ledgerEntry.create({
    data: {
      transactionId: transaction.id,
      debitAccountId: debit,
      creditAccountId: credit,
      amountMinor: input.amountMinor,
      currency: 'RUB',
    },
  });
  await tx.account.update({
    where: { id: debit },
    data: { balanceMinor: { decrement: input.amountMinor } },
  });
  await tx.account.update({
    where: { id: credit },
    data: { balanceMinor: { increment: input.amountMinor } },
  });
  return transaction;
}

/**
 * Section 15.2 accrual. Runs inside the payment transaction so a reward can
 * never exist without its source, and is idempotent on `source_transaction_id`.
 */
export async function accrueReferralReward(
  tx: Tx,
  config: ReferralConfig,
  source: SourceTransaction,
  trial: TrialLimits,
  now = new Date(),
): Promise<{ rewardId: string; amountMinor: bigint } | null> {
  if (!config.enabled) return null;
  if (!SOURCE_TYPES.has(source.type)) return null;
  if (source.amountMinor < config.minSourceAmountMinor) return null;

  const attribution = await tx.referralAttribution.findUnique({
    where: { refereeId: source.userId },
  });
  if (!attribution || attribution.status === 'rejected') return null;

  const isFirst = attribution.status === 'pending';
  let amount: bigint;
  if (config.mode === 'percent_first' || config.mode === 'fixed_first') {
    if (!isFirst) return null;
    amount =
      config.mode === 'fixed_first'
        ? config.fixedMinor
        : (source.amountMinor * BigInt(config.percent)) / 100n;
  } else {
    if (config.allMonths > 0) {
      const limit = new Date(attribution.createdAt);
      limit.setUTCMonth(limit.getUTCMonth() + config.allMonths);
      if (now > limit) return null;
    }
    amount = (source.amountMinor * BigInt(config.percent)) / 100n;
  }
  if (amount <= 0n) return null;

  const existing = await tx.referralReward.findUnique({
    where: { sourceTransactionId: source.id },
  });
  if (existing) return null;

  const startOfDay = new Date(now);
  startOfDay.setUTCHours(0, 0, 0, 0);
  const todayCount = await tx.referralReward.count({
    where: {
      createdAt: { gte: startOfDay },
      status: { not: 'reversed' },
      attributionId: {
        in: (
          await tx.referralAttribution.findMany({
            where: { referrerId: attribution.referrerId },
            select: { id: true },
          })
        ).map((row) => row.id),
      },
    },
  });
  if (todayCount >= config.maxRewardsPerDay) {
    await tx.outboxJob.create({
      data: {
        queue: 'notify',
        name: 'notify.alert',
        payload: { type: 'referral.daily_cap', details: attribution.referrerId },
        jobId: `alert:referral.daily_cap:${attribution.referrerId}`,
      },
    });
    return null;
  }

  const rewardTx = await post(tx, {
    userId: attribution.referrerId,
    type: 'referral_reward',
    amountMinor: amount,
    parentId: source.id,
    debitKind: 'referral_expense',
    creditKind: 'user',
    creditUserId: attribution.referrerId,
  });
  const reward = await tx.referralReward.create({
    data: {
      attributionId: attribution.id,
      transactionId: rewardTx.id,
      sourceTransactionId: source.id,
      amountMinor: amount,
      ...(config.holdHours > 0
        ? { holdUntil: new Date(now.getTime() + config.holdHours * 3_600_000) }
        : {}),
      status: config.holdHours > 0 ? 'held' : 'released',
    },
  });

  if (isFirst) {
    await tx.referralAttribution.update({
      where: { id: attribution.id },
      data: { status: 'converted', convertedTransactionId: source.id, convertedAt: now },
    });
    if (config.inviteeBonusTrigger === 'first_paid')
      await grantInviteeBonus(tx, config, source.userId, trial, now);
  }

  await tx.outboxJob.create({
    data: {
      queue: 'notify',
      name: 'notify.send',
      payload: {
        event: 'referral.reward',
        userId: attribution.referrerId,
        dedupKey: `referral.reward:${reward.id}`,
        params: { amount: formatMinorRub(amount) },
      },
      jobId: `notify:referral.reward:${reward.id}`,
    },
  });
  await emitWebhook(tx, 'referral.rewarded', attribution.referrerId, {
    rewardId: reward.id,
    transactionId: rewardTx.id,
    sourceTransactionId: source.id,
    refereeId: source.userId,
    amountMinor: minor(amount),
    currency: 'RUB',
    status: reward.status,
    holdUntil: reward.holdUntil?.toISOString() ?? null,
  });

  return { rewardId: reward.id, amountMinor: amount };
}

/**
 * Section 15.2 reversal, proportional on a partial refund and rounded down.
 * `refundedMinor` is the source's refunded total so far, so the reversal due
 * is cumulative (repair queue R16): what earlier reversals already took is
 * subtracted, the reward stays `held`/`released` until the source is refunded
 * in full, and a full refund always reverses the whole reward.
 */
export async function reverseReferralReward(
  tx: Tx,
  sourceTransactionId: string,
  refundedMinor: bigint,
  sourceAmountMinor: bigint,
): Promise<bigint> {
  // Repair queue R17: the reward row is the lock. A second reversal of the
  // same reward — the console's, or a refund's — waits here and then reads
  // what the first one left, never the state both started from.
  await tx.$queryRawUnsafe(
    `SELECT id FROM referral_rewards WHERE source_transaction_id = $1::uuid FOR UPDATE`,
    sourceTransactionId,
  );
  const reward = await tx.referralReward.findUnique({
    where: { sourceTransactionId },
  });
  if (!reward || reward.status === 'reversed' || sourceAmountMinor <= 0n) return 0n;
  const full = refundedMinor >= sourceAmountMinor;
  const due = full ? reward.amountMinor : (reward.amountMinor * refundedMinor) / sourceAmountMinor;
  const taken = await tx.transaction.aggregate({
    where: { type: 'referral_reversal', parentId: reward.transactionId },
    _sum: { amountMinor: true },
  });
  const amount = due - (taken._sum.amountMinor ?? 0n);
  if (amount <= 0n) return 0n;

  const attribution = await tx.referralAttribution.findUnique({
    where: { id: reward.attributionId },
  });
  if (!attribution) return 0n;

  const reversal = await post(tx, {
    userId: attribution.referrerId,
    type: 'referral_reversal',
    amountMinor: amount,
    parentId: reward.transactionId,
    debitKind: 'user',
    debitUserId: attribution.referrerId,
    creditKind: 'referral_expense',
    reason: 'referral source refunded',
  });
  if (full)
    await tx.referralReward.update({
      where: { sourceTransactionId },
      data: { status: 'reversed', reversalTransactionId: reversal.id },
    });
  return amount;
}

/** Section 15.2 invitee bonus: extra days on a live subscription, or balance. */
function formatMinorRub(amountMinor: bigint): string {
  const negative = amountMinor < 0n;
  const absolute = negative ? -amountMinor : amountMinor;
  const units = (absolute / 100n).toString();
  const cents = (absolute % 100n).toString().padStart(2, '0');
  return `${negative ? '-' : ''}${cents === '00' ? units : `${units},${cents}`} \u20bd`;
}

export async function grantInviteeBonus(
  tx: Tx,
  config: ReferralConfig,
  userId: string,
  trial: TrialLimits,
  now = new Date(),
): Promise<void> {
  if (config.inviteeBonus.type === 'none' || config.inviteeBonus.value <= 0) return;
  await tx.outboxJob.create({
    data: {
      queue: 'notify',
      name: 'notify.send',
      payload: {
        event: 'referral.invitee_bonus',
        userId,
        dedupKey: `referral.invitee_bonus:${userId}`,
        params: {},
      },
      jobId: `notify:referral.invitee_bonus:${userId}`,
    },
  });
  if (config.inviteeBonus.type === 'balance') {
    await post(tx, {
      userId,
      type: 'promo_bonus',
      amountMinor: BigInt(config.inviteeBonus.value),
      debitKind: 'promo_expense',
      creditKind: 'user',
      creditUserId: userId,
      reason: 'referral invitee bonus',
    });
    return;
  }

  const live = await tx.subscription.findFirst({
    where: { userId, status: { in: ['provisioning', 'active', 'grace'] } },
    orderBy: { expiresAt: 'desc' },
  });
  const days = config.inviteeBonus.value;
  if (live) {
    const base = live.expiresAt > now ? live.expiresAt : now;
    const extended = await tx.subscription.update({
      where: { id: live.id },
      data: { expiresAt: new Date(base.getTime() + days * 86_400_000) },
    });
    await emitWebhook(tx, 'subscription.activated', userId, subscriptionData(extended));
    await queuePanelSync(tx, userId, 'referral:invitee-bonus');
    return;
  }
  const created = await tx.subscription.create({
    data: {
      userId,
      source: 'promo',
      status: 'active',
      startsAt: now,
      expiresAt: new Date(now.getTime() + days * 86_400_000),
      trafficLimitBytes: BigInt(trial.trafficGb) * 1024n ** 3n,
      trafficResetStrategy: 'NO_RESET',
      deviceLimit: trial.deviceLimit,
      squads: trial.squads,
    },
  });
  await emitWebhook(tx, 'subscription.activated', userId, subscriptionData(created));
  await queuePanelSync(tx, userId, 'referral:invitee-bonus');
}
