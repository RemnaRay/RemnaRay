/**
 * F37 (ADR-021): the arithmetic of «purchases only from the balance» — what a
 * purchase costs, what a top-up for it must bring, and how a provider invoice
 * is numbered and named. Pure functions; the callers hold the locks.
 */

/** Fixed provider codes of the invoice number. Never a setting: a changed code would rename old invoices. */
export const INVOICE_PROVIDER_CODES: Readonly<Record<string, string>> = Object.freeze({
  yookassa: '01',
  platega: '02',
  lava: '03',
  robokassa: '04',
  cryptobot: '05',
  stars: '06',
  mock: '99',
});

/** The remainder melts; a top-up for a plan change covers it for a day. */
export const PLAN_CHANGE_TOPUP_MARGIN_MS = 86_400_000;

export function formatInvoiceNumber(provider: string, sequence: bigint): string {
  // Own keys only: `toString` or `__proto__` would otherwise resolve through the prototype.
  const code = Object.hasOwn(INVOICE_PROVIDER_CODES, provider)
    ? INVOICE_PROVIDER_CODES[provider]
    : undefined;
  if (!code) throw new Error('INVOICE_NUMBER_UNKNOWN_PROVIDER');
  return `${code}-${sequence.toString().padStart(5, '0')}`;
}

/** EX-06: `ceil(remaining_seconds / period_seconds × old_price_minor)`, as of `at`. */
export function planChangeCredit(
  oldPlan: { priceMinor: bigint; durationDays: number },
  expiresAt: Date,
  at: Date,
): bigint {
  const remaining = BigInt(Math.max(0, Math.floor((expiresAt.getTime() - at.getTime()) / 1000)));
  const period = BigInt(oldPlan.durationDays) * 86_400n;
  return (oldPlan.priceMinor * remaining + period - 1n) / period;
}

/**
 * What the balance pays: the price less the plan-change credit, less the
 * discount, never below one minor unit — today's arithmetic, which package 5
 * (R20/R73, О-5) replaces.
 */
export function amountToPay(input: {
  priceMinor: bigint;
  creditMinor: bigint;
  discountMinor: bigint;
}): bigint {
  let amount = input.priceMinor > input.creditMinor ? input.priceMinor - input.creditMinor : 1n;
  if (input.discountMinor > 0n)
    amount = amount > input.discountMinor ? amount - input.discountMinor : 1n;
  return amount;
}

/** Answer (а): `max(short, topup_min_minor, provider minimum)`; `topup_max_minor` does not apply. */
export function topupAmount(input: {
  shortMinor: bigint;
  topupMinMinor: bigint;
  providerMinMinor: bigint;
}): bigint {
  if (input.shortMinor <= 0n) return 0n;
  let amount = input.shortMinor;
  if (input.topupMinMinor > amount) amount = input.topupMinMinor;
  if (input.providerMinMinor > amount) amount = input.providerMinMinor;
  return amount;
}

export function renderItemName(
  template: string,
  values: { number: string; brand: string },
): string {
  return template.replaceAll('{number}', values.number).replaceAll('{brand}', values.brand);
}
