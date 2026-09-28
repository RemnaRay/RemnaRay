import { Prisma, type PrismaClient } from '@remnaray/db';
import { ledgerAuditMismatchTotal } from '@remnaray/metrics';

import { LedgerError } from './ledger.errors';
import {
  availableBalance,
  nextBalance,
  type LedgerAccountBalance,
  type LedgerAccountKind,
} from './ledger.math';

export type LedgerPost = {
  userId: string;
  type:
    | 'purchase'
    | 'topup'
    | 'refund'
    | 'referral_reward'
    | 'referral_reversal'
    | 'promo_bonus'
    | 'adjustment'
    | 'plan_change_credit';
  amountMinor: bigint;
  currency: string;
  debit: { kind: LedgerAccountKind; userId?: string; provider?: string };
  credit: { kind: LedgerAccountKind; userId?: string; provider?: string };
  reason?: string;
  parentId?: string;
  /** Section 11.6: a manual `adjustment` names the admin who made it. */
  actorAdminId?: string;
};

export type LedgerTransaction = { id: string; amountMinor: bigint; balanceMinor: bigint };

type AccountRow = LedgerAccountBalance & {
  userId: string | null;
  provider: string | null;
  currency: string;
};
type HeldRow = { held: bigint | null };

export interface LedgerRepositoryPort {
  post(input: LedgerPost): Promise<LedgerTransaction>;
  available(userId: string): Promise<bigint>;
  audit(): Promise<{
    checked: number;
    mismatches: Array<{ accountId: string; expected: bigint; actual: bigint }>;
  }>;
}

/**
 * One posting inside the caller's transaction: finds (and for a user, opens)
 * both accounts, locks them in `id` order (11.7), refuses a user debit beyond
 * `available()`, writes the transaction and its entry and moves both
 * balances. Callers that must hold other locks first — the operator's daily
 * limit (R15) — post through this instead of `LedgerRepository.post`.
 */
export async function postInTransaction(
  transaction: Prisma.TransactionClient,
  input: LedgerPost,
): Promise<LedgerTransaction> {
  if (input.amountMinor <= 0n)
    throw new LedgerError('INVALID_LEDGER_ENTRY', 'Amount must be positive');
  if (
    input.debit.kind === input.credit.kind &&
    input.debit.userId === input.credit.userId &&
    input.debit.provider === input.credit.provider
  ) {
    throw new LedgerError('INVALID_LEDGER_ENTRY', 'Debit and credit accounts must differ');
  }
  const debit = await findAccount(transaction, input.debit, input.currency);
  const credit = await findAccount(transaction, input.credit, input.currency);
  const ids = [debit.id, credit.id].sort();
  const locked = await transaction.$queryRaw<AccountRow[]>(Prisma.sql`
    SELECT id, kind, user_id AS "userId", provider, currency, balance_minor AS "balanceMinor"
    FROM accounts WHERE id IN (${Prisma.join(ids)}) ORDER BY id FOR UPDATE
  `);
  const lockedById = new Map(locked.map((account) => [account.id, account]));
  const lockedDebit = lockedById.get(debit.id);
  const lockedCredit = lockedById.get(credit.id);
  if (!lockedDebit || !lockedCredit) throw new LedgerError('ACCOUNT_NOT_FOUND');

  if (lockedDebit.kind === 'user') {
    const available = await availableInTransaction(transaction, lockedDebit.id);
    if (available < input.amountMinor) throw new LedgerError('INSUFFICIENT_FUNDS');
  }
  const debitBalance = nextBalance(lockedDebit, 'debit', input.amountMinor);
  const creditBalance = nextBalance(lockedCredit, 'credit', input.amountMinor);
  const ledgerTransaction = await transaction.transaction.create({
    data: {
      userId: input.userId,
      type: input.type,
      status: 'completed',
      amountMinor: input.amountMinor,
      currency: input.currency,
      parentId: input.parentId ?? null,
      reason: input.reason ?? null,
      actorAdminId: input.actorAdminId ?? null,
    },
  });
  await transaction.ledgerEntry.create({
    data: {
      transactionId: ledgerTransaction.id,
      debitAccountId: debit.id,
      creditAccountId: credit.id,
      amountMinor: input.amountMinor,
      currency: input.currency,
    },
  });
  await transaction.account.update({
    where: { id: debit.id },
    data: { balanceMinor: debitBalance },
  });
  await transaction.account.update({
    where: { id: credit.id },
    data: { balanceMinor: creditBalance },
  });
  return {
    id: ledgerTransaction.id,
    amountMinor: input.amountMinor,
    balanceMinor: lockedCredit.kind === 'user' ? creditBalance : debitBalance,
  };
}

export class LedgerRepository implements LedgerRepositoryPort {
  constructor(private readonly prisma: PrismaClient) {}

