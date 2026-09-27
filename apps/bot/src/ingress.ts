import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { BotError, type Bot, type Context } from 'grammy';
import { run, type RunnerHandle } from '@grammyjs/runner';
import type { Update } from 'grammy/types';
import type Redis from 'ioredis';

import { ALLOWED_UPDATES, type BotConfig, type RrContext } from './types.js';
import { logger } from './logger.js';
import { botUpdatesTotal } from '@remnaray/metrics';

export const TELEGRAM_UPDATES_STREAM = 'tg:updates';
/** Where one bot's updates are kept: the shop bot's by default. */
export type IngressChannel = {
  stream: string;
  group: string;
  /** Prefix of the key that makes a redelivered update a duplicate. */
  received: string;
  allowedUpdates: readonly string[];
};

export const SHOP_CHANNEL: IngressChannel = {
  stream: TELEGRAM_UPDATES_STREAM,
  group: 'bot',
  received: 'tg:received:',
  allowedUpdates: ALLOWED_UPDATES,
};

/**
 * A support bot's updates (F35), beside the shop bot's: named after the bot,
 * so the next bot never reads what a replaced one left behind.
 */
export function supportChannel(botId: string): IngressChannel {
  return {
    stream: `tg:support-updates:${botId}`,
    group: 'support-bot',
    received: `tg:support-received:${botId}:`,
    allowedUpdates: ['message', 'callback_query', 'my_chat_member'],
  };
}

/**
 * R102: an entry that keeps failing is given up after this many deliveries —
 * about five minutes, as `XAUTOCLAIM` takes it back after 60 s idle. A Stars
 * payment is never given up; the administrators are alerted instead.
 */
export const MAX_DELIVERIES = 5;

export type StuckPayment = { updateId: number; chargeId: string; deliveries: number };

export type IngressOptions = {
  /** Called for a `successful_payment` still unrecorded at `MAX_DELIVERIES`. */
  onPaymentStuck?: (payment: StuckPayment) => Promise<void>;
};

// Both transports persist before acknowledging delivery. Telegram may redeliver
// an update during a mode transition, so append and dedup must be atomic.
const APPEND = `
if redis.call('EXISTS', KEYS[2]) == 1 then return 0 end
redis.call('XADD', KEYS[1], 'MAXLEN', '~', 10000, '*', 'payload', ARGV[1])
redis.call('SET', KEYS[2], '1', 'EX', 604800)
return 1`;

export class BotIngress<C extends Context = RrContext> {
  private runner: RunnerHandle | undefined;
  private streamLoop: Promise<void> | undefined;
  private stopping = false;
  private readonly reader: Redis;
  private claimCursor = '0-0';
  private transition = Promise.resolve();

  constructor(
    private readonly bot: Bot<C>,
    private readonly redis: Redis,
    private readonly consumer = `bot-${randomUUID()}`,
    private readonly channel: IngressChannel = SHOP_CHANNEL,
    private readonly options: IngressOptions = {},
  ) {
    this.reader = redis.duplicate();
  }

  start(config: Pick<BotConfig, 'mode' | 'webhookUrl' | 'secretToken'>): Promise<void> {
    const task = this.transition.then(() => this.configure(config));
    this.transition = task.catch(() => undefined);
    return task;
  }

