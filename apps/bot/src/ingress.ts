import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { BotError, type Bot, type Context } from 'grammy';
import { run, type RunnerHandle } from '@grammyjs/runner';
import type { Update } from 'grammy/types';
import type Redis from 'ioredis';

import { ALLOWED_UPDATES, type BotConfig, type RrContext } from './types.js';
import { botUpdatesTotal } from '@remnaray/metrics';

export const TELEGRAM_UPDATES_STREAM = 'tg:updates';
/** The support bot's updates (F35), beside the shop bot's. */
export const SUPPORT_UPDATES_STREAM = 'tg:support-updates';

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

export const SUPPORT_CHANNEL: IngressChannel = {
  stream: SUPPORT_UPDATES_STREAM,
  group: 'support-bot',
  received: 'tg:support-received:',
  allowedUpdates: ['message', 'callback_query', 'my_chat_member'],
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
        for (const [id, fields] of claimed[1]) await this.processMessage(id, fields);
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
        for (const [, messages] of batches ?? []) {
          for (const [id, fields] of messages) await this.processMessage(id, fields);
        }
      } catch (error) {
        // Keep PEL entries for retry; never print the update payload or token.
        console.error('Telegram update stream failed', {
          error: error instanceof Error ? error.message : 'unknown',
        });
        await delay(500);
      }
    }
  }

  private async processMessage(id: string, fields: string[]): Promise<void> {
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
      // `XAUTOCLAIM`.
      if (!(error instanceof BotError)) throw error;
      await this.report(error as BotError<C>);
    }
    // A handled update, failed or not, is done: redelivering it would run the
    // handler's side effects and the error reply again.
    await this.redis.xack(this.channel.stream, this.channel.group, id);
  }

  private async report(error: BotError<C>): Promise<void> {
    try {
      await this.bot.errorHandler(error);
    } catch (failure) {
      // Never the update payload or the token: the id and the error class only.
      console.error('Telegram error handler failed', {
        updateId: error.ctx.update.update_id,
        error: failure instanceof Error ? failure.name : 'unknown',
      });
    }
  }
}

/** The one field beside `update_id` is what Telegram calls the update's kind. */
function updateType(update: Update): string {
  const kind = Object.keys(update).find((key) => key !== 'update_id');
  return kind ?? 'unknown';
}
