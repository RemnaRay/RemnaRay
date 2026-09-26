type Translate = ((key: string) => string) & { has: (key: string) => boolean };

/** A known code in the operator's words; an unknown one as it is stored. */
function label(t: Translate, key: string, code: string): string {
  return t.has(key) ? t(key) : code;
}

export function transactionTypeLabel(t: Translate, type: string): string {
  return label(t, `payments.txType.${type}`, type);
}

export function invoiceStatusLabel(t: Translate, status: string): string {
  return label(t, `payments.invoiceStatus.${status}`, status);
}

/** A purchase paid from the balance is named as such, not as a provider. */
export function providerLabel(t: Translate, provider: string | null): string {
  if (provider === null) return '—';
  return provider === 'balance' ? t('payments.fromBalance') : provider;
}

/**
 * What is left to refund of a transaction: only a purchase can be refunded
 * (FR-066, EX-05; the API refuses anything else), up to its amount less what
 * was refunded already.
 */
export function refundableMinor(row: {
  type: string;
  amount: { amountMinor: number };
  refunded?: { amountMinor: number } | undefined;
}): number {
  if (row.type !== 'purchase') return 0;
  return Math.max(0, row.amount.amountMinor - (row.refunded?.amountMinor ?? 0));
}
