import { describe, expect, it } from 'vitest';

import {
  amountToPay,
  formatInvoiceNumber,
  planChangeCredit,
  renderItemName,
  topupAmount,
} from './checkout';

describe('invoice numbers (F37)', () => {
  it('prefixes the provider code and pads to five digits', () => {
    expect(formatInvoiceNumber('yookassa', 1n)).toBe('01-00001');
    expect(formatInvoiceNumber('stars', 42n)).toBe('06-00042');
    expect(formatInvoiceNumber('mock', 7n)).toBe('99-00007');
  });
  it('grows past five digits instead of wrapping', () => {
    expect(formatInvoiceNumber('platega', 100000n)).toBe('02-100000');
  });
  it('refuses a provider without a code', () => {
    expect(() => formatInvoiceNumber('balance', 1n)).toThrow('INVOICE_NUMBER_UNKNOWN_PROVIDER');
  });
});

describe('plan-change credit (EX-06)', () => {
  const old = { priceMinor: 29900n, durationDays: 30 };
  it('rounds the remainder up, as today', () => {
    const at = new Date('2026-10-01T00:00:00Z');
    const expires = new Date(at.getTime() + 15 * 86_400_000);
    expect(planChangeCredit(old, expires, at)).toBe(14950n);
  });
  it('is zero once the subscription has ended', () => {
    const at = new Date('2026-10-01T00:00:00Z');
    expect(planChangeCredit(old, new Date(at.getTime() - 1000), at)).toBe(0n);
  });
});

describe("amount to pay (today's clamps kept until package 5)", () => {
  it('subtracts the credit, then the discount', () => {
    expect(amountToPay({ priceMinor: 59900n, creditMinor: 14950n, discountMinor: 0n })).toBe(
      44950n,
    );
    expect(amountToPay({ priceMinor: 29900n, creditMinor: 0n, discountMinor: 5980n })).toBe(23920n);
  });
  it('never goes below one minor unit', () => {
    expect(amountToPay({ priceMinor: 29900n, creditMinor: 40000n, discountMinor: 0n })).toBe(1n);
    expect(amountToPay({ priceMinor: 29900n, creditMinor: 0n, discountMinor: 29900n })).toBe(1n);
  });
});

describe('top-up for a plan (answer (а))', () => {
  it('is nothing when nothing is short', () => {
    expect(topupAmount({ shortMinor: 0n, topupMinMinor: 5000n, providerMinMinor: 100n })).toBe(0n);
    expect(topupAmount({ shortMinor: -300n, topupMinMinor: 5000n, providerMinMinor: 100n })).toBe(
      0n,
    );
  });
  it('rounds a small shortage up to the larger minimum', () => {
    expect(topupAmount({ shortMinor: 300n, topupMinMinor: 5000n, providerMinMinor: 100n })).toBe(
      5000n,
    );
    expect(topupAmount({ shortMinor: 300n, topupMinMinor: 5000n, providerMinMinor: 10000n })).toBe(
      10000n,
    );
  });
  it('invoices a large shortage as it is', () => {
    expect(
      topupAmount({ shortMinor: 2_500_000n, topupMinMinor: 5000n, providerMinMinor: 100n }),
    ).toBe(2_500_000n);
  });
});

describe('receipt line', () => {
  it('fills the number and the brand', () => {
    expect(
      renderItemName('Пополнение баланса (#{number})', { number: '01-00001', brand: 'Manta' }),
    ).toBe('Пополнение баланса (#01-00001)');
    expect(
      renderItemName('{brand}: пополнение (#{number})', { number: '06-00002', brand: 'Manta' }),
    ).toBe('Manta: пополнение (#06-00002)');
  });
});
