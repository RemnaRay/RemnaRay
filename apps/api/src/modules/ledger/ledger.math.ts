export type LedgerAccountKind =
  | 'user'
  | 'revenue'
  | 'provider_clearing'
  | 'referral_expense'
  | 'promo_expense'
  | 'refund_pool'
  | 'adjustment';

export type LedgerAccountBalance = {
  id: string;
  kind: LedgerAccountKind;
  balanceMinor: bigint;
};

/**
 * Repair queue P-6 (owner decision 2026-09-28): every account, user or
 * system, holds `SUM(credit) − SUM(debit)` — a credit adds, a debit
 * subtracts — as every posting path writes it. A recorded deviation from
 * section 8.3, which reads system accounts as `debit − credit`.
 */
export function nextBalance(
  account: LedgerAccountBalance,
  side: 'debit' | 'credit',
  amountMinor: bigint,
): bigint {
  if (amountMinor <= 0n) throw new Error('Ledger amount must be positive');
  return account.balanceMinor + (side === 'credit' ? amountMinor : -amountMinor);
}

export function availableBalance(balanceMinor: bigint, heldMinor: bigint): bigint {
  if (heldMinor < 0n) throw new Error('Held amount cannot be negative');
  return balanceMinor - heldMinor;
}