  async post(input: LedgerPost): Promise<LedgerTransaction> {
    return this.prisma.$transaction((transaction) => postInTransaction(transaction, input), {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      maxWait: 5000,
      timeout: 10000,
    });
  }

  async available(userId: string): Promise<bigint> {
    return this.prisma.$transaction(async (transaction) => {
      const account = await transaction.$queryRaw<AccountRow[]>(Prisma.sql`
        SELECT id, kind, user_id AS "userId", provider, currency, balance_minor AS "balanceMinor"
        FROM accounts WHERE kind = 'user'::account_kind AND user_id = ${userId}::uuid FOR UPDATE
      `);
      const row = account[0];
      if (!row) throw new LedgerError('ACCOUNT_NOT_FOUND');
      return availableInTransaction(transaction, row.id);
    });
  }

  async audit(): Promise<{
    checked: number;
    mismatches: Array<{ accountId: string; expected: bigint; actual: bigint }>;
  }> {
    const rows = await this.prisma.$queryRaw<
      Array<{
        accountId: string;
        kind: LedgerAccountKind;
        actual: bigint;
        debit: bigint;
        credit: bigint;
      }>
    >(Prisma.sql`
      SELECT a.id AS "accountId", a.kind, a.balance_minor AS actual,
        COALESCE(SUM(CASE WHEN le.debit_account_id = a.id THEN le.amount_minor ELSE 0 END), 0) AS debit,
        COALESCE(SUM(CASE WHEN le.credit_account_id = a.id THEN le.amount_minor ELSE 0 END), 0) AS credit
      FROM accounts a LEFT JOIN ledger_entries le ON le.debit_account_id = a.id OR le.credit_account_id = a.id
      GROUP BY a.id, a.kind, a.balance_minor
    `);
    const mismatches = rows.flatMap((row) => {
      const debit = BigInt(row.debit.toString());
      const credit = BigInt(row.credit.toString());
      const actual = BigInt(row.actual.toString());
      // P-6: one convention for every account, as `nextBalance`.
      const expected = credit - debit;
      return expected === actual ? [] : [{ accountId: row.accountId, expected, actual }];
    });
    // Section 9.9 `rr_ledger_audit_mismatch_total`: a counter, not a gauge —
    // an audit that found a disagreement once has to stay visible after the
    // next audit finds none.
    if (mismatches.length > 0) ledgerAuditMismatchTotal.inc(mismatches.length);
    return { checked: rows.length, mismatches };
  }
}

async function findAccount(
  transaction: Prisma.TransactionClient,
  reference: { kind: LedgerAccountKind; userId?: string; provider?: string },
  currency: string,
): Promise<AccountRow> {
  if (reference.kind === 'user') {
    if (!reference.userId) throw new LedgerError('ACCOUNT_NOT_FOUND');
    await transaction.$executeRaw(Prisma.sql`
      INSERT INTO accounts (kind, user_id, currency)
      VALUES ('user'::account_kind, ${reference.userId}::uuid, ${currency})
      ON CONFLICT DO NOTHING
    `);
  }
  const rows = await transaction.$queryRaw<AccountRow[]>(Prisma.sql`
    SELECT id, kind, user_id AS "userId", provider, currency, balance_minor AS "balanceMinor"
    FROM accounts
    WHERE kind = ${reference.kind}::account_kind AND currency = ${currency}
      AND (${reference.userId ?? null}::uuid IS NULL OR user_id = ${reference.userId ?? null}::uuid)
      AND (${reference.provider ?? null}::text IS NULL OR provider = ${reference.provider ?? null})
    LIMIT 1
  `);
  const account = rows[0];
  if (!account) throw new LedgerError('ACCOUNT_NOT_FOUND');
  return account;
}

async function availableInTransaction(
  transaction: Prisma.TransactionClient,
  accountId: string,
): Promise<bigint> {
  const rows = await transaction.$queryRaw<HeldRow[]>(Prisma.sql`
    SELECT COALESCE(SUM(rr.amount_minor), 0) AS held
    FROM referral_rewards rr
    JOIN transactions t ON t.id = rr.transaction_id
    WHERE t.user_id = (SELECT user_id FROM accounts WHERE id = ${accountId}::uuid)
      AND rr.status = 'held'
  `);
  return availableBalance(
    BigInt((await accountBalance(transaction, accountId)).toString()),
    BigInt((rows[0]?.held ?? 0n).toString()),
  );
}

async function accountBalance(
  transaction: Prisma.TransactionClient,
  accountId: string,
): Promise<bigint> {
  const rows = await transaction.$queryRaw<Array<{ balance: bigint }>>(
    Prisma.sql`SELECT balance_minor AS balance FROM accounts WHERE id = ${accountId}::uuid`,
  );
  if (!rows[0]) throw new LedgerError('ACCOUNT_NOT_FOUND');
  return BigInt(rows[0].balance.toString());
}
