import { HttpStatus, Injectable, Logger, Optional } from '@nestjs/common';
import { formatMessage, SUPPORTED_LOCALES, type Locale } from '@remnaray/i18n-core';

import { Infrastructure } from '../../infra/infra.module';
import { ApiError } from '../me/me.errors';
import { NotifyService } from '../notify/notify.service';
import { I18nService } from '../public/i18n.service';
import { SettingsService } from '../settings/settings.service';
import { loadCardData } from './card-data';
import { notModified, TelegramCallError, telegramCall } from './telegram';
import { cardKeyboard, cardText, formats, topicName, type Translate } from './ticket-card';
import { TicketsRepository, type Ticket } from './tickets.repository';

const FORUM_TTL_SECONDS = 600;
/**
 * How long the shop bot keeps a customer "writing to support" without a
 * message either way (F35): until then what they write goes to the operators.
 */
export const CONVERSATION_TTL_SECONDS = 24 * 60 * 60;

/** The bot a customer writes to support in: the shop's, or the support bot (F35). */
export type SupportVia = 'shop' | 'support';

/** A Telegram message handed over by the bot: what it is and what it says. */
export type SupportMessage = {
  kind: string;
  text?: string | undefined;
  fileId?: string | undefined;
  fileUniqueId?: string | undefined;
};

export type OperatorMessageInput = {
  chatId: number;
  messageId: number;
  threadId?: number | undefined;
  replyToMessageId?: number | undefined;
  from: { id: number; name: string };
  via: SupportVia;
  message: SupportMessage;
};

export type CallbackInput = {
  chatId: number;
  from: { id: number; name: string };
  data: string;
  via: SupportVia;
};

type Destination = { chatId: number; token: string };
type Customer = {
  id: string;
  telegramId: bigint;
  firstName: string | null;
  username: string | null;
  language: string;
};

/**
 * FR-124 with the owner's F35 and F36 decisions. A customer's messages go to
 * the operators' chat (`brand.support_forward_chat_id`) as numbered tickets:
 * in a forum supergroup every customer has a topic of their own, named with
 * the ticket's status; in a plain group a ticket's messages reply to its
 * card. The card shows the customer and carries the take, close and silent
 * close buttons; anything else an operator writes in the topic (or as a reply
 * in a plain group) is the answer. Messages are copied (`copyMessage`), so
 * photos, files and voice messages go through as they are, and every message
 * is kept in `support_messages`.
 */
@Injectable()
export class SupportService {
  private readonly logger = new Logger(SupportService.name);

  constructor(
    private readonly infra: Infrastructure,
    private readonly settings: SettingsService,
    private readonly tickets: TicketsRepository,
    private readonly i18n: I18nService,
    @Optional() private readonly notify?: NotifyService,
  ) {}

  /** «Написать оператору» in the shop bot: what the customer writes goes to the operators. */
  async open(telegramId: string): Promise<void> {
    await this.destination('shop');
    await this.infra.redis.set(openKey(telegramId), 'new', 'EX', CONVERSATION_TTL_SECONDS);
  }

  /** «Завершить» in the shop bot: the customer closes their ticket. */
  async close(telegramId: string): Promise<void> {
    await this.customerClose(telegramId, 'shop');
  }