  private async configure(config: Pick<BotConfig, 'mode' | 'webhookUrl' | 'secretToken'>) {
    await this.bot.init();
    if (!this.streamLoop) {
      try {
        await this.redis.xgroup(
          'CREATE',
          this.channel.stream,
          this.channel.group,
          '0-0',
          'MKSTREAM',
        );
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes('BUSYGROUP')) throw error;
      }
      this.streamLoop = this.consumeStream();
    }
    await this.runner?.stop();
    this.runner = undefined;
    if (config.mode === 'webhook') {
      await this.bot.api.setWebhook(config.webhookUrl, {
        secret_token: config.secretToken,
        allowed_updates: [...this.channel.allowedUpdates] as never,
        drop_pending_updates: false,
        max_connections: 40,
      });
    } else {
      await this.bot.api.deleteWebhook({ drop_pending_updates: false });
      // A batch is durably stored before runner advances its Telegram offset.
      this.runner = run(
        {
          api: {
            getUpdates: async (args, signal) => {
              const updates = await this.bot.api.getUpdates(
                { ...args, allowed_updates: [...this.channel.allowedUpdates] as never },
                signal,
              );
              for (const update of updates) await this.append(update);
              return updates;
            },
          },
          handleUpdate: () => Promise.resolve(),
          errorHandler: () => {
            throw new Error('Telegram ingress failed');
          },
        },
        { runner: { silent: true } },
      );
    }
  }

  async append(update: Update): Promise<void> {
    await this.redis.eval(
      APPEND,
      2,
      this.channel.stream,
      `${this.channel.received}${String(update.update_id)}`,
      JSON.stringify(update),
    );
  }

  async stop(): Promise<void> {
    await this.transition;
    this.stopping = true;
    await this.runner?.stop();
    await this.streamLoop;
    this.reader.disconnect();
  }

  private async consumeStream(): Promise<void> {
    while (!this.stopping) {
      try {
        const claimed = (await this.redis.xautoclaim(
          this.channel.stream,
          this.channel.group,
          this.consumer,
          60_000,
          this.claimCursor,
          'COUNT',
          10,
        )) as [string, Array<[string, string[]]>];
        this.claimCursor = claimed[0];
        await this.processBatch(claimed[1], true);
        const batches = (await this.reader.xreadgroup(
          'GROUP',
          this.channel.group,
          this.consumer,
          'COUNT',
          10,
          'BLOCK',
          5000,
          'STREAMS',
          this.channel.stream,
          '>',
        )) as Array<[string, Array<[string, string[]]>]> | null;
        for (const [, messages] of batches ?? []) await this.processBatch(messages, false);
      } catch (error) {
        // Reading the stream failed; the PEL keeps every unacknowledged entry.
        logger.error(
          { error: error instanceof Error ? error.message : 'unknown' },
          'Telegram update stream failed',
        );
        await delay(500);
      }
    }
  }

  /**
   * One entry failing never holds up the rest of its batch (R102). A new
   * entry is its first delivery; a claimed one reads its count from the PEL,
   * which `XAUTOCLAIM` has just incremented.
   */
  private async processBatch(entries: Array<[string, string[]]>, claimed: boolean): Promise<void> {
    for (const [id, fields] of entries) {
      let deliveries = 1;
      try {
        if (claimed) deliveries = await this.deliveries(id);
        await this.processMessage(id, fields, deliveries);
      } catch (error) {
        await this.failed(id, fields, deliveries, error);
      }
    }
  }

  private async deliveries(id: string): Promise<number> {
    const rows = (await this.redis.xpending(
      this.channel.stream,
      this.channel.group,
      id,
      id,
      1,
    )) as Array<[string, string, number, number]>;
    // Claimed, so delivered at least twice even if the entry left the PEL.
    return Math.max(rows[0]?.[3] ?? 2, 2);
  }

  /** An entry that could not be handled at all stays pending up to the limit. */
  private async failed(
    id: string,
    fields: string[] | null,
    deliveries: number,
    error: unknown,
  ): Promise<void> {
    const reason = error instanceof Error ? error.message : 'unknown';
    // Never print the update payload or token — and a parse error's message
    // quotes the payload, so only the error's class is logged.
    logger.error(
      { id, deliveries, error: error instanceof Error ? error.name : 'unknown' },
      'Telegram update stream entry failed',
    );
    const index = fields?.indexOf('payload') ?? -1;
    const payload = index < 0 ? undefined : fields?.[index + 1];
    const payment = paymentOf(payload);
    if (payment) {
      await this.stuck(payment, deliveries);
      return;
    }
    if (deliveries < MAX_DELIVERIES) return;
    try {
      await this.redis.xadd(
        `${this.channel.stream}:dead`,
        'MAXLEN',
        '~',
        1000,
        '*',
        'id',
        id,
        'payload',
        payload ?? '',
        'reason',
        reason.slice(0, 200),
        'deliveries',
        String(deliveries),
      );
      await this.redis.xack(this.channel.stream, this.channel.group, id);
      logger.error({ id, deliveries }, 'Telegram update stream entry dead-lettered');
    } catch (failure) {
      logger.error(
        { id, error: failure instanceof Error ? failure.name : 'unknown' },
        'Telegram update dead-letter failed',
      );
    }
  }

  /** A payment still unrecorded at the limit: kept, and the administrators told. */
  private async stuck(
    payment: { updateId: number; chargeId: string },
    deliveries: number,
  ): Promise<void> {
    if (deliveries < MAX_DELIVERIES || !this.options.onPaymentStuck) return;
    try {
      await this.options.onPaymentStuck({ ...payment, deliveries });
    } catch {
      logger.error({ updateId: payment.updateId }, 'Stars payment alert failed');
    }
  }

  private async processMessage(id: string, fields: string[], deliveries = 1): Promise<void> {
    const payloadIndex = fields.indexOf('payload');
    const payload = payloadIndex < 0 ? undefined : fields[payloadIndex + 1];
    if (!payload) throw new Error('Invalid stream envelope');
    const update = JSON.parse(payload) as Update;
    if (!Number.isSafeInteger(update.update_id)) throw new Error('Invalid update ID');
    // Section 9.9 `rr_bot_updates_total{type}`. Telegram names the kind of
    // update by the single field it carries beside `update_id`.
    botUpdatesTotal.inc({ type: updateType(update) });
    try {
      await this.bot.handleUpdate(update);
    } catch (error) {
      // grammY calls `bot.catch` only from `bot.start()` and the runner;
      // `handleUpdate` throws the `BotError` to its caller. FR-127: the error
      // handler logs it and answers `error.generic` with an incident id.
      // Anything else (the bot is not initialised) stays in the PEL for
      // `XAUTOCLAIM`, up to `MAX_DELIVERIES`.
      if (!(error instanceof BotError)) throw error;
      // R1: the stars are taken and Telegram never sends the update again,
      // so a payment the shop did not record stays in the PEL for
      // `XAUTOCLAIM`; recording it is idempotent by the charge id. The
      // customer is answered once, on the first delivery.
      const payment = update.message?.successful_payment;
      if (payment) {
        if (deliveries === 1) await this.report(error as BotError<C>);
        else
          logger.error(
            { updateId: update.update_id, deliveries },
            'Telegram payment update kept pending',
          );
        await this.stuck(
          { updateId: update.update_id, chargeId: payment.telegram_payment_charge_id },
          deliveries,
        );
        return;
      }
      await this.report(error as BotError<C>);
    }
    // Any other handled update, failed or not, is done: redelivering it would
    // run the handler's side effects and the error reply again.
    await this.redis.xack(this.channel.stream, this.channel.group, id);
  }

  private async report(error: BotError<C>): Promise<void> {
    try {
      await this.bot.errorHandler(error);
    } catch (failure) {
      // Never the update payload or the token: the id and the error class only.
      logger.error(
        {
          updateId: error.ctx.update.update_id,
          error: failure instanceof Error ? failure.name : 'unknown',
        },
        'Telegram error handler failed',
      );
    }
  }
}

/** The payment a raw stream payload carries, if it parses as one. */
function paymentOf(payload: string | undefined): { updateId: number; chargeId: string } | null {
  if (!payload) return null;
  try {
    const update = JSON.parse(payload) as Update;
    const payment = update.message?.successful_payment;
    return payment
      ? { updateId: update.update_id, chargeId: payment.telegram_payment_charge_id }
      : null;
  } catch {
    return null;
  }
}

/** The one field beside `update_id` is what Telegram calls the update's kind. */
function updateType(update: Update): string {
  const kind = Object.keys(update).find((key) => key !== 'update_id');
  return kind ?? 'unknown';
}
