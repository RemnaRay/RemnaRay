import { Prisma, type PrismaClient } from '@remnaray/db';
import { invoicesTotal, paymentsEventsTotal, revenueMinorTotal } from '@remnaray/metrics';

import { formatInvoiceNumber } from './checkout';
import { PaymentError } from './payments.errors';
import type { ProviderEvent } from './payments.types';
import type { Tx } from '../rewards/rewards.types';
import { emitWebhook, minor, subscriptionData } from '../webhooks/outgoing';

/**
 * Money that settles inside a payment transaction and is not part of the
 * payment itself: referral accrual, its reversal and promo-code settlement.
 * Section 15.2 requires these to run in the same transaction as the payment.
 */
export interface RewardHooksPort {
  onPaid(
    tx: Tx,
    source: { id: string; userId: string; type: string; amountMinor: bigint },
  ): Promise<void>;
  onRefund(
    tx: Tx,
    source: { id: string; amountMinor: bigint },
    refundedMinor: bigint,
  ): Promise<void>;
  onInvoiceSettled(tx: Tx, invoiceId: string): Promise<void>;
  onInvoiceReleased(tx: Tx, invoiceId: string): Promise<void>;
}

/** F37 (ADR-021): what a top-up for a plan is meant to buy, for the purchase after it. */
export type InvoiceTarget = {
  planId: string;
  kind: 'purchase' | 'plan_change';
  promocode?: string | undefined;
};

export type InvoiceInput = {
  /** A pre-allocated `invoices.id`; the database default applies when absent. */
  id?: string | undefined;
  /** A pre-allocated `invoices.numeric_id`; the identity default applies when absent. */
  numericId?: bigint | undefined;
  userId: string;
  kind: 'purchase' | 'topup' | 'plan_change';
  planId?: string | undefined;
  provider: string;
  /** F37: `NN-00001` of a provider invoice; a balance invoice has none. */
  number?: string | undefined;
  target?: InvoiceTarget | undefined;
  amountMinor: bigint;
  currency: string;
  discountMinor?: bigint | undefined;
  promocodeId?: string | undefined;
  /**
   * Section 15.5: the reservation the discount comes from, linked to the
   * invoice in the transaction that creates it — a balance invoice is settled
   * there too, and settlement applies the reservation it finds.
   */
  promocodeRedemption?: { id: string; appliedValueMinor: bigint } | undefined;
  idempotencyKey: string;
  expiresAt: Date;
  providerInvoiceId?: string | undefined;
  paymentUrl?: string | undefined;
  starsInvoiceLink?: string | undefined;
  providerPayload?: Record<string, unknown> | undefined;
  providerAmount?: string | undefined;
  providerCurrency?: string | undefined;
  fxRate?: string | undefined;
};

export type StoredEvent = { id: string; duplicate: boolean };

function invoiceData(input: InvoiceInput) {
  return {
    ...(input.id ? { id: input.id } : {}),
    ...(input.numericId === undefined ? {} : { numericId: input.numericId }),
    userId: input.userId,
    kind: input.kind,
    planId: input.planId ?? null,
    provider: input.provider,
    number: input.number ?? null,
    targetPlanId: input.target?.planId ?? null,
    targetKind: input.target?.kind ?? null,
    targetPromocode: input.target?.promocode ?? null,
    status: 'pending' as const,
    amountMinor: input.amountMinor,
    currency: input.currency,
    discountMinor: input.discountMinor ?? 0n,
    promocodeId: input.promocodeId ?? null,
    idempotencyKey: input.idempotencyKey,
    expiresAt: input.expiresAt,
    providerInvoiceId: input.providerInvoiceId ?? null,
    paymentUrl: input.paymentUrl ?? null,
    providerPayload: (input.providerPayload ?? {}) as Prisma.InputJsonValue,
    providerAmount: input.providerAmount ?? null,
    providerCurrency: input.providerCurrency ?? null,
    fxRate: input.fxRate ?? null,
  };
}

async function linkRedemption(
  tx: Prisma.TransactionClient,
  invoiceId: string,
  input: InvoiceInput,
): Promise<void> {
  if (!input.promocodeRedemption) return;
  await tx.promocodeRedemption.updateMany({
    where: { id: input.promocodeRedemption.id, status: 'reserved', invoiceId: null },
    data: { invoiceId, appliedValueMinor: input.promocodeRedemption.appliedValueMinor },
  });
}

