export class PaymentError extends Error {
  constructor(
    public readonly code:
      | 'PLAN_UNAVAILABLE'
      | 'PROVIDER_UNAVAILABLE'
      | 'INVOICE_NOT_FOUND'
      | 'INVOICE_NOT_PENDING'
      | 'IDEMPOTENCY_REQUIRED'
      | 'RATE_LIMITED'
      | 'UNDERPAID'
      | 'WEBHOOK_INVALID_SIGNATURE'
      | 'WEBHOOK_NOT_SUPPORTED'
      | 'PAYMENT_PROVIDER_NOT_FOUND'
      | 'REFUND_NOT_PURCHASE'
      | 'REFUND_EXCEEDS_REMAINING'
      | 'TRANSACTION_NOT_FOUND'
      | 'INSUFFICIENT_FUNDS'
      | 'BALANCE_ONLY'
      | 'INVALID_TARGET'
      | 'IDEMPOTENCY_KEY_REUSED',
    message: string = code,
  ) {
    super(message);
    this.name = 'PaymentError';
  }
}