  /**
   * Copies the customer's message `messageId` (in their chat with the bot)
   * into their ticket, opening one when they have none. With `requireOpen`
   * (the shop bot), a message sent outside «Написать оператору» is refused with
   * `SUPPORT_CLOSED`. `via` is the bot the customer wrote in: the copy is made
   * by that bot, so it must be the one support runs in.
   */
  async forward(
    telegramId: string,
    messageId: number,
    options: { requireOpen?: boolean; via?: SupportVia; message?: SupportMessage } = {},
  ): Promise<{ ticket: { id: string; number: number; created: boolean } }> {
    const via = options.via ?? 'shop';
    const state = await this.infra.redis.get(openKey(telegramId));
    if (options.requireOpen && state === null)
      throw new ApiError('SUPPORT_CLOSED', HttpStatus.CONFLICT);
    const destination = await this.destination(via);
    const customer = await this.customer(telegramId);
    if (!customer) throw new ApiError('SUPPORT_UNAVAILABLE', HttpStatus.CONFLICT);
    const opened = await this.tickets.openOrLive(customer.id, via, 'customer');
    let ticket = opened.ticket;
    let created = opened.created;
    try {
      if (ticket.cardMessageId === null) {
        ticket = await this.announce(ticket, customer, destination);
        created = true;
      }
      ticket = await this.copyToOperators(
        ticket,
        customer,
        destination,
        messageId,
        options.message,
      );
    } catch (error) {
      if (!(error instanceof TelegramCallError)) throw error;
      this.logger.warn(`support forward failed: ${String(error)}`);
      throw new ApiError('SUPPORT_UNAVAILABLE', HttpStatus.BAD_GATEWAY);
    }
    await this.tickets.update(ticket.id, { lastCustomerAt: new Date() });
    if (via === 'shop')
      await this.infra.redis.set(openKey(telegramId), 'active', 'EX', CONVERSATION_TTL_SECONDS);
    return { ticket: { id: ticket.id, number: Number(ticket.number), created } };
  }

  /**
   * A message in the operators' chat. In a customer's topic, or replying to
   * one of their ticket's messages, it is the answer — or `/close`,
   * `/silent`, `/card`. Anything else in that chat is none of support's
   * business. An answer to a customer without a live ticket opens one.
   */
  async operatorMessage(input: OperatorMessageInput): Promise<{ handled: boolean }> {
    const destination = await this.destination(input.via);
    if (input.chatId !== destination.chatId) return { handled: false };
    const userId = await this.customerOf(input);
    if (!userId) return { handled: false };
    const customer = await this.infra.db.user.findUnique({ where: { id: userId } });
    if (!customer) return { handled: false };
    const text = input.message.text?.trim();
    // An internal note: kept with the ticket, never sent to the customer.
    if (text?.startsWith('//')) {
      await this.note(customer, input, destination, text.slice(2).trim());
      return { handled: true };
    }
    const command = text ? parseCommand(text) : null;
    if (command) {
      await this.command(command, customer, input, destination);
      return { handled: true };
    }
    await this.answer(customer, input, destination);
    return { handled: true };
  }

  /** A press on a ticket card's button (`st:<action>:<ticket id>`). */
  async callback(input: CallbackInput): Promise<{ text: string; alert?: boolean }> {
    const t = await this.operatorTranslate();
    const match = /^st:(take|close|silent|card):([0-9a-f-]{36})$/u.exec(input.data);
    const destination = await this.destination(input.via);
    if (!match || input.chatId !== destination.chatId)
      return { text: t('bot.support.op.denied'), alert: true };
    const [, action, ticketId] = match as unknown as [string, string, string];
    const ticket = await this.tickets.byId(ticketId);
    if (!ticket) return { text: t('bot.support.op.notFound'), alert: true };
    if (action === 'card') {
      await this.refreshCard(ticket);
      return { text: t('bot.support.op.refreshed') };
    }
    if (action === 'take') {
      if (ticket.status === 'closed')
        return { text: t('bot.support.op.alreadyClosed', { number: Number(ticket.number) }) };
      const taken = await this.take(ticket, input.from, destination);
      return { text: t('bot.support.op.taken', { number: Number(taken.number) }) };
    }
    const closed = await this.closeByOperator(ticket, input.from, action === 'silent', destination);
    return closed
      ? { text: t('bot.support.op.closed', { number: Number(ticket.number) }) }
      : { text: t('bot.support.op.alreadyClosed', { number: Number(ticket.number) }) };
  }