/** FR-020: a plan is sold while it is active and not deleted. */
function planAvailable<T extends { isActive: boolean; deletedAt: Date | null }>(
  plan: T | null,
): plan is T {
  return plan !== null && plan.isActive && plan.deletedAt === null;
}

/** Money formatting for notification parameters, in exact minor units. */
function formatMinorRub(amountMinor: bigint): string {
  const units = (amountMinor / 100n).toString();
  const cents = (amountMinor % 100n).toString().padStart(2, '0');
  return `${cents === '00' ? units : `${units},${cents}`} \u20bd`;
}

async function queueNotification(
  tx: Prisma.TransactionClient,
  event: string,
  userId: string,
  dedupKey: string,
  params: Record<string, string> = {},
  subscriptionId?: string,
): Promise<void> {
  await tx.outboxJob.create({
    data: {
      queue: 'notify',
      name: 'notify.send',
      payload: { event, userId, dedupKey, params, ...(subscriptionId ? { subscriptionId } : {}) },
      jobId: `notify:${dedupKey}`,
    },
  });
}

/**
 * Section 9.8 `payment.succeeded`: money taken for an invoice, whether it
 * bought the plan or went to the balance (a top-up, or EX-02 late payment).
 */
async function paymentSucceeded(
  tx: Prisma.TransactionClient,
  row: {
    id: string;
    userId: string;
    type: string;
    amountMinor: bigint;
    currency: string;
    provider: string | null;
  },
  invoice: { id: string; planId: string | null },
): Promise<void> {
  await emitWebhook(tx, 'payment.succeeded', row.userId, {
    transactionId: row.id,
    invoiceId: invoice.id,
    type: row.type,
    amountMinor: minor(row.amountMinor),
    currency: row.currency,
    provider: row.provider,
    planId: invoice.planId,
  });
}

