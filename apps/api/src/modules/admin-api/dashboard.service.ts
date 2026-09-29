import { Injectable } from '@nestjs/common';
import { Prisma } from '@remnaray/db';
import { z } from 'zod';

import { Infrastructure } from '../../infra/infra.module';
import { lastReconcile } from '../remnawave/reconcile-record';

export const dashboardQuerySchema = z.object({
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
});

export type DashboardRange = { from: Date; to: Date };

const CACHE_TTL_SECONDS = 60;

function money(amountMinor: bigint) {
  return { amountMinor: Number(amountMinor), currency: 'RUB' };
}

function toBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(Math.trunc(value));
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value);
  return 0n;
}

function toNumber(value: unknown): number {
  return Number(toBigInt(value));
}

/**
 * F37 (ADR-021): money comes in only as provider top-ups — «Поступления». A
 * purchase spends it from the balance — «Продажи» are purchases less refunds.
 * The difference stays on the customers' balances (the liability widget).
 */
const RECEIVED = Prisma.sql`status = 'completed' AND type = 'topup'
  AND provider IS NOT NULL AND provider <> 'balance'`;

/**
 * FR-142 widgets. Every number is a SQL aggregate over `transactions`,
 * `subscriptions` and `users`, cached in Valkey for 60 seconds.
 */
@Injectable()
export class DashboardService {
  constructor(private readonly infra: Infrastructure) {}

  range(query: unknown): DashboardRange {
    const input = dashboardQuerySchema.parse(query ?? {});
    const to = input.to ? new Date(input.to) : new Date();
    const from = input.from ? new Date(input.from) : new Date(to.getTime() - 29 * 86_400_000);
    return { from, to };
  }

  async overview(query: unknown) {
    const { from, to } = this.range(query);
    const cacheKey = `rr:dashboard:${from.toISOString()}:${to.toISOString()}`;
    const cached = await this.infra.redis.get(cacheKey).catch(() => null);
    if (cached) return JSON.parse(cached) as Awaited<ReturnType<DashboardService['compute']>>;
    const result = await this.compute(from, to);
    await this.infra.redis
      .set(cacheKey, JSON.stringify(result), 'EX', CACHE_TTL_SECONDS)
      .catch(() => null);
    return result;
  }

