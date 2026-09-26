import { HttpStatus, Injectable, Logger, Optional } from '@nestjs/common';

import { Infrastructure } from '../../infra/infra.module';
import { ApiError } from '../me/me.errors';
import { NotifyService } from '../notify/notify.service';
import { SettingsService } from '../settings/settings.service';

/** How long a plain forwarded message can still be answered by reply. */
const MESSAGE_TTL_SECONDS = 30 * 24 * 60 * 60;
const FORUM_TTL_SECONDS = 600;
/**
 * How long a conversation stays open without a message either way: until
 * then everything the customer writes to the bot goes to the operators.
 */
export const CONVERSATION_TTL_SECONDS = 24 * 60 * 60;

class TelegramCallError extends Error {
  constructor(
    readonly method: string,
    readonly code: number | undefined,
    readonly description: string,
  ) {
    super(`${method}: ${description}`);
    this.name = 'TelegramCallError';
  }
}

export type SupportTarget = { telegramId: string; language: string };
/** The bot a customer writes to support in: the shop's, or the support bot (F35). */
export type SupportVia = 'shop' | 'support';

/**
 * FR-124: a customer's message goes to the operators' chat
 * (`brand.support_forward_chat_id`), and an operator's answer goes back to
 * the customer. When that chat is a forum supergroup (the owner's choice),
 * every customer gets a topic of their own and anything written in it is the
 * answer; otherwise the answer is a reply to the forwarded message. Messages
 * are copied (`copyMessage`), so photos, files and voice messages go through
 * as they are (owner decision F35). The links between Telegram messages and
 * customers, and whether a customer's conversation is open, live in Valkey.
 */
@Injectable()
export class SupportService {
  private readonly logger = new Logger(SupportService.name);

  constructor(
    private readonly infra: Infrastructure,
    private readonly settings: SettingsService,
    @Optional() private readonly notify?: NotifyService,
  ) {}

  /**
   * «Поддержка» opens the customer's conversation: until «Завершить», or a
   * day without messages, what they write to the bot goes to the operators.
   */
  async open(telegramId: string): Promise<void> {
    await this.destination('shop');
    await this.infra.redis.set(openKey(telegramId), 'new', 'EX', CONVERSATION_TTL_SECONDS);
  }

  async close(telegramId: string): Promise<void> {
    await this.infra.redis.del(openKey(telegramId));
  }

  /**
   * Copies the customer's message `messageId` (in their chat with the bot)
   * to the operators. With `requireOpen`, a message outside an open
   * conversation is refused with `SUPPORT_CLOSED`. `acknowledge` is true for
   * the first message after «Поддержка» — in the support bot, the first of a
   * conversation — which the bot confirms. `via` is the bot the customer wrote
   * in: the copy is made by that bot, so it must be the one support runs in.
   */
  async forward(
    telegramId: string,
    messageId: number,
    options: { requireOpen?: boolean; via?: SupportVia } = {},
  ): Promise<{ acknowledge: boolean }> {
    const via = options.via ?? 'shop';
    const state = await this.infra.redis.get(openKey(telegramId));
    if (options.requireOpen && state === null)
      throw new ApiError('SUPPORT_CLOSED', HttpStatus.CONFLICT);
    const { chatId, token } = await this.destination(via);
    const user = await this.infra.db.user.findUnique({
      where: { telegramId: BigInt(telegramId) },
      select: { firstName: true, username: true, language: true },
    });
    const header = [
      `#support ${telegramId}${user?.username ? ` @${user.username}` : ''}`,
      [user?.firstName, user?.language].filter(Boolean).join(' · '),
    ]
      .filter(Boolean)
      .join('\n');
    try {
      const inTopic =
        (await this.isForum(chatId, token)) &&
        (await this.copyToTopic(chatId, token, telegramId, messageId, {
          name: `${user?.firstName ?? user?.username ?? 'user'} · ${telegramId}`.slice(0, 128),
          header,
        }));
      if (!inTopic) {
        // A plain group: the header names the customer, the copy replies to
        // it, and an operator's reply to either reaches the customer.
        const card = await this.call<{ message_id: number }>(token, 'sendMessage', {
          chat_id: chatId,
          text: header,
        });
        const copy = await this.call<{ message_id: number }>(token, 'copyMessage', {
          chat_id: chatId,
          from_chat_id: Number(telegramId),
          message_id: messageId,
          reply_parameters: { message_id: card.message_id, allow_sending_without_reply: true },
        });
        for (const id of [card.message_id, copy.message_id])
          await this.infra.redis.set(
            `rr:support:msg:${String(chatId)}:${String(id)}`,
            telegramId,
            'EX',
            MESSAGE_TTL_SECONDS,
          );
      }
    } catch (error) {
      this.logger.warn(`support forward failed: ${String(error)}`);
      throw new ApiError('SUPPORT_UNAVAILABLE', HttpStatus.BAD_GATEWAY);
    }
    await this.infra.redis.set(openKey(telegramId), 'active', 'EX', CONVERSATION_TTL_SECONDS);
    return { acknowledge: state === 'new' || (via === 'support' && state === null) };
  }