  /** The customer closes their ticket («Завершить», «Закрыть обращение»). */
  async customerClose(telegramId: string, via: SupportVia): Promise<{ number: number } | null> {
    await this.infra.redis.del(openKey(telegramId));
    const customer = await this.customer(telegramId);
    if (!customer) return null;
    const live = await this.tickets.live(customer.id);
    if (!live) return null;
    const closed = await this.tickets.closeIfLive(live.id, 'customer', false);
    if (!closed) return null;
    await this.bestEffort(async () => {
      const destination = await this.destination(via);
      const t = await this.operatorTranslate();
      await this.postSystem(
        closed,
        destination,
        t('bot.support.op.customerClosed', { number: Number(closed.number) }),
      );
      await this.refreshCard(closed);
      await this.renameTopic(closed, customer, destination);
    });
    return { number: Number(closed.number) };
  }

  private async command(
    command: { name: string; args: string },
    customer: Customer,
    input: OperatorMessageInput,
    destination: Destination,
  ): Promise<void> {
    const t = await this.operatorTranslate();
    const ticket = await this.tickets.live(customer.id);
    if (command.name === 'close' || command.name === 'silent') {
      if (
        !ticket ||
        !(await this.closeByOperator(ticket, input.from, command.name === 'silent', destination))
      )
        await this.reply(input, destination, t('bot.support.op.noLiveTicket'));
      return;
    }
    if (command.name === 't') {
      await this.template(command.args, customer, input, destination);
      return;
    }
    if (command.name === 'card') {
      const latest =
        ticket ??
        (await this.infra.db.supportTicket.findFirst({
          where: { userId: customer.id },
          orderBy: { createdAt: 'desc' },
        }));
      if (!latest) return;
      await this.sendCard(latest, destination, input.threadId);
      return;
    }
    await this.reply(input, destination, t('bot.support.op.unknownCommand'));
  }

  /** `//text`: a note on the customer's ticket (the live one, or the last). */
  private async note(
    customer: Customer,
    input: OperatorMessageInput,
    destination: Destination,
    text: string,
  ): Promise<void> {
    const ticket =
      (await this.tickets.live(customer.id)) ??
      (await this.infra.db.supportTicket.findFirst({
        where: { userId: customer.id },
        orderBy: { createdAt: 'desc' },
      }));
    if (!ticket) {
      const t = await this.operatorTranslate();
      await this.reply(input, destination, t('bot.support.op.noTicket'));
      return;
    }
    await this.tickets.addMessage({
      ticketId: ticket.id,
      direction: 'note',
      kind: input.message.kind,
      text: text || null,
      fileId: input.message.fileId,
      fileUniqueId: input.message.fileUniqueId,
      authorTelegramId: input.from.id,
      authorName: input.from.name,
      operatorChatId: input.chatId,
      operatorMessageId: input.messageId,
    });
  }

  /** `/t` lists the templates; `/t <code>` answers with one in the customer's language. */
  private async template(
    code: string,
    customer: Customer,
    input: OperatorMessageInput,
    destination: Destination,
  ): Promise<void> {
    const t = await this.operatorTranslate();
    if (!code) {
      const templates = await this.infra.db.supportTemplate.findMany({
        orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
        select: { code: true, title: true },
      });
      await this.reply(
        input,
        destination,
        templates.length === 0
          ? t('bot.support.op.templatesNone')
          : [
              t('bot.support.op.templates'),
              ...templates.map((template) =>
                t('bot.support.op.templateLine', { code: template.code, title: template.title }),
              ),
            ].join('\n'),
      );
      return;
    }
    const template = await this.infra.db.supportTemplate.findUnique({
      where: { code: code.toLowerCase() },
    });
    const body = template
      ? pick(template.body, customer.language, await this.operatorLocale())
      : null;
    if (!body) {
      await this.reply(input, destination, t('bot.support.op.templateUnknown', { code }));
      return;
    }
    await this.answer(customer, input, destination, body);
  }