  private async compute(from: Date, to: Date) {
    const db = this.infra.db;
    const soon = new Date(Date.now() + 3 * 86_400_000);

    const [
      receiptsRows,
      salesRows,
      paymentRows,
      newUsers,
      trialRows,
      conversionRows,
      activeRows,
      expiringRows,
      liabilityRows,
      referralRows,
      providerRows,
    ] = await Promise.all([
      db.$queryRaw<{ receipts: bigint | null }[]>`
          SELECT COALESCE(SUM(amount_minor), 0)::bigint AS receipts
          FROM transactions
          WHERE ${RECEIVED} AND created_at >= ${from} AND created_at <= ${to}`,
      db.$queryRaw<{ sales: bigint | null }[]>`
          SELECT COALESCE(SUM(CASE WHEN type = 'purchase' THEN amount_minor ELSE -amount_minor END), 0)::bigint AS sales
          FROM transactions
          WHERE status = 'completed' AND type IN ('purchase', 'refund')
            AND created_at >= ${from} AND created_at <= ${to}`,
      db.$queryRaw<{ payments: bigint; total: bigint | null }[]>`
          SELECT COUNT(*)::bigint AS payments, COALESCE(SUM(amount_minor), 0)::bigint AS total
          FROM transactions
          WHERE ${RECEIVED} AND created_at >= ${from} AND created_at <= ${to}`,
      db.user.count({ where: { createdAt: { gte: from, lte: to } } }),
      db.$queryRaw<{ trials: bigint }[]>`
          SELECT COUNT(*)::bigint AS trials
          FROM subscriptions
          WHERE source = 'trial' AND created_at >= ${from} AND created_at <= ${to}`,
      db.$queryRaw<{ cohort: bigint; converted: bigint }[]>`
          WITH cohort AS (
            SELECT DISTINCT user_id
            FROM subscriptions
            WHERE source = 'trial' AND created_at >= ${from} AND created_at <= ${to}
          )
          SELECT
            (SELECT COUNT(*) FROM cohort)::bigint AS cohort,
            (SELECT COUNT(DISTINCT t.user_id)
             FROM transactions t
             JOIN cohort c ON c.user_id = t.user_id
             WHERE t.type = 'purchase' AND t.status = 'completed')::bigint AS converted`,
      db.$queryRaw<{ active: bigint }[]>`
          SELECT COUNT(*)::bigint AS active FROM subscriptions WHERE status = 'active'`,
      db.$queryRaw<{ expiring: bigint }[]>`
          SELECT COUNT(*)::bigint AS expiring
          FROM subscriptions
          WHERE status = 'active' AND expires_at <= ${soon}`,
      db.$queryRaw<{ liability: bigint | null }[]>`
          SELECT COALESCE(SUM(balance_minor), 0)::bigint AS liability
          FROM accounts WHERE kind = 'user'`,
      db.$queryRaw<{ rewards: bigint | null }[]>`
          SELECT COALESCE(SUM(amount_minor), 0)::bigint AS rewards
          FROM transactions
          WHERE type = 'referral_reward' AND status = 'completed'
            AND created_at >= ${from} AND created_at <= ${to}`,
      db.$queryRaw<{ provider: string; total: bigint | null; payments: bigint }[]>`
          SELECT provider, COALESCE(SUM(amount_minor), 0)::bigint AS total, COUNT(*)::bigint AS payments
          FROM transactions
          WHERE ${RECEIVED} AND created_at >= ${from} AND created_at <= ${to}
          GROUP BY provider
          ORDER BY total DESC
          LIMIT 5`,
    ]);

    const payments = toNumber(paymentRows[0]?.payments ?? 0);
    const paymentsTotal = toBigInt(paymentRows[0]?.total ?? 0);
    const cohort = toNumber(conversionRows[0]?.cohort ?? 0);
    const converted = toNumber(conversionRows[0]?.converted ?? 0);

    return {
      range: { from: from.toISOString(), to: to.toISOString() },
      receipts: money(toBigInt(receiptsRows[0]?.receipts ?? 0)),
      sales: money(toBigInt(salesRows[0]?.sales ?? 0)),
      payments,
      averagePayment: money(payments > 0 ? paymentsTotal / BigInt(payments) : 0n),
      newUsers,
      trialsIssued: toNumber(trialRows[0]?.trials ?? 0),
      trialConversionPercent: cohort > 0 ? Math.round((converted / cohort) * 1000) / 10 : 0,
      activeSubscriptions: toNumber(activeRows[0]?.active ?? 0),
      expiringInThreeDays: toNumber(expiringRows[0]?.expiring ?? 0),
      userBalanceLiability: money(toBigInt(liabilityRows[0]?.liability ?? 0)),
      referralRewards: money(toBigInt(referralRows[0]?.rewards ?? 0)),
      topProviders: providerRows.map((row) => ({
        provider: row.provider,
        total: money(toBigInt(row.total ?? 0)),
        payments: toNumber(row.payments),
      })),
    };
  }

  /** Daily series for the receipts and registration charts. */
  async series(query: unknown) {
    const { from, to } = this.range(query);
    const [receipts, registrations] = await Promise.all([
      this.infra.db.$queryRaw<{ day: Date; total: bigint | null }[]>`
        SELECT date_trunc('day', created_at) AS day,
               COALESCE(SUM(amount_minor), 0)::bigint AS total
        FROM transactions
        WHERE ${RECEIVED} AND created_at >= ${from} AND created_at <= ${to}
        GROUP BY 1 ORDER BY 1`,
      this.infra.db.$queryRaw<{ day: Date; total: bigint }[]>`
        SELECT date_trunc('day', created_at) AS day, COUNT(*)::bigint AS total
        FROM users
        WHERE created_at >= ${from} AND created_at <= ${to}
        GROUP BY 1 ORDER BY 1`,
    ]);
    return {
      receipts: receipts.map((row) => ({
        day: row.day.toISOString().slice(0, 10),
        amountMinor: toNumber(row.total ?? 0),
      })),
      registrations: registrations.map((row) => ({
        day: row.day.toISOString().slice(0, 10),
        count: toNumber(row.total),
      })),
    };
  }

  /** FR-142 "requires attention" list. */
  async attention() {
    const db = this.infra.db;
    const [provisioningFailed, failedJobs, panel] = await Promise.all([
      db.subscription.count({ where: { status: 'provisioning_failed' } }),
      db.outboxJob.count({
        where: { publishedAt: null, createdAt: { lt: new Date(Date.now() - 300_000) } },
      }),
      db.panelUser.aggregate({ _max: { syncedAt: true } }),
    ]);
    return {
      provisioningFailed,
      stuckJobs: failedJobs,
      panelLastSyncedAt: panel._max.syncedAt?.toISOString() ?? null,
      panelLastReconciledAt: (await lastReconcile(this.infra.redis))?.at ?? null,
    };
  }
}