  /** The customer an operator's message in the operators' chat answers, if any. */
  async route(input: {
    chatId: number;
    threadId?: number | undefined;
    replyToMessageId?: number | undefined;
  }): Promise<SupportTarget | null> {
    const configured = await this.settings.get('brand.support_forward_chat_id');
    if (typeof configured !== 'number' || configured !== input.chatId) return null;
    const chat = String(input.chatId);
    const telegramId =
      (input.threadId === undefined
        ? null
        : await this.infra.redis.get(`rr:support:thread:${chat}:${String(input.threadId)}`)) ??
      (input.replyToMessageId === undefined
        ? null
        : await this.infra.redis.get(`rr:support:msg:${chat}:${String(input.replyToMessageId)}`));
    if (!telegramId) return null;
    // An operator answered: the customer's reply goes back without pressing
    // «Поддержка» again.
    await this.infra.redis.set(openKey(telegramId), 'active', 'EX', CONVERSATION_TTL_SECONDS);
    const user = await this.infra.db.user.findUnique({
      where: { telegramId: BigInt(telegramId) },
      select: { language: true },
    });
    return { telegramId, language: user?.language ?? 'ru' };
  }

  /**
   * The operators' chat and the bot that writes there: the support bot when
   * one is configured (F35), otherwise the shop bot. A message from the other
   * bot is `SUPPORT_MOVED`: that bot cannot copy it, and the answers would
   * come from a bot the customer is not talking to.
   */
  private async destination(via: SupportVia): Promise<{ chatId: number; token: string }> {
    const [chatId, shopToken, supportToken, supportUsername] = await Promise.all([
      this.settings.get('brand.support_forward_chat_id'),
      this.settings.get('bot.token'),
      this.settings.get('bot.support_token'),
      this.settings.get('bot.support_username'),
    ]);
    const supportBot = typeof supportToken === 'string' && supportToken !== '';
    if (supportBot !== (via === 'support'))
      throw new ApiError('SUPPORT_MOVED', HttpStatus.CONFLICT, undefined, {
        username: supportBot ? String(supportUsername) : null,
      });
    const token = supportBot ? supportToken : shopToken;
    if (typeof chatId !== 'number' || typeof token !== 'string' || !token)
      throw new ApiError('SUPPORT_UNAVAILABLE', HttpStatus.CONFLICT);
    return { chatId, token };
  }

  private async isForum(chatId: number, token: string): Promise<boolean> {
    const key = `rr:support:forum:${String(chatId)}`;
    const cached = await this.infra.redis.get(key);
    if (cached !== null) return cached === '1';
    const chat = await this.call<{ is_forum?: boolean }>(token, 'getChat', { chat_id: chatId });
    const forum = chat.is_forum === true;
    await this.infra.redis.set(key, forum ? '1' : '0', 'EX', FORUM_TTL_SECONDS);
    return forum;
  }

  /**
   * Copies into the customer's topic, creating it on the first message (with
   * a card that names the customer) and again when an operator deleted it.
   * False when the bot may not manage topics: the message then goes to the
   * chat itself and the administrators are told which right is missing.
   */
  private async copyToTopic(
    chatId: number,
    token: string,
    telegramId: string,
    messageId: number,
    topic: { name: string; header: string },
  ): Promise<boolean> {
    const key = `rr:support:topic:${String(chatId)}:${telegramId}`;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let threadId = Number(await this.infra.redis.get(key)) || undefined;
      if (threadId === undefined) {
        try {
          const created = await this.call<{ message_thread_id: number }>(
            token,
            'createForumTopic',
            { chat_id: chatId, name: topic.name },
          );
          threadId = created.message_thread_id;
        } catch (error) {
          if (!(error instanceof TelegramCallError)) throw error;
          this.logger.warn(`support topic not created: ${error.description}`);
          await this.notify
            ?.alert({ type: 'support.topics', details: error.description.slice(0, 300) })
            .catch(() => undefined);
          return false;
        }
        await this.infra.redis.set(key, String(threadId));
        await this.infra.redis.set(
          `rr:support:thread:${String(chatId)}:${String(threadId)}`,
          telegramId,
        );
        await this.call(token, 'sendMessage', {
          chat_id: chatId,
          message_thread_id: threadId,
          text: topic.header,
        });
      }
      try {
        await this.call(token, 'copyMessage', {
          chat_id: chatId,
          message_thread_id: threadId,
          from_chat_id: Number(telegramId),
          message_id: messageId,
        });
        return true;
      } catch (error) {
        // An operator deleted the topic: start a new one once.
        if (error instanceof TelegramCallError && /thread not found/iu.test(error.description)) {
          await this.infra.redis.del(key);
          continue;
        }
        throw error;
      }
    }
    return false;
  }

  private async call<T = unknown>(
    token: string,
    method: string,
    body: Record<string, unknown>,
  ): Promise<T> {
    const base = process.env.RR_TELEGRAM_API_URL ?? 'https://api.telegram.org';
    const response = await fetch(`${base}/bot${encodeURIComponent(token)}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify(body),
    });
    const payload = (await response.json().catch(() => ({}))) as {
      ok?: boolean;
      result?: T;
      error_code?: number;
      description?: string;
    };
    if (!payload.ok || payload.result === undefined)
      throw new TelegramCallError(
        method,
        payload.error_code,
        payload.description ?? `HTTP ${String(response.status)}`,
      );
    return payload.result;
  }
}

function openKey(telegramId: string): string {
  return `rr:support:open:${telegramId}`;
}