  /**
   * An operator's answer — their message, or a template's `text` — sent to
   * the customer, kept, and the ticket taken.
   */
  private async answer(
    customer: Customer,
    input: OperatorMessageInput,
    destination: Destination,
    text?: string,
  ): Promise<void> {
    const opened = await this.tickets.openOrLive(customer.id, input.via, 'operator');
    let ticket = opened.ticket;
    if (ticket.cardMessageId === null) ticket = await this.announce(ticket, customer, destination);
    try {
      await this.deliver(customer, input, destination, text);
    } catch (error) {
      if (!(error instanceof TelegramCallError)) throw error;
      const t = await this.operatorTranslate();
      await this.reply(
        input,
        destination,
        t('bot.screen.support.undelivered', { reason: error.description }),
      );
      return;
    }
    await this.tickets.addMessage({
      ticketId: ticket.id,
      direction: 'operator',
      kind: text === undefined ? input.message.kind : 'text',
      text: text ?? input.message.text,
      fileId: text === undefined ? input.message.fileId : null,
      fileUniqueId: text === undefined ? input.message.fileUniqueId : null,
      authorTelegramId: input.from.id,
      authorName: input.from.name,
      operatorChatId: input.chatId,
      operatorMessageId: input.messageId,
    });
    const now = new Date();
    const first = ticket.takenAt === null;
    ticket = await this.tickets.update(ticket.id, {
      lastOperatorAt: now,
      ...(ticket.firstResponseAt === null ? { firstResponseAt: now } : {}),
      // The first answer takes a ticket nobody took.
      ...(first
        ? {
            status: 'in_progress' as const,
            takenAt: now,
            assigneeTelegramId: BigInt(input.from.id),
            assigneeName: input.from.name,
          }
        : {}),
    });
    if (input.via === 'shop')
      await this.infra.redis.set(
        openKey(customer.telegramId.toString()),
        'active',
        'EX',
        CONVERSATION_TTL_SECONDS,
      );
    if (first)
      await this.bestEffort(async () => {
        await this.refreshCard(ticket);
        await this.renameTopic(ticket, customer, destination);
      });
  }

  /**
   * Sends an operator's message (or a `template`'s text) to the customer. The
   * support bot copies it as it is; the shop bot puts text under «Ответ
   * поддержки» with «Завершить».
   */
  private async deliver(
    customer: Customer,
    input: OperatorMessageInput,
    destination: Destination,
    template?: string,
  ): Promise<void> {
    const chatId = Number(customer.telegramId);
    if (input.via === 'support' && template !== undefined) {
      await telegramCall(destination.token, 'sendMessage', { chat_id: chatId, text: template });
      return;
    }
    if (input.via === 'support') {
      await telegramCall(destination.token, 'copyMessage', {
        chat_id: chatId,
        from_chat_id: input.chatId,
        message_id: input.messageId,
      });
      return;
    }
    const t = await this.customerTranslate(customer.language);
    const keyboard = {
      inline_keyboard: [[{ text: t('bot.btn.supportEnd'), callback_data: 'support:end' }]],
    };
    const text = template ?? input.message.text?.trim();
    if ((template !== undefined || input.message.kind === 'text') && text)
      await telegramCall(destination.token, 'sendMessage', {
        chat_id: chatId,
        text: t('bot.screen.support.reply', { text }),
        parse_mode: 'HTML',
        reply_markup: keyboard,
      });
    else
      await telegramCall(destination.token, 'copyMessage', {
        chat_id: chatId,
        from_chat_id: input.chatId,
        message_id: input.messageId,
        reply_markup: keyboard,
      });
  }

