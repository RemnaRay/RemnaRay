import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Prisma } from '@remnaray/db';
import { paymentsEventsTotal } from '@remnaray/metrics';

import { Infrastructure } from '../../infra/infra.module';
import { decryptSetting } from '../settings/settings.crypto';
import type { SettingsService } from '../settings/settings.service';
import {
  DEFAULT_ITEM_NAME_TEMPLATE,
  amountToPay,
  planChangeCredit,
  renderItemName,
} from './checkout';
import { PaymentError } from './payments.errors';
import { eventHeaders, maskEventRaw } from './payment-event-mask';
import { PaymentsRepository, type InvoiceTarget } from './payments.repository';
import { PaymentProviderRegistry } from './payments.registry';
import type { ProviderEvent } from './payments.types';

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);
  private readonly recheckAt = new Map<string, number>();
  constructor(
    private readonly infra: Infrastructure,
    private readonly repository: PaymentsRepository,
    private readonly providers: PaymentProviderRegistry,
    private readonly settings?: SettingsService,
  ) {}

  async createInvoice(input: {
    userId: string;
    kind: 'purchase' | 'topup' | 'plan_change';
    planId?: string;
    provider: string;
    amountMinor?: bigint;
    discountMinor?: bigint;
    promocodeId?: string;
    /** Section 15.5: the reservation behind `discountMinor`. */
    promocodeRedemptionId?: string;
    idempotencyKey: string;
    /** F37: what a top-up for a plan is meant to buy (`invoices.target_*`). */
    target?: InvoiceTarget;
  }) {
    if (!input.idempotencyKey) throw new PaymentError('IDEMPOTENCY_REQUIRED');
    // F37: only a top-up has a purpose; a purchase names its plan itself.
    if (input.target && input.kind !== 'topup') throw new PaymentError('INVALID_TARGET');
    const existing = await this.replay(input);
    if (existing) return existing;
    await this.requireOffered(input.provider, input.kind);
    // F37 (ADR-021): a plan is bought only from the balance; a provider only
    // tops the balance up.
    if (input.provider !== 'balance' && input.kind !== 'topup')
      throw new PaymentError('BALANCE_ONLY');
    const user = await this.infra.db.user.findUniqueOrThrow({ where: { id: input.userId } });
    let amount = input.amountMinor ?? 0n;
    const discount = input.discountMinor ?? 0n;
    if (input.kind !== 'topup') {
      if (!input.planId) throw new PaymentError('PLAN_UNAVAILABLE');
      const plan = await this.infra.db.plan.findFirst({
        where: { id: input.planId, isActive: true, deletedAt: null },
      });
      if (!plan) throw new PaymentError('PLAN_UNAVAILABLE');
      // `amountToPay` never goes below one kopeck; a free plan stays refused,
      // as before (zero-amount purchases are package 5, R20/R73, О-5).
      if (input.kind === 'purchase' && plan.priceMinor <= 0n)
        throw new PaymentError('PLAN_UNAVAILABLE', 'Amount must be positive');
      let credit = 0n;
      if (input.kind === 'plan_change') {
        const current = await this.infra.db.subscription.findFirst({
          where: { userId: input.userId, status: 'active' },
        });
        const oldPlan = current?.planId
          ? await this.infra.db.plan.findUnique({ where: { id: current.planId } })
          : null;
        if (!current || !oldPlan || current.expiresAt <= new Date())
          throw new PaymentError('PLAN_UNAVAILABLE', 'Plan change is unavailable');
        credit = planChangeCredit(oldPlan, current.expiresAt, new Date());
      }
      amount = amountToPay({
        priceMinor: plan.priceMinor,
        creditMinor: credit,
        discountMinor: discount,
      });
    }
    if (amount <= 0n) throw new PaymentError('PLAN_UNAVAILABLE', 'Amount must be positive');
    const provider = this.providers.get(input.provider);
    const expiresAt = new Date(
      Date.now() + (await this.invoiceTtlMinutes(input.provider)) * 60_000,
    );
    const config = await this.providerConfig(input.provider);
    // The row's id is taken before the provider is called: Telegram Stars
    // carry it in the invoice payload `inv_<id>` (section 11.3.6).
    // Robokassa's `InvId` is `numeric_id` (section 11.3.4), taken from the
    // column's own identity sequence for the same reason.
    const [{ id: shopInvoiceId, numericId } = { id: '', numericId: null }] = await this.infra.db
      .$queryRaw<Array<{ id: string; numericId: bigint | null }>>(Prisma.sql`
        SELECT uuidv7()::text AS id,
               nextval(pg_get_serial_sequence('invoices', 'numeric_id')) AS "numericId"
      `);
    const shopInvoiceNumber = numericId ?? undefined;
    // F37: what the payer sees at the provider and on the receipt is one line,
    // `fiscal.item_name_template` with the invoice's number. The number is
    // taken last, once nothing but the provider call can fail. A balance
    // invoice never reaches a provider and keeps the brand.
    const brand = this.settings ? String(await this.settings.get('brand.name')) : '';
    const number =
      input.provider === 'balance'
        ? undefined
        : await this.repository.nextInvoiceNumber(input.provider);
    const template = this.settings
      ? await this.settings.get('fiscal.item_name_template')
      : undefined;
    const description = number
      ? renderItemName(
          typeof template === 'string' && template ? template : DEFAULT_ITEM_NAME_TEMPLATE,
          { number, brand: brand || 'RemnaRay' },
        )
      : brand || 'RemnaRay';
    const fiscalMode = this.settings ? String(await this.settings.get('fiscal.mode')) : 'none';
    const fiscalEmail = this.settings
      ? String(await this.settings.get('fiscal.fallback_email'))
      : '';
    const origin = `https://${process.env.RR_DOMAIN ?? 'localhost'}`;
    const params = {
      invoiceId: input.idempotencyKey,
      shopInvoiceId,
      ...(shopInvoiceNumber === undefined ? {} : { shopInvoiceNumber }),
      amountMinor: amount,
      currency: 'RUB' as const,
      description,
      user: {
        id: user.id,
        telegramId: user.telegramId,
        email: user.email ?? undefined,
        language: user.language,
      },
      returnUrl: `${origin}/pay/${shopInvoiceId}`,
      failUrl: `${origin}/pay/${shopInvoiceId}`,
      webhookUrl: `${origin}/webhooks/${input.provider}`,
      expiresAt,
      ...(fiscalMode === 'provider_receipt' && provider.capabilities.receipts
        ? {
            receipt: {
              customer: {
                ...(user.email || fiscalEmail ? { email: user.email ?? fiscalEmail } : {}),
              },
              items: [
                {
                  description,
                  quantity: '1.00',
                  amountMinor: amount,
                  vatCode: Number((await this.settings?.get('fiscal.vat_code')) ?? 1),
                  paymentSubject: 'service' as const,
                  paymentMode: 'full_payment' as const,
                },
              ],
            },
          }
        : {}),
    };
    const created = await provider.createInvoice(params, config);
    const invoiceInput = {
      id: shopInvoiceId,
      numericId: shopInvoiceNumber,
      userId: input.userId,
      kind: input.kind,
      ...(input.planId ? { planId: input.planId } : {}),
      provider: input.provider,
      ...(number ? { number } : {}),
      ...(input.target ? { target: input.target } : {}),
      amountMinor: amount,
      currency: 'RUB',
      ...(discount > 0n ? { discountMinor: discount } : {}),
      ...(input.promocodeId ? { promocodeId: input.promocodeId } : {}),
      ...(input.promocodeRedemptionId
        ? {
            promocodeRedemption: {
              id: input.promocodeRedemptionId,
              appliedValueMinor: discount,
            },
          }
        : {}),
      idempotencyKey: input.idempotencyKey,
      expiresAt: created.expiresAt,
      providerInvoiceId: created.providerInvoiceId,
      ...(created.paymentUrl || created.starsInvoiceLink
        ? { paymentUrl: created.paymentUrl ?? created.starsInvoiceLink }
        : {}),
      providerPayload: created.rawSafe,
      ...(created.providerAmount
        ? {
            providerAmount: created.providerAmount.amount,
            providerCurrency: created.providerAmount.currency,
            fxRate: created.providerAmount.fxRate,
          }
        : {}),
    };
    const invoice =
      input.provider === 'balance'
        ? await this.repository.createBalanceInvoice(invoiceInput)
        : await this.repository.createInvoice(invoiceInput);
    // A concurrent request with the key won the insert; its invoice is ours
    // only if it is the same request.
    if (invoice.id !== shopInvoiceId) return replayed(invoice, input);
    if (provider.capabilities.statusPolling && invoice.status === 'pending') {
      await this.infra.db.outboxJob.create({
        data: {
          queue: 'payments',
          name: 'payments.poll-pending',
          payload: { invoiceId: invoice.id },
          jobId: `poll:${invoice.id}`,
        },
      });
    }
    return this.repository.findInvoice(invoice.id);
  }

  async receiveWebhook(
    providerCode: string,
    raw: Buffer,
    headers: Record<string, string>,
    ip: string,
  ) {
    const provider = this.providers.get(providerCode);
    // Section 9.7: a provider without an HTTP webhook is refused before its
    // body is read or stored. Telegram Stars in particular reach the shop only
    // through the bot (section 11.3.6), so a body posted here is a forgery.
    if (!provider.capabilities.webhooks)
      throw new PaymentError('WEBHOOK_NOT_SUPPORTED', 'WEBHOOK_NOT_SUPPORTED');
    const config = await this.providerConfig(providerCode);
    const verification = provider.verifyWebhook(raw, headers, ip, config);
    const parsedEvent = provider.parseWebhook(raw, config);
    const event =
      parsedEvent && providerCode === 'yookassa'
        ? await provider.fetchStatus(parsedEvent.providerInvoiceId, config)
        : parsedEvent;
    // A payload a provider could not classify is refused here rather than
    // stored: `payment_events.type` is not nullable, and an event with no type
    // would turn anything posted at a webhook path into a 500.
    if (!event?.type || !event.providerInvoiceId) {
      paymentsEventsTotal.inc({ provider: providerCode, type: 'unknown', result: 'unparsed' });
      throw new PaymentError('WEBHOOK_INVALID_SIGNATURE', 'Invalid event payload');
    }
    // An event that fails verification is kept for audit (AC-063c) under a
    // key of its own body: under the provider's event id it would take the
    // deduplication slot of the genuine notification, which would then be
    // dropped as its duplicate and never applied.
    const externalId = verification.ok
      ? (event.eventId ??
        createHash('sha256')
          .update(
            `${providerCode}:${event.providerInvoiceId}:${event.type}:${event.paidAmount?.amount ?? ''}`,
          )
          .digest('hex'))
      : `unverified:${createHash('sha256').update(raw).digest('hex')}`;
    const invoice = await this.infra.db.invoice.findFirst({
      where: { provider: providerCode, providerInvoiceId: event.providerInvoiceId },
      select: { id: true },
    });
    let parsedRaw: Record<string, unknown>;
    try {
      parsedRaw = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
    } catch {
      parsedRaw = Object.fromEntries(new URLSearchParams(raw.toString('utf8')).entries());
    }
    const normalizedRaw = { ...(maskEventRaw(parsedRaw) as object), ...paidInRoubles(event) };
    const stored = await this.repository.insertEvent({
      provider: providerCode,
      externalId,
      ...(invoice?.id ? { invoiceId: invoice.id } : {}),
      event,
      raw: normalizedRaw,
      headers: eventHeaders(headers, ip),
      signatureOk: verification.ok,
    });
    if (!verification.ok)
      throw new PaymentError(
        'WEBHOOK_INVALID_SIGNATURE',
        verification.reason ?? 'Invalid webhook signature',
      );
    // Section 9.7: the event is queued before anything else happens to it,
    // so the retried `payments.apply-event` job finishes a failed inline
    // apply. A redelivery of an event still unprocessed (its first delivery
    // failed before the job was queued) is applied here, and a failure is
    // answered with an error so the provider delivers it again.
    if (!stored.duplicate) {
      await this.infra.db.outboxJob.create({
        data: {
          queue: 'payments',
          name: 'payments.apply-event',
          payload: { eventId: stored.id },
          jobId: `evt:${stored.id}`,
        },
      });
      await this.repository.applyEvent(stored.id).catch((error: unknown) => {
        this.logger.warn(`payment event ${stored.id} left to its queued retry: ${String(error)}`);
      });
    } else {
      await this.repository.applyEvent(stored.id);
    }
    return provider.ackResponse(event);
  }

  /**
   * Section 9.2: a repeated `Idempotency-Key` returns the invoice the first
   * request created — for the same user and the same request only (section
   * 9.3 `IDEMPOTENCY_KEY_REUSED`). The column is unique across users, and the
   * key alone used to hand one user another user's invoice.
   */
  async replay(input: InvoiceRequest) {
    const existing = await this.repository.findByIdempotencyKey(input.idempotencyKey);
    return existing ? replayed(existing, input) : null;
  }

  /**
   * FR-064: a check someone asked for (the customer's «Проверить оплату», the
   * console's «Перепроверить»), limited to one per 10 s per invoice. The
   * worker's background poll does not count against that limit: it polls
   * every pending invoice twice a minute, and used to leave the customer's
   * button refused a third of the time.
   */
  async recheck(invoiceId: string) {
    const last = this.recheckAt.get(invoiceId) ?? 0;
    if (Date.now() - last < 10_000) throw new PaymentError('RATE_LIMITED');
    this.recheckAt.set(invoiceId, Date.now());
    return this.poll(invoiceId);
  }

  private async poll(invoiceId: string) {
    const invoice = await this.repository.findInvoice(invoiceId);
    if (!invoice) throw new PaymentError('INVOICE_NOT_FOUND');
    const provider = this.providers.get(invoice.provider);
    // FR-064 asks the provider for the status, and a provider without status
    // polling has none to give: Telegram Stars are proven only by
    // `successful_payment`, and the balance settles when the invoice is
    // created (section 11.3.7), so its `fetchStatus` answers `paid` for any
    // invoice, including one the balance never covered.
    if (!provider.capabilities.statusPolling) return invoice;
    const config = await this.providerConfig(invoice.provider);
    let event: ProviderEvent;
    try {
      event = await provider.fetchStatus(invoice.providerInvoiceId ?? invoice.id, config);
    } catch (error) {
      // The provider did not answer: nothing is known, and the next poll
      // asks again. It is logged here because the answer only names it.
      this.logger.warn(
        `Status check of invoice ${invoice.id} at ${invoice.provider} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new PaymentError('PROVIDER_UNAVAILABLE');
    }
    const stored = await this.repository.insertEvent({
      provider: invoice.provider,
      externalId: event.eventId ?? `poll:${invoice.id}:${event.type}`,
      invoiceId: invoice.id,
      event,
      raw: {
        providerInvoiceId: event.providerInvoiceId,
        type: event.type,
        ...paidInRoubles(event),
      },
      headers: { source: 'poll' },
      signatureOk: true,
    });
    // `applyEvent` does nothing to an event already processed; one stored by
    // an earlier poll whose apply failed is applied now.
    await this.repository.applyEvent(stored.id);
    return this.repository.findInvoice(invoiceId);
  }

  expire() {
    return this.repository.expire();
  }
  async pollPending() {
    const invoices = await this.infra.db.invoice.findMany({
      where: {
        status: 'pending',
        provider: { in: ['platega', 'cryptobot', 'yookassa', 'lava', 'robokassa'] },
        expiresAt: { gt: new Date() },
      },
      select: { id: true },
    });
    for (const invoice of invoices) {
      try {
        await this.poll(invoice.id);
      } catch {
        /* the next poll retries transient provider failures */
      }
    }
    return invoices.length;
  }
  /**
   * Cron `payments.reapply-events`, every five minutes (repair queue R1, P-1,
   * R74): a signed event nobody finished applying — the API stopped between
   * storing and applying it, every retry of its job failed, or a Stars
   * update's apply failed after the insert — is applied again once it is two
   * minutes old, the error of a failed attempt is kept on the event, and an
   * event still unapplied after fifteen minutes is reported to the
   * administrators once (`payment.unapplied`).
   */
  async reapplyUnapplied(
    now = new Date(),
  ): Promise<{ reapplied: number; failed: number; stuck: number }> {
    const due = await this.repository.unappliedEvents(new Date(now.getTime() - 2 * 60_000), 100);
    let reapplied = 0;
    let failed = 0;
    for (const event of due) {
      try {
        await this.repository.applyEvent(event.id);
        reapplied += 1;
      } catch (error) {
        failed += 1;
        const reason =
          error instanceof PaymentError
            ? error.code
            : error instanceof Error
              ? `${error.name}: ${error.message}`
              : 'unknown';
        await this.repository.markEventError(event.id, reason.slice(0, 500));
        this.logger.warn(`payment event ${event.id} still unapplied: ${reason.slice(0, 200)}`);
      }
    }
    const stuck = await this.repository.unappliedEvents(new Date(now.getTime() - 15 * 60_000), 100);
    for (const event of stuck) {
      const jobId = `alert:payment.unapplied:${event.id}`;
      if (await this.infra.db.outboxJob.findFirst({ where: { jobId }, select: { id: true } }))
        continue;
      await this.infra.db.outboxJob.create({
        data: {
          queue: 'notify',
          name: 'notify.alert',
          payload: { type: 'payment.unapplied', details: `payment event ${event.id}` },
          jobId,
        },
      });
    }
    return { reapplied, failed, stuck: stuck.length };
  }

  /** The worker's `payments.apply-event` job (7.3); it expects a JSON body back (R49). */
  async applyEvent(eventId: string) {
    await this.repository.applyEvent(eventId);
    return { applied: true };
  }
  refund(transactionId: string, amountMinor: bigint, reason: string) {
    return this.repository.refund(transactionId, amountMinor, reason);
  }

  /** Section 11.4: `invoice.ttl_minutes`, and `ttl_minutes_crypto` for CryptoBot and Stars. */
  private async invoiceTtlMinutes(provider: string): Promise<number> {
    const crypto = provider === 'cryptobot' || provider === 'stars';
    const value = this.settings
      ? await this.settings.get(crypto ? 'invoice.ttl_minutes_crypto' : 'invoice.ttl_minutes')
      : undefined;
    return typeof value === 'number' && value > 0 ? value : crypto ? 60 : 30;
  }

  /**
   * FR-061, AC-061: an invoice is created only through a provider that is
   * offered to customers — enabled and with a successful last healthcheck, as
   * `GET /me/payment-methods` shows it. The built-in balance has no row to
   * enable; it pays for plans (FR-070) and never tops itself up (FR-071).
   * The account asks it too before handing back a pending top-up (FR-020).
   */
  async requireOffered(code: string, kind: InvoiceRequest['kind']): Promise<void> {
    this.providers.get(code);
    if (code === 'balance') {
      if (kind === 'topup') throw new PaymentError('PROVIDER_UNAVAILABLE');
      return;
    }
    if (code === 'mock') return;
    const row = await this.infra.db.paymentProvider.findUnique({
      where: { code },
      select: { enabled: true, lastHealthcheckOk: true },
    });
    if (!row?.enabled || row.lastHealthcheckOk !== true)
      throw new PaymentError('PROVIDER_UNAVAILABLE');
  }

  /** F37: the provider's smallest invoice, for the top-up of a plan (docs/payments/README.md). */
  minimumMinor(provider: string): bigint {
    return this.providers.get(provider).capabilities.minAmountMinor;
  }

  private async providerConfig(code: string): Promise<Record<string, unknown>> {
    const row = await this.infra.db.paymentProvider.findUnique({ where: { code } });
    if (!row?.enabled && code !== 'mock' && code !== 'balance')
      throw new PaymentError('PROVIDER_UNAVAILABLE');
    // `config_enc` holds the `v1:<nonce>:<ciphertext>:<tag>` string that the
    // console and the setup wizard write (`encryptSetting(...).enc`).
    const stored = row?.configEnc
      ? (decryptSetting({ enc: row.configEnc }, process.env.RR_APP_KEY ?? '') as Record<
          string,
          unknown
        >)
      : {};
    return code === 'stars' ? withStarsRuntime(stored, this.settings) : stored;
  }
}

/**
 * ADR-012: the Stars provider uses the bot's own token from `settings.bot.token`,
 * and the same Bot API root every other Telegram call of the API uses.
 */
export async function withStarsRuntime(
  stored: Record<string, unknown>,
  settings: Pick<SettingsService, 'get'> | undefined,
): Promise<Record<string, unknown>> {
  const token = settings ? await settings.get('bot.token') : undefined;
  return {
    ...stored,
    ...(typeof token === 'string' && token ? { botToken: token } : {}),
    apiBase: process.env.RR_TELEGRAM_API_URL ?? 'https://api.telegram.org',
  };
}

/**
 * The paid amount `applyEvent` compares with the invoice (EX-12), for a
 * webhook and a poll alike. Without it a payment counts as paid in full.
 */
function paidInRoubles(event: ProviderEvent): { paidAmountMinorRub?: string } {
  if (event.paidAmountMinorRub !== undefined)
    return { paidAmountMinorRub: event.paidAmountMinorRub.toString() };
  if (event.paidAmount?.currency === 'RUB')
    return { paidAmountMinorRub: toRubMinor(event.paidAmount.amount).toString() };
  return {};
}

function toRubMinor(value: string): bigint {
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole || '0') * 100n + BigInt(fraction.padEnd(2, '0').slice(0, 2));
}

type InvoiceRequest = {
  userId: string;
  kind: 'purchase' | 'topup' | 'plan_change';
  planId?: string | undefined;
  provider: string;
  amountMinor?: bigint | undefined;
  idempotencyKey: string;
  target?: InvoiceTarget | undefined;
};

/**
 * A top-up for a plan is the same request when it is for the same purpose:
 * its amount follows the balance and may differ between two presses of one
 * button. A plain top-up is the same request only for the same amount.
 */
function replayed<
  T extends {
    userId: string;
    kind: string;
    planId: string | null;
    provider: string;
    amountMinor: bigint;
    targetPlanId?: string | null;
    targetKind?: string | null;
    targetPromocode?: string | null;
  },
>(invoice: T, input: InvoiceRequest): T {
  const forPlan = input.kind === 'topup' && input.target !== undefined;
  const same =
    invoice.userId === input.userId &&
    invoice.kind === input.kind &&
    (invoice.planId ?? undefined) === (input.kind === 'topup' ? undefined : input.planId) &&
    invoice.provider === input.provider &&
    (forPlan
      ? invoice.targetPlanId === input.target?.planId &&
        invoice.targetKind === input.target?.kind &&
        (invoice.targetPromocode ?? undefined) === input.target?.promocode
      : (invoice.targetPlanId ?? null) === null &&
        (input.kind !== 'topup' || invoice.amountMinor === input.amountMinor));
  if (!same) throw new PaymentError('IDEMPOTENCY_KEY_REUSED');
  return invoice;
}
