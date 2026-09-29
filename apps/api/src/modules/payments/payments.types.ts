import { z } from 'zod';

export const providerCodeSchema = z.enum([
  'yookassa',
  'platega',
  'lava',
  'robokassa',
  'cryptobot',
  'stars',
  'balance',
  'mock',
]);
export type ProviderCode = z.infer<typeof providerCodeSchema>;

export type ReceiptData = {
  customer: { email?: string; phone?: string };
  items: Array<{
    description: string;
    quantity: string;
    amountMinor: bigint;
    vatCode: number;
    paymentSubject: 'service';
    paymentMode: 'full_payment';
  }>;
};

export type CreateInvoiceParams = {
  /** The shop's idempotency key, which most providers use as their invoice id. */
  invoiceId: string;
  /** `invoices.id` of the row about to be written (Stars payload `inv_<id>`). */
  shopInvoiceId: string;
  /** `invoices.numeric_id` of that row (Robokassa `InvId`, section 11.3.4). */
  shopInvoiceNumber?: bigint;
  amountMinor: bigint;
  currency: 'RUB';
  description: string;
  user: { id: string; telegramId: bigint; email?: string | undefined; language: string };
  /** Where the provider sends the payer back: `/pay/<id>` (FR-134). */
  returnUrl: string;
  failUrl: string;
  /** `https://<domain>/webhooks/<provider>` (section 9.7), for providers told it per invoice. */
  webhookUrl: string;
  expiresAt: Date;
  receipt?: ReceiptData;
};

export type CreatedInvoice = {
  providerInvoiceId: string;
  paymentUrl?: string;
  starsInvoiceLink?: string;
  providerAmount?: { amount: string; currency: string; fxRate: string };
  expiresAt: Date;
  rawSafe: Record<string, unknown>;
};

export type ProviderEvent = {
  eventId?: string;
  providerInvoiceId: string;
  type: 'paid' | 'canceled' | 'refunded' | 'pending' | 'unknown';
  paidAmount?: { amount: string; currency: string };
  paidAmountMinorRub?: bigint;
  occurredAt?: Date;
};

export type ProviderVerification = { ok: boolean; reason?: string };
export type ProviderConfig = Record<string, unknown>;

export interface PaymentProvider {
  readonly code: ProviderCode;
  readonly capabilities: {
    receipts: boolean;
    webhooks: boolean;
    statusPolling: boolean;
    kind: 'redirect' | 'stars' | 'balance';
    currencies: string[];
    /** F37: the smallest invoice the provider accepts, in kopecks (docs/payments/README.md). */
    minAmountMinor: bigint;
  };
  readonly configSchema: z.ZodType;
  createInvoice(params: CreateInvoiceParams, config: ProviderConfig): Promise<CreatedInvoice>;
  verifyWebhook(
    raw: Buffer,
    headers: Record<string, string>,
    ip: string,
    config: ProviderConfig,
  ): ProviderVerification;
  parseWebhook(raw: Buffer, config: ProviderConfig): ProviderEvent | null;
  /** `event` is the notification being answered, for providers that echo its id. */
  ackResponse(event?: ProviderEvent): {
    status: number;
    body: string | object;
    contentType: string;
  };
  fetchStatus(providerInvoiceId: string, config: ProviderConfig): Promise<ProviderEvent>;
  healthcheck(config: ProviderConfig): Promise<{ ok: boolean; latencyMs: number; error?: string }>;
}