  private async take(
    ticket: Ticket,
    operator: { id: number; name: string },
    destination: Destination,
  ): Promise<Ticket> {
    const now = new Date();
    const taken = await this.tickets.update(ticket.id, {
      status: 'in_progress',
      takenAt: ticket.takenAt ?? now,
      assigneeTelegramId: BigInt(operator.id),
      assigneeName: operator.name,
    });
    const customer = await this.infra.db.user.findUnique({ where: { id: ticket.userId } });
    await this.bestEffort(async () => {
      if (customer)
        await this.tellCustomer(taken, customer, 'bot.support.ticket.taken', destination);
      await this.refreshCard(taken);
      if (customer) await this.renameTopic(taken, customer, destination);
    });
    return taken;
  }

  /** Closes a ticket for an operator; false when it was closed already. */
  private async closeByOperator(
    ticket: Ticket,
    operator: { id: number; name: string },
    silently: boolean,
    destination: Destination,
  ): Promise<boolean> {
    const closed = await this.tickets.closeIfLive(ticket.id, 'operator', silently);
    if (!closed) return false;
    const current =
      closed.assigneeName === null
        ? await this.tickets.update(closed.id, {
            assigneeTelegramId: BigInt(operator.id),
            assigneeName: operator.name,
          })
        : closed;
    // The customer may write again: that opens the next ticket.
    const customer = await this.infra.db.user.findUnique({ where: { id: ticket.userId } });
    await this.bestEffort(async () => {
      const t = await this.operatorTranslate();
      if (customer && !silently)
        await this.tellCustomer(current, customer, 'bot.support.ticket.closed', destination);
      await this.postSystem(
        current,
        destination,
        t(silently ? 'bot.support.op.closedSilentlyBy' : 'bot.support.op.closedBy', {
          number: Number(current.number),
          name: operator.name,
        }),
      );
      await this.refreshCard(current);
      if (customer) await this.renameTopic(current, customer, destination);
    });
    return true;
  }

  /**
   * Opens the ticket in the operators' chat: the customer's topic (created
   * when needed), `🎫 Тикет #N`, and the card with its buttons.
   */
  private async announce(
    ticket: Ticket,
    customer: Customer,
    destination: Destination,
  ): Promise<Ticket> {
    const threadId = (await this.isForum(destination))
      ? await this.ensureTopic(ticket, customer, destination)
      : undefined;
    const t = await this.operatorTranslate();
    const announcement = await this.post(
      destination,
      threadId,
      t('bot.support.op.opened', {
        number: Number(ticket.number),
        name: customer.firstName ?? customer.username ?? customer.telegramId.toString(),
        username: customer.username ? `@${customer.username}` : '',
      }),
    );
    await this.tickets.addMessage({
      ticketId: ticket.id,
      direction: 'system',
      kind: 'text',
      operatorChatId: destination.chatId,
      operatorMessageId: announcement.message_id,
    });
    const placed = await this.tickets.update(ticket.id, {
      chatId: BigInt(destination.chatId),
      threadId: threadId ?? null,
    });
    return this.sendCard(placed, destination, threadId);
  }

  /** Posts the card (again) and makes it the one the buttons and edits use. */
  private async sendCard(
    ticket: Ticket,
    destination: Destination,
    threadId: number | undefined,
  ): Promise<Ticket> {
    const { text, keyboard } = await this.card(ticket);
    const card = await this.post(destination, threadId, text, keyboard);
    await this.tickets.addMessage({
      ticketId: ticket.id,
      direction: 'system',
      kind: 'card',
      operatorChatId: destination.chatId,
      operatorMessageId: card.message_id,
    });
    return this.tickets.update(ticket.id, { cardMessageId: card.message_id });
  }