export class PaymentsRepository {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly rewards?: RewardHooksPort,
  ) {}

  async findInvoice(id: string) {
    return this.prisma.invoice.findUnique({ where: { id } });
  }

  async findByIdempotencyKey(key: string) {
    return this.prisma.invoice.findUnique({ where: { idempotencyKey: key } });
  }

  /**
   * F37: the next number of a provider's invoice. Taken in its own statement
   * before the provider is called, because the number is in the description
   * the provider shows; a call that fails leaves its number unused.
   */
  async nextInvoiceNumber(provider: string): Promise<string> {
    const [row] = await this.prisma.$queryRaw<Array<{ last: bigint }>>(Prisma.sql`
      INSERT INTO invoice_counters (provider, last) VALUES (${provider}, 1)
      ON CONFLICT (provider) DO UPDATE SET last = invoice_counters.last + 1
      RETURNING last
    `);
    if (!row) throw new Error('INVOICE_NUMBER_NOT_ISSUED');
    return formatInvoiceNumber(provider, row.last);
  }

  async createInvoice(input: InvoiceInput) {
    try {
      invoicesTotal.inc({ provider: input.provider, status: 'pending' });
      return await this.prisma.$transaction(async (tx) => {
        const invoice = await tx.invoice.create({ data: invoiceData(input) });
        await linkRedemption(tx, invoice.id, input);
        return invoice;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
        return this.prisma.invoice.findUniqueOrThrow({
          where: { idempotencyKey: input.idempotencyKey },
        });
      throw error;
    }
  }

  /**
   * FR-070, section 11.3.7: a balance invoice is paid when it is created or
   * not created at all. The row and the debit share one transaction, so an
   * `INSUFFICIENT_FUNDS` leaves no pending invoice behind — one that a later
   * request under the same key would hand back and «Проверить» would try to
   * settle.
   */
  async createBalanceInvoice(input: InvoiceInput) {
    try {
      const invoice = await this.prisma.$transaction(async (tx) => {
        const created = await tx.invoice.create({ data: invoiceData(input) });
        await linkRedemption(tx, created.id, input);
        await this.settleBalance(tx, created.id);
        return created;
      });
      invoicesTotal.inc({ provider: input.provider, status: 'paid' });
      return invoice;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
        return this.prisma.invoice.findUniqueOrThrow({
          where: { idempotencyKey: input.idempotencyKey },
        });
      throw error;
    }
  }

  async insertEvent(input: {
    provider: string;
    externalId: string;
    invoiceId?: string;
    event: ProviderEvent;
    raw: Record<string, unknown>;
    headers: Record<string, string>;
    signatureOk: boolean;
  }): Promise<StoredEvent> {
    try {
      const row = await this.prisma.paymentEvent.create({
        data: {
          provider: input.provider,
          externalId: input.externalId,
          invoiceId: input.invoiceId ?? null,
          type: input.event.type,
          raw: input.raw as Prisma.InputJsonValue,
          headers: input.headers,
          signatureOk: input.signatureOk,
        },
        select: { id: true },
      });
      return { id: row.id, duplicate: false };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const row = await this.prisma.paymentEvent.findUniqueOrThrow({
          where: {
            provider_externalId: { provider: input.provider, externalId: input.externalId },
          },
          select: { id: true },
        });
        return { id: row.id, duplicate: true };
      }
      throw error;
    }
  }

  /**
   * Signed events still unprocessed that arrived before `before`, oldest
   * first (the backstop's read of `ix_payment_events_unapplied_p`).
   */
  async unappliedEvents(before: Date, limit: number): Promise<Array<{ id: string }>> {
    return this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT id FROM payment_events
      WHERE processed_at IS NULL AND signature_ok AND received_at < ${before}
      ORDER BY received_at LIMIT ${limit}
    `);
  }

  /** Why an apply failed; the event stays unprocessed for the next attempt. */
  async markEventError(id: string, processError: string): Promise<void> {
    await this.prisma.$executeRaw(Prisma.sql`
      UPDATE payment_events SET process_error = ${processError} WHERE id = ${id}::uuid
    `);
  }

  async markEvent(id: string, processedAt: Date, processError?: string): Promise<void> {
    await this.prisma.$executeRaw(Prisma.sql`
      UPDATE payment_events SET processed_at = ${processedAt}, process_error = ${processError ?? null}
      WHERE id = ${id}::uuid
    `);
  }

  async expire(now = new Date()): Promise<number> {
    // Section 11.4: an expired invoice gives its promocode reservation back, in
    // the same transaction as the status change. The row locks the UPDATE
    // takes also order it against a payment being applied to the invoice.
    const expired = await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string; provider: string }>>(Prisma.sql`
        UPDATE invoices SET status = 'expired', updated_at = now()
        WHERE status = 'pending' AND expires_at < ${now}
        RETURNING id, provider
      `);
      for (const row of rows) await this.rewards?.onInvoiceReleased(tx, row.id);
      return rows;
    });
    const byProvider = new Map<string, number>();
    for (const row of expired)
      byProvider.set(row.provider, (byProvider.get(row.provider) ?? 0) + 1);
    for (const [provider, count] of byProvider)
      invoicesTotal.inc({ provider, status: 'expired' }, count);
    return expired.length;
  }

  private async settleBalance(tx: Tx, invoiceId: string): Promise<void> {
    const rows = await tx.$queryRaw<
      Array<{
        id: string;
        userId: string;
        amountMinor: bigint;
        planId: string | null;
        status: string;
        kind: string;
      }>
    >(
      Prisma.sql`SELECT id, user_id AS "userId", amount_minor AS "amountMinor", plan_id AS "planId", status, kind::text AS kind FROM invoices WHERE id = ${invoiceId}::uuid FOR UPDATE`,
    );
    const invoice = rows[0];
    if (!invoice || invoice.status !== 'pending') return;
    await this.lockAccounts(tx, invoice.userId, { revenue: true });
    const accounts = await tx.$queryRaw<Array<{ id: string; kind: string; balance: bigint }>>(
      Prisma.sql`SELECT id, kind, balance_minor AS balance FROM accounts WHERE (kind = 'user'::account_kind AND user_id = ${invoice.userId}::uuid) OR kind = 'revenue'::account_kind ORDER BY id FOR UPDATE`,
    );
    const user = accounts.find((row) => row.kind === 'user');
    const revenue = accounts.find((row) => row.kind === 'revenue');
    if (!user || !revenue) throw new Error('ACCOUNT_NOT_FOUND');
    // Section 15.2: held referral rewards are shown as pending and cannot be
    // spent; the available balance is `balance_minor − SUM(held rewards)`.
    const [held] = await tx.$queryRaw<Array<{ held: bigint }>>(Prisma.sql`
      SELECT COALESCE(SUM(rr.amount_minor), 0)::bigint AS held
      FROM referral_rewards rr
      JOIN transactions t ON t.id = rr.transaction_id
      WHERE t.user_id = ${invoice.userId}::uuid AND rr.status = 'held'
    `);
    if (user.balance - (held?.held ?? 0n) < invoice.amountMinor)
      throw new PaymentError('INSUFFICIENT_FUNDS');
    const transaction = await tx.transaction.create({
      data: {
        userId: invoice.userId,
        type: 'purchase',
        status: 'completed',
        amountMinor: invoice.amountMinor,
        currency: 'RUB',
        provider: 'balance',
        invoiceId: invoice.id,
      },
    });
    await tx.ledgerEntry.create({
      data: {
        transactionId: transaction.id,
        debitAccountId: user.id,
        creditAccountId: revenue.id,
        amountMinor: invoice.amountMinor,
        currency: 'RUB',
      },
    });
    await tx.account.update({
      where: { id: user.id },
      data: { balanceMinor: { decrement: invoice.amountMinor } },
    });
    await tx.account.update({
      where: { id: revenue.id },
      data: { balanceMinor: { increment: invoice.amountMinor } },
    });
    // F37: the one entry that moves money into `revenue` (section 12.2) —
    // every sale is a purchase from the balance.
    revenueMinorTotal.inc({ provider: 'balance' }, Number(invoice.amountMinor));
    await tx.invoice.update({
      where: { id: invoice.id },
      data: { status: 'paid', paidAt: new Date() },
    });
    // EX-06: the unused time was priced into this invoice as the plan-change
    // credit, so a plan change starts now, as it does when a provider pays.
    if (invoice.planId)
      await this.activateSubscription(
        tx,
        invoice.userId,
        invoice.planId,
        invoice.kind === 'plan_change',
      );
    await queueNotification(
      tx,
      'payment.succeeded',
      invoice.userId,
      `payment.succeeded:${invoice.id}`,
      { amount: formatMinorRub(invoice.amountMinor) },
    );
    await paymentSucceeded(tx, transaction, invoice);
    await this.rewards?.onInvoiceSettled(tx, invoice.id);
    await this.rewards?.onPaid(tx, {
      id: transaction.id,
      userId: invoice.userId,
      type: 'purchase',
      amountMinor: invoice.amountMinor,
    });
    await tx.outboxJob.create({
      data: {
        queue: 'panel',
        name: 'panel.sync-user',
        payload: { userId: invoice.userId, reason: 'paid' },
        jobId: `sync:${invoice.userId}`,
      },
    });
  }

  async refund(transactionId: string, amountMinor: bigint, reason: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<
        Array<{
          id: string;
          userId: string;
          amountMinor: bigint;
          refundedMinor: bigint;
          provider: string | null;
          type: string;
        }>
      >(
        Prisma.sql`SELECT id, user_id AS "userId", amount_minor AS "amountMinor", refunded_minor AS "refundedMinor", provider, type::text AS type FROM transactions WHERE id = ${transactionId}::uuid FOR UPDATE`,
      );
      const original = rows[0];
      if (!original) throw new PaymentError('TRANSACTION_NOT_FOUND');
      // FR-066/EX-05: `revenue → user` returns what a purchase paid into
      // revenue. A top-up (or any other credit) never reached revenue, and
      // "refunding" it would pay the same money into the balance again.
      if (original.type !== 'purchase') throw new PaymentError('REFUND_NOT_PURCHASE');
      if (amountMinor <= 0n || original.refundedMinor + amountMinor > original.amountMinor)
        throw new PaymentError('REFUND_EXCEEDS_REMAINING');
      await this.lockAccounts(tx, original.userId, { revenue: true });
      const accounts = await tx.$queryRaw<Array<{ id: string; kind: string }>>(
        Prisma.sql`SELECT id, kind FROM accounts WHERE (kind = 'revenue'::account_kind) OR (kind = 'user'::account_kind AND user_id = ${original.userId}::uuid) ORDER BY id FOR UPDATE`,
      );
      const revenue = accounts.find((row) => row.kind === 'revenue');
      const user = accounts.find((row) => row.kind === 'user');
      if (!revenue || !user) throw new Error('ACCOUNT_NOT_FOUND');
      const refund = await tx.transaction.create({
        data: {
          userId: original.userId,
          type: 'refund',
          status: 'completed',
          amountMinor,
          currency: 'RUB',
          provider: original.provider,
          parentId: original.id,
          reason,
        },
      });
      await tx.ledgerEntry.create({
        data: {
          transactionId: refund.id,
          debitAccountId: revenue.id,
          creditAccountId: user.id,
          amountMinor,
          currency: 'RUB',
        },
      });
      await tx.account.update({
        where: { id: revenue.id },
        data: { balanceMinor: { decrement: amountMinor } },
      });
      await tx.account.update({
        where: { id: user.id },
        data: { balanceMinor: { increment: amountMinor } },
      });
      await tx.transaction.update({
        where: { id: original.id },
        data: { refundedMinor: original.refundedMinor + amountMinor },
      });
      await emitWebhook(tx, 'payment.refunded', original.userId, {
        transactionId: refund.id,
        refundedTransactionId: original.id,
        amountMinor: minor(amountMinor),
        currency: refund.currency,
        provider: original.provider,
        reason,
      });
      await this.rewards?.onRefund(
        tx,
        { id: original.id, amountMinor: original.amountMinor },
        original.refundedMinor + amountMinor,
      );
    });
  }

  async applyEvent(eventId: string): Promise<void> {
    const event = await this.prisma.paymentEvent.findUnique({ where: { id: eventId } });
    if (!event || event.processedAt) return;
    const counted = (result: string) => {
      paymentsEventsTotal.inc({ provider: event.provider, type: event.type, result });
    };
    if (!event.signatureOk) {
      await this.markEvent(event.id, new Date(), 'WEBHOOK_INVALID_SIGNATURE');
      counted('invalid_signature');
      return;
    }
    if (!event.invoiceId) {
      await this.markEvent(event.id, new Date(), 'INVOICE_NOT_FOUND');
      counted('no_invoice');
      return;
    }
    const parsed = event.raw as { providerInvoiceId?: string; paidAmountMinorRub?: string };
    await this.prisma
      .$transaction(async (tx) => {
        // Two deliveries of one event may both have read `processed_at` as
        // null above. The event row is the lock that makes applying it once:
        // the second waits here and then finds the first one's mark.
        const eventRows = await tx.$queryRaw<Array<{ processedAt: Date | null }>>(Prisma.sql`
        SELECT processed_at AS "processedAt" FROM payment_events
        WHERE id = ${event.id}::uuid FOR UPDATE
      `);
        if (eventRows[0]?.processedAt) return;
        const invoiceRows = await tx.$queryRaw<
          Array<{
            id: string;
            userId: string;
            kind: string;
            provider: string;
            status: string;
            amountMinor: bigint;
            expiresAt: Date;
            planId: string | null;
            number: string | null;
            targetPlanId: string | null;
          }>
        >(Prisma.sql`
        SELECT id, user_id AS "userId", kind, provider, status, amount_minor AS "amountMinor",
               expires_at AS "expiresAt", plan_id AS "planId", number,
               target_plan_id AS "targetPlanId"
        FROM invoices WHERE id = ${event.invoiceId}::uuid FOR UPDATE
      `);
        const invoice = invoiceRows[0];
        if (!invoice) throw new PaymentError('INVOICE_NOT_FOUND');
        if (event.type === 'canceled' && invoice.status === 'pending') {
          await tx.invoice.update({ where: { id: invoice.id }, data: { status: 'canceled' } });
          invoicesTotal.inc({ provider: invoice.provider, status: 'canceled' });
          await this.rewards?.onInvoiceReleased(tx, invoice.id);
        }
        // Section 11.4: money is accepted onto an invoice that is pending,
        // expired (EX-02) or canceled. Another `paid` event for an invoice
        // already paid or underpaid is the same payment reported again
        // (EX-03), except for Stars, where a new charge id is new money.
        const settled = invoice.status === 'paid' || invoice.status === 'underpaid';
        if (event.type === 'paid' && settled && invoice.provider === 'stars')
          await this.creditSecondCharge(tx, event.id, invoice, parsed.paidAmountMinorRub);
        if (event.type === 'paid' && !settled) {
          const paid = parsed.paidAmountMinorRub
            ? BigInt(parsed.paidAmountMinorRub)
            : invoice.amountMinor;
          const underpaid = paid * 100n < invoice.amountMinor * 98n;
          // F37 (ADR-021): a provider invoice is a top-up. Money that arrives
          // for it — in time, late (EX-02), after a cancel, for a plan taken
          // off sale (О-19) or for an invoice written before F37 — goes to the
          // balance; the customer buys from there as a second step.
          await this.lockAccounts(tx, invoice.userId, {
            provider: invoice.provider,
            revenue: false,
          });
          // Section 11.2 (L-11): within the tolerance or above the invoice the
          // credit is the invoice amount; an underpayment (EX-12) credits what
          // was actually paid.
          const credit = underpaid && paid > 0n ? paid : invoice.amountMinor;
          await tx.invoice.update({
            where: { id: invoice.id },
            data: { status: underpaid ? 'underpaid' : 'paid', paidAt: new Date() },
          });
          invoicesTotal.inc({
            provider: invoice.provider,
            status: underpaid ? 'underpaid' : 'paid',
          });
          const txRow = await tx.transaction.create({
            data: {
              userId: invoice.userId,
              type: 'topup',
              status: 'completed',
              amountMinor: credit,
              currency: 'RUB',
              provider: invoice.provider,
              invoiceId: invoice.id,
            },
          });
          await this.postEntry(
            tx,
            txRow.id,
            invoice.userId,
            invoice.provider,
            credit,
            'provider_clearing',
            'user',
          );
          await queueNotification(
            tx,
            'payment.to_balance',
            invoice.userId,
            `payment.to_balance:${invoice.id}`,
            await this.toBalanceParams(tx, invoice, credit, underpaid),
          );
          if (underpaid)
            await tx.outboxJob.create({
              data: {
                queue: 'notify',
                name: 'notify.alert',
                payload: { type: 'payment.underpaid', details: invoice.id },
                jobId: `alert:payment.underpaid:${invoice.id}`,
              },
            });
          await paymentSucceeded(tx, txRow, invoice);
          // A reservation only an invoice written before F37 can hold: the
          // plan was not bought, so the promocode slot is given back.
          await this.rewards?.onInvoiceReleased(tx, invoice.id);
          await this.rewards?.onPaid(tx, {
            id: txRow.id,
            userId: invoice.userId,
            type: txRow.type,
            amountMinor: txRow.amountMinor,
          });
        }
        await tx.$executeRaw(Prisma.sql`
        UPDATE payment_events SET processed_at = now() WHERE id = ${event.id}::uuid
      `);
      })
      .then(
        () => {
          counted('applied');
        },
        (error: unknown) => {
          counted('failed');
          throw error;
        },
      );
  }

  /** F37: what `payment.to_balance` says, and the «Купить <тариф>» button when the top-up was for a plan. */
  private async toBalanceParams(
    tx: Prisma.TransactionClient,
    invoice: {
      id: string;
      userId: string;
      amountMinor: bigint;
      number: string | null;
      targetPlanId: string | null;
    },
    credit: bigint,
    underpaid: boolean,
  ): Promise<Record<string, string>> {
    const [user, plan] = await Promise.all([
      tx.user.findUnique({ where: { id: invoice.userId }, select: { language: true } }),
      invoice.targetPlanId ? tx.plan.findUnique({ where: { id: invoice.targetPlanId } }) : null,
    ]);
    const names = (plan?.name ?? {}) as Record<string, string>;
    const name = plan ? (names[user?.language ?? 'ru'] ?? names.ru ?? plan.slug) : '';
    return {
      amount: formatMinorRub(credit),
      hasNumber: invoice.number ? 'yes' : 'no',
      number: invoice.number ?? '',
      underpaid: underpaid ? 'yes' : 'no',
      expected: underpaid ? formatMinorRub(invoice.amountMinor) : '',
      hasPlan: plan && planAvailable(plan) ? 'yes' : 'no',
      plan: name,
      buyInvoice: plan && planAvailable(plan) ? invoice.id : '',
    };
  }

  /**
   * Owner decision 2026-09-25: a second, distinct Telegram Stars charge for an
   * invoice already settled — two copies of one invoice paid before the first
   * was applied — is new money. `transactions.invoice_id` is unique, so it is
   * credited to the balance as a top-up of its own, and the administrators
   * are alerted. Its `telegram_payment_charge_id` is the event it came from.
   */
  private async creditSecondCharge(
    tx: Prisma.TransactionClient,
    eventId: string,
    invoice: { id: string; userId: string; provider: string; amountMinor: bigint },
    paidAmountMinorRub: string | undefined,
  ): Promise<void> {
    const credit = paidAmountMinorRub ? BigInt(paidAmountMinorRub) : invoice.amountMinor;
    if (credit <= 0n) return;
    await this.lockAccounts(tx, invoice.userId, { provider: invoice.provider, revenue: false });
    const txRow = await tx.transaction.create({
      data: {
        userId: invoice.userId,
        type: 'topup',
        status: 'completed',
        amountMinor: credit,
        currency: 'RUB',
        provider: invoice.provider,
        reason: `second payment for invoice ${invoice.id}`,
      },
    });
    await this.postEntry(
      tx,
      txRow.id,
      invoice.userId,
      invoice.provider,
      credit,
      'provider_clearing',
      'user',
    );
    await queueNotification(
      tx,
      'payment.to_balance',
      invoice.userId,
      `payment.to_balance:${eventId}`,
      {
        amount: formatMinorRub(credit),
        hasNumber: 'no',
        number: '',
        underpaid: 'no',
        expected: '',
        hasPlan: 'no',
        plan: '',
        buyInvoice: '',
      },
    );
    await tx.outboxJob.create({
      data: {
        queue: 'notify',
        name: 'notify.alert',
        payload: { type: 'payment.duplicate', details: invoice.id },
        jobId: `alert:payment.duplicate:${eventId}`,
      },
    });
    await paymentSucceeded(tx, txRow, { id: invoice.id, planId: null });
    await this.rewards?.onPaid(tx, {
      id: txRow.id,
      userId: invoice.userId,
      type: txRow.type,
      amountMinor: txRow.amountMinor,
    });
  }

  /**
   * Section 11.7 (R74): every account a payment moves money between is
   * locked up front in one `ORDER BY id FOR UPDATE` — the payer, the
   * provider's clearing account, revenue and, when rewards run, the
   * referrer's account and `referral_expense` that `onPaid`/`onRefund`
   * post to. Locking them one entry at a time let two money paths take the
   * same rows in opposite orders and deadlock. Later locks of these rows in
   * the same transaction are already held and never wait.
   */
  private async lockAccounts(
    tx: Prisma.TransactionClient,
    userId: string,
    options: { provider?: string; revenue: boolean },
  ): Promise<void> {
    const users = [userId];
    const kinds: string[] = options.revenue ? ['revenue'] : [];
    if (this.rewards) {
      const attribution = await tx.referralAttribution.findUnique({
        where: { refereeId: userId },
        select: { referrerId: true, status: true },
      });
      if (attribution && attribution.status !== 'rejected') {
        users.push(attribution.referrerId);
        kinds.push('referral_expense');
      }
    }
    for (const user of users) await this.ensureAccount(tx, 'user', user, '');
    for (const kind of kinds) await this.ensureAccount(tx, kind, userId, '');
    if (options.provider)
      await this.ensureAccount(tx, 'provider_clearing', userId, options.provider);
    await tx.$queryRaw(Prisma.sql`
      SELECT id FROM accounts WHERE
        (kind = 'user'::account_kind AND user_id = ANY(${users}::uuid[]))
        OR (kind::text = ANY(${kinds}::text[]))
        OR (kind = 'provider_clearing'::account_kind AND provider = ${options.provider ?? null})
      ORDER BY id FOR UPDATE
    `);
  }

  private async postEntry(
    tx: Prisma.TransactionClient,
    transactionId: string,
    userId: string,
    provider: string,
    amount: bigint,
    debitKind: string,
    creditKind: string,
  ) {
    await this.ensureAccount(tx, debitKind, userId, provider);
    await this.ensureAccount(tx, creditKind, userId, provider);
    const accounts = await tx.$queryRaw<Array<{ id: string; kind: string }>>(Prisma.sql`
      SELECT id, kind FROM accounts WHERE
        (kind = ${debitKind}::account_kind AND (${debitKind} <> 'user' OR user_id = ${userId}::uuid) AND (${debitKind} <> 'provider_clearing' OR provider = ${provider}))
        OR (kind = ${creditKind}::account_kind AND (${creditKind} <> 'user' OR user_id = ${userId}::uuid) AND (${creditKind} <> 'provider_clearing' OR provider = ${provider}))
      ORDER BY id FOR UPDATE
    `);
    const debit = accounts.find((row) => row.kind === debitKind);
    const credit = accounts.find((row) => row.kind === creditKind);
    if (!debit || !credit) throw new PaymentError('INVOICE_NOT_FOUND', 'Ledger account missing');
    await tx.ledgerEntry.create({
      data: {
        transactionId,
        debitAccountId: debit.id,
        creditAccountId: credit.id,
        amountMinor: amount,
        currency: 'RUB',
      },
    });
    await tx.account.update({
      where: { id: debit.id },
      data: { balanceMinor: { decrement: amount } },
    });
    await tx.account.update({
      where: { id: credit.id },
      data: { balanceMinor: { increment: amount } },
    });
  }

  private async ensureAccount(
    tx: Prisma.TransactionClient,
    kind: string,
    userId: string,
    provider: string,
  ) {
    if (kind === 'user') {
      await tx.$executeRaw(
        Prisma.sql`INSERT INTO accounts (kind, user_id, currency) VALUES ('user'::account_kind, ${userId}::uuid, 'RUB') ON CONFLICT DO NOTHING`,
      );
    } else if (kind === 'provider_clearing') {
      await tx.$executeRaw(
        Prisma.sql`INSERT INTO accounts (kind, provider, currency) VALUES ('provider_clearing'::account_kind, ${provider}, 'RUB') ON CONFLICT DO NOTHING`,
      );
    } else {
      const existing = await tx.$queryRaw<Array<{ id: string }>>(
        Prisma.sql`SELECT id FROM accounts WHERE kind = ${kind}::account_kind AND currency = 'RUB' LIMIT 1`,
      );
      if (!existing[0])
        await tx.$executeRaw(
          Prisma.sql`INSERT INTO accounts (kind, currency) VALUES (${kind}::account_kind, 'RUB')`,
        );
    }
  }

  private async activateSubscription(
    tx: Prisma.TransactionClient,
    userId: string,
    planId: string,
    planChange = false,
  ) {
    const plan = await tx.plan.findUnique({ where: { id: planId } });
    if (!planAvailable(plan)) throw new PaymentError('PLAN_UNAVAILABLE');
    const now = new Date();
    const live = await tx.subscription.findFirst({
      where: { userId, status: { in: ['provisioning', 'active', 'grace'] } },
      orderBy: { expiresAt: 'desc' },
    });
    const base =
      !planChange && live?.status === 'active' && live.expiresAt > now ? live.expiresAt : now;
    const data = {
      planId: plan.id,
      source: 'purchase' as const,
      status: 'active' as const,
      startsAt:
        !planChange && live?.status === 'active' && live.expiresAt > now ? live.startsAt : now,
      expiresAt: new Date(base.getTime() + plan.durationDays * 86_400_000),
      trafficLimitBytes: plan.trafficLimitBytes,
      deviceLimit: plan.deviceLimit,
      squads: plan.squads,
      trafficResetStrategy: plan.trafficResetStrategy,
    };
    // FR-022 renews in `grace` and `expired` too, so the plan renewed is the
    // latest subscription's, live or not.
    const previous =
      live ??
      (await tx.subscription.findFirst({ where: { userId }, orderBy: { expiresAt: 'desc' } }));
    const subscription = live
      ? await tx.subscription.update({ where: { id: live.id }, data })
      : await tx.subscription.create({ data: { userId, ...data } });
    // Section 10.4: renewing the same plan resets the panel's traffic. FR-023:
    // a plan change resets it only when the new limit is below what is used,
    // which the job reads from the panel when it runs. A job of its own, not a
    // `reason` on `panel.sync-user`: syncs of one user are deduplicated, and a
    // reason would be dropped with the job that carried it. Written before the
    // callers' sync, so the relay publishes it first.
    const reset = planChange
      ? plan.trafficLimitBytes > 0n
        ? { ifUsedAboveBytes: plan.trafficLimitBytes.toString() }
        : null
      : previous?.planId === plan.id
        ? {}
        : null;
    if (previous && reset)
      await tx.outboxJob.create({
        data: {
          queue: 'panel',
          name: 'panel.reset-traffic',
          payload: { userId, ...reset },
          jobId: `panel:traffic:${subscription.id}:${String(subscription.expiresAt.getTime())}`,
        },
      });
    await queueNotification(
      tx,
      'sub.activated',
      userId,
      `sub.activated:${subscription.id}:${subscription.expiresAt.toISOString()}`,
      { until: subscription.expiresAt.toISOString().slice(0, 10) },
      subscription.id,
    );
    await emitWebhook(tx, 'subscription.activated', userId, subscriptionData(subscription));
  }
}
