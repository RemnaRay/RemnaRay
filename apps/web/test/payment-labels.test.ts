import { describe, expect, it } from 'vitest';

import {
  invoiceStatusLabel,
  providerLabel,
  refundableMinor,
  transactionTypeLabel,
} from '../app/admin/payments/labels';

const messages: Record<string, string> = {
  'payments.fromBalance': 'С баланса',
  'payments.txType.topup': 'Пополнение',
  'payments.invoiceStatus.paid': 'Оплачен',
};
const t = Object.assign((key: string) => messages[key] ?? key, {
  has: (key: string) => key in messages,
});
const money = (amountMinor: number) => ({ amountMinor });

describe('the console payments labels (F32)', () => {
  it('names types, statuses and a balance payment in words, unknown codes as stored', () => {
    expect(transactionTypeLabel(t, 'topup')).toBe('Пополнение');
    expect(transactionTypeLabel(t, 'something_new')).toBe('something_new');
    expect(invoiceStatusLabel(t, 'paid')).toBe('Оплачен');
    expect(providerLabel(t, 'balance')).toBe('С баланса');
    expect(providerLabel(t, 'yookassa')).toBe('yookassa');
    expect(providerLabel(t, null)).toBe('—');
  });

  it('offers a refund of what is left of a purchase, and of nothing else', () => {
    expect(refundableMinor({ type: 'purchase', amount: money(29900) })).toBe(29900);
    expect(
      refundableMinor({ type: 'purchase', amount: money(29900), refunded: money(10000) }),
    ).toBe(19900);
    expect(
      refundableMinor({ type: 'purchase', amount: money(29900), refunded: money(29900) }),
    ).toBe(0);
    expect(refundableMinor({ type: 'topup', amount: money(30000) })).toBe(0);
    expect(refundableMinor({ type: 'refund', amount: money(10000) })).toBe(0);
  });
});