  /** Copies the customer's message into the ticket's topic, or under its card. */
  private async copyToOperators(
    ticket: Ticket,
    customer: Customer,
    destination: Destination,
    messageId: number,
    message: SupportMessage | undefined,
  ): Promise<Ticket> {
    let current = ticket;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const copy = await telegramCall<{ message_id: number }>(destination.token, 'copyMessage', {
          chat_id: destination.chatId,
          from_chat_id: Number(customer.telegramId),
          message_id: messageId,
          ...(current.threadId === null
            ? {
                reply_parameters: {
                  message_id: current.cardMessageId,
                  allow_sending_without_reply: true,
                },
              }
            : { message_thread_id: current.threadId }),
        });
        await this.tickets.addMessage({
          ticketId: current.id,
          direction: 'customer',
          kind: message?.kind ?? 'text',
          text: message?.text,
          fileId: message?.fileId,
          fileUniqueId: message?.fileUniqueId,
          authorTelegramId: Number(customer.telegramId),
          authorName: customer.firstName,
          customerMessageId: messageId,
          operatorChatId: destination.chatId,
          operatorMessageId: copy.message_id,
        });
        return current;
      } catch (error) {
        // An operator deleted the topic: the ticket moves to a new one, once.
        if (
          attempt === 0 &&
          current.threadId !== null &&
          error instanceof TelegramCallError &&
          /thread not found/iu.test(error.description)
        ) {
          await this.tickets.dropTopic(destination.chatId, customer.id);
          current = await this.announce(current, customer, destination);
          continue;
        }
        throw error;
      }
    }
    return current;
  }

  /**
   * The customer's topic: known, carried over from the F35 Valkey key, or
   * created. Undefined when the bot may not manage topics: the ticket then
   * lives in the general topic and the administrators are told.
   */
  private async ensureTopic(
    ticket: Ticket,
    customer: Customer,
    destination: Destination,
  ): Promise<number | undefined> {
    const known = await this.tickets.topic(destination.chatId, customer.id);
    if (known !== null) {
      await this.renameTopic({ ...ticket, threadId: known }, customer, destination);
      return known;
    }
    const legacyKey = `rr:support:topic:${String(destination.chatId)}:${customer.telegramId.toString()}`;
    const legacy = Number(await this.infra.redis.get(legacyKey)) || undefined;
    if (legacy !== undefined) {
      await this.tickets.setTopic(destination.chatId, customer.id, legacy);
      await this.infra.redis.del(legacyKey);
      await this.renameTopic({ ...ticket, threadId: legacy }, customer, destination);
      return legacy;
    }
    try {
      const created = await telegramCall<{ message_thread_id: number }>(
        destination.token,
        'createForumTopic',
        { chat_id: destination.chatId, name: topicName(ticket.status, userOf(customer)) },
      );
      await this.tickets.setTopic(destination.chatId, customer.id, created.message_thread_id);
      return created.message_thread_id;
    } catch (error) {
      if (!(error instanceof TelegramCallError)) throw error;
      this.logger.warn(`support topic not created: ${error.description}`);
      await this.notify
        ?.alert({ type: 'support.topics', details: error.description.slice(0, 300) })
        .catch(() => undefined);
      return undefined;
    }
  }

  /** The customer an operator's message is about: by topic, or by the message it replies to. */
  private async customerOf(input: OperatorMessageInput): Promise<string | null> {
    if (input.threadId !== undefined) {
      const byTopic = await this.tickets.userByTopic(input.chatId, input.threadId);
      if (byTopic) return byTopic;
      // A topic opened before tickets (F35) is still known in Valkey.
      const legacy = await this.infra.redis.get(
        `rr:support:thread:${String(input.chatId)}:${String(input.threadId)}`,
      );
      const user = legacy
        ? await this.infra.db.user.findUnique({ where: { telegramId: BigInt(legacy) } })
        : null;
      if (user) {
        await this.tickets.setTopic(input.chatId, user.id, input.threadId);
        return user.id;
      }
    }
    if (input.replyToMessageId === undefined) return null;
    const ticket = await this.tickets.byOperatorMessage(input.chatId, input.replyToMessageId);
    if (ticket) return ticket.userId;
    const legacy = await this.infra.redis.get(
      `rr:support:msg:${String(input.chatId)}:${String(input.replyToMessageId)}`,
    );
    if (!legacy) return null;
    const user = await this.infra.db.user.findUnique({ where: { telegramId: BigInt(legacy) } });
    return user?.id ?? null;
  }

  private async card(ticket: Ticket) {
    const locale = await this.operatorLocale();
    const t = await this.operatorTranslate();
    const domain = String(await this.settings.get('domain.main'));
    const timezone = String(await this.settings.get('locale.timezone'));
    const data = await loadCardData(this.infra.db, ticket, locale);
    return {
      text: cardText(data, t, formats(locale, timezone)),
      keyboard: cardKeyboard(ticket, t, `https://${domain}/admin/users/${ticket.userId}`),
    };
  }

  /** Brings the card up to date; a card that changed nothing is fine. */
  async refreshCard(ticket: Ticket): Promise<void> {
    if (ticket.cardMessageId === null || ticket.chatId === null) return;
    const destination = await this.destinationForChat(Number(ticket.chatId));
    if (!destination) return;
    const { text, keyboard } = await this.card(ticket);
    try {
      await telegramCall(destination.token, 'editMessageText', {
        chat_id: destination.chatId,
        message_id: ticket.cardMessageId,
        text,
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: keyboard,
      });
    } catch (error) {
      if (!notModified(error)) throw error;
    }
  }

  /** `🟢|🟡|⚪ <name> · <id>`: the topic shows the ticket's status. */
  private async renameTopic(
    ticket: Pick<Ticket, 'status' | 'threadId'>,
    customer: Customer,
    destination: Destination,
  ): Promise<void> {
    if (ticket.threadId === null) return;
    try {
      await telegramCall(destination.token, 'editForumTopic', {
        chat_id: destination.chatId,
        message_thread_id: ticket.threadId,
        name: topicName(ticket.status, userOf(customer)),
      });
    } catch (error) {
      if (!(error instanceof TelegramCallError)) throw error;
      // TOPIC_NOT_MODIFIED and missing rights change nothing for the ticket.
      this.logger.debug(`support topic not renamed: ${error.description}`);
    }
  }

  /** A line from the bot in the ticket's topic (or under its card), kept in the history. */
  private async postSystem(ticket: Ticket, destination: Destination, text: string): Promise<void> {
    const sent = await telegramCall<{ message_id: number }>(destination.token, 'sendMessage', {
      chat_id: destination.chatId,
      text,
      parse_mode: 'HTML',
      ...(ticket.threadId === null
        ? ticket.cardMessageId === null
          ? {}
          : {
              reply_parameters: {
                message_id: ticket.cardMessageId,
                allow_sending_without_reply: true,
              },
            }
        : { message_thread_id: ticket.threadId }),
    });
    await this.tickets.addMessage({
      ticketId: ticket.id,
      direction: 'system',
      kind: 'text',
      text,
      operatorChatId: destination.chatId,
      operatorMessageId: sent.message_id,
    });
  }

  /** Tells the customer about their ticket in their language, from the ticket's bot. */
  private async tellCustomer(
    ticket: Ticket,
    customer: Customer,
    key: string,
    destination: Destination,
  ): Promise<void> {
    const t = await this.customerTranslate(customer.language);
    await telegramCall(destination.token, 'sendMessage', {
      chat_id: Number(customer.telegramId),
      text: t(key, { number: Number(ticket.number) }),
      parse_mode: 'HTML',
    });
  }

  private async reply(
    input: OperatorMessageInput,
    destination: Destination,
    text: string,
  ): Promise<void> {
    await telegramCall(destination.token, 'sendMessage', {
      chat_id: input.chatId,
      text,
      parse_mode: 'HTML',
      reply_parameters: { message_id: input.messageId, allow_sending_without_reply: true },
      ...(input.threadId === undefined ? {} : { message_thread_id: input.threadId }),
    });
  }

  private post(
    destination: Destination,
    threadId: number | undefined,
    text: string,
    keyboard?: unknown,
  ): Promise<{ message_id: number }> {
    return telegramCall<{ message_id: number }>(destination.token, 'sendMessage', {
      chat_id: destination.chatId,
      text,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...(threadId === undefined ? {} : { message_thread_id: threadId }),
      ...(keyboard ? { reply_markup: keyboard } : {}),
    });
  }

  /** Telegram failures after the ticket's state changed are logged, not thrown. */
  private async bestEffort(work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (error) {
      if (!(error instanceof TelegramCallError) && !(error instanceof ApiError)) throw error;
      this.logger.warn(`support notice failed: ${String(error)}`);
    }
  }

  private customer(telegramId: string): Promise<Customer | null> {
    return this.infra.db.user.findUnique({ where: { telegramId: BigInt(telegramId) } });
  }

  private async operatorLocale(): Promise<Locale> {
    return (await this.settings.get('locale.default')) as Locale;
  }

  private async operatorTranslate(): Promise<Translate> {
    return this.translate(await this.operatorLocale());
  }

  private async customerTranslate(language: string): Promise<Translate> {
    const locale = (SUPPORTED_LOCALES as readonly string[]).includes(language)
      ? (language as Locale)
      : await this.operatorLocale();
    return this.translate(locale);
  }

  private async translate(locale: Locale): Promise<Translate> {
    const catalog = await this.i18n.messages(locale);
    const brand = String(await this.settings.get('brand.name'));
    return (key, values = {}) => formatMessage(locale, catalog, key, { brand, ...values });
  }

  /**
   * The operators' chat and the bot that writes there: the support bot when
   * one is configured (F35), otherwise the shop bot. A message from the other
   * bot is `SUPPORT_MOVED`: that bot cannot copy it, and the answers would
   * come from a bot the customer is not talking to.
   */
  private async destination(via: SupportVia): Promise<Destination> {
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

  /** The bot that runs support now, for a ticket in `chatId`; null when that chat is gone. */
  private async destinationForChat(chatId: number): Promise<Destination | null> {
    const supportToken = await this.settings.get('bot.support_token');
    const via: SupportVia = typeof supportToken === 'string' && supportToken ? 'support' : 'shop';
    const destination = await this.destination(via).catch(() => null);
    return destination && destination.chatId === chatId ? destination : null;
  }

  private async isForum(destination: Destination): Promise<boolean> {
    const key = `rr:support:forum:${String(destination.chatId)}`;
    const cached = await this.infra.redis.get(key);
    if (cached !== null) return cached === '1';
    const chat = await telegramCall<{ is_forum?: boolean }>(destination.token, 'getChat', {
      chat_id: destination.chatId,
    });
    const forum = chat.is_forum === true;
    await this.infra.redis.set(key, forum ? '1' : '0', 'EX', FORUM_TTL_SECONDS);
    return forum;
  }
}

/** A template's text in the customer's language, else the shop's, else any. */
function pick(body: unknown, language: string, fallback: string): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const texts = body as Record<string, unknown>;
  for (const key of [language, fallback, 'ru', 'en']) {
    const text = texts[key];
    if (typeof text === 'string' && text.trim()) return text;
  }
  return null;
}

function openKey(telegramId: string): string {
  return `rr:support:open:${telegramId}`;
}

function userOf(customer: Customer) {
  return {
    firstName: customer.firstName,
    username: customer.username,
    telegramId: customer.telegramId.toString(),
  };
}

/** `/close`, `/close@shop_bot`, `/t link`: a command and its arguments. */
export function parseCommand(text: string): { name: string; args: string } | null {
  const match = /^\/([a-z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/iu.exec(text);
  return match ? { name: (match[1] ?? '').toLowerCase(), args: (match[2] ?? '').trim() } : null;
}
