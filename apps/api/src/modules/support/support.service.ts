import { HttpStatus, Injectable, Logger, Optional } from '@nestjs/common';
import { Prisma } from '@remnaray/db';
import { formatMessage, SUPPORTED_LOCALES, type Locale } from '@remnaray/i18n-core';

import { Infrastructure } from '../../infra/infra.module';
import { ApiError } from '../me/me.errors';
import { NotifyService } from '../notify/notify.service';
import { I18nService } from '../public/i18n.service';
import { SettingsService } from '../settings/settings.service';
import { loadCardData } from './card-data';
import { SupportActions, type ActionOutcome, type SupportAction } from './support-actions';
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
    private readonly actions: SupportActions,
    @Optional() private readonly notify?: NotifyService,
  ) {}

  /** The self-help questions (F36), enabled and in order, in `locale`. */
  async faq(locale: string): Promise<{ items: Array<{ id: string; question: string }> }> {
    const fallback = await this.operatorLocale();
    const rows = await this.infra.db.supportFaq.findMany({
      where: { enabled: true },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    return {
      items: rows.flatMap((row) => {
        const question = pick(row.question, locale, fallback);
        return question ? [{ id: row.id, question }] : [];
      }),
    };
  }

  /** One self-help answer in `locale`; null when it is gone or turned off. */
  async faqAnswer(
    id: string,
    locale: string,
  ): Promise<{ question: string; answer: string } | null> {
    if (!/^[0-9a-f-]{36}$/u.test(id)) return null;
    const row = await this.infra.db.supportFaq.findFirst({ where: { id, enabled: true } });
    if (!row) return null;
    const fallback = await this.operatorLocale();
    const question = pick(row.question, locale, fallback);
    const answer = pick(row.answer, locale, fallback);
    return question && answer ? { question, answer } : null;
  }

  /** «Моя ссылка подписки» in the support bot: the customer's own link, if any. */
  async subscriptionLink(telegramId: string): Promise<{ url: string | null }> {
    const customer = await this.customer(telegramId);
    if (!customer) return { url: null };
    const panel = await this.infra.db.panelUser.findUnique({ where: { userId: customer.id } });
    return { url: panel?.subscriptionUrl ?? null };
  }

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
    const match = /^st:(take|close|silent|card|ext7|ext30|reset|link):([0-9a-f-]{36})$/u.exec(
      input.data,
    );
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
    const cardAction = CARD_ACTIONS[action];
    if (cardAction) {
      // A double tap, or two operators pressing the same button, is one
      // action: a card action runs once a minute per ticket.
      const fresh = await this.infra.redis.set(
        `rr:support:act:${ticket.id}:${action}`,
        '1',
        'EX',
        60,
        'NX',
      );
      if (fresh !== 'OK') return { text: t('bot.support.act.duplicate') };
      return this.act(ticket, cardAction, input.from, destination);
    }
    if (action === 'take') {
      if (ticket.status === 'closed')
        return { text: t('bot.support.op.alreadyClosed', { number: Number(ticket.number) }) };
      const taken = await this.take(ticket, input.from, destination);
      // Closed between the read and the take.
      if (!taken)
        return { text: t('bot.support.op.alreadyClosed', { number: Number(ticket.number) }) };
      return { text: t('bot.support.op.taken', { number: Number(taken.number) }) };
    }
    const closed = await this.closeByOperator(ticket, input.from, action === 'silent', destination);
    return closed
      ? { text: t('bot.support.op.closed', { number: Number(ticket.number) }) }
      : { text: t('bot.support.op.alreadyClosed', { number: Number(ticket.number) }) };
  }

  /** The customer closes their ticket («Завершить», «Закрыть обращение»). */
  async customerClose(
    telegramId: string,
    via: SupportVia,
  ): Promise<{ id: string; number: number } | null> {
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
    return { id: closed.id, number: Number(closed.number) };
  }

  /**
   * The customer rates their closed ticket (1–5), once. The operators see the
   * rating in the topic and on the card.
   */
  async rate(
    telegramId: string,
    ticketId: string,
    rating: number,
  ): Promise<{ accepted: boolean; number: number | null }> {
    const customer = await this.customer(telegramId);
    if (!customer) return { accepted: false, number: null };
    const { count } = await this.infra.db.supportTicket.updateMany({
      where: { id: ticketId, userId: customer.id, status: 'closed', rating: null },
      data: { rating, ratedAt: new Date() },
    });
    const ticket = await this.tickets.byId(ticketId);
    if (count === 0 || !ticket || ticket.userId !== customer.id)
      return {
        accepted: false,
        number: ticket?.userId === customer.id ? Number(ticket.number) : null,
      };
    await this.bestEffort(async () => {
      if (ticket.chatId === null) return;
      const destination = await this.destinationForChat(Number(ticket.chatId));
      if (!destination) return;
      const t = await this.operatorTranslate();
      await this.postSystem(
        ticket,
        destination,
        t('bot.support.op.rated', {
          number: Number(ticket.number),
          rating,
          stars: '★'.repeat(rating) + '☆'.repeat(5 - rating),
        }),
      );
      await this.refreshCard(ticket);
    });
    return { accepted: true, number: Number(ticket.number) };
  }

  /**
   * The worker's minute sweep (F36). A ticket nobody took for
   * `support.remind_after_minutes` is announced once in the operators' chat;
   * a ticket whose last word was the operators' and that the customer left
   * for `support.autoclose_hours` is closed, and the customer is asked to rate
   * it. Either setting at 0 turns its part off.
   */
  async sweep(now = new Date()): Promise<{ reminded: number; closed: number }> {
    const destination = await this.activeDestination();
    if (!destination) return { reminded: 0, closed: 0 };
    const remindAfter = Number(await this.settings.get('support.remind_after_minutes'));
    const autocloseHours = Number(await this.settings.get('support.autoclose_hours'));
    let reminded = 0;
    let closed = 0;
    if (remindAfter > 0) {
      const waiting = await this.infra.db.supportTicket.findMany({
        where: {
          status: 'open',
          takenAt: null,
          remindedAt: null,
          chatId: BigInt(destination.chatId),
          createdAt: { lt: new Date(now.getTime() - remindAfter * 60_000) },
        },
        orderBy: { createdAt: 'asc' },
        take: 20,
      });
      for (const ticket of waiting) if (await this.remind(ticket, destination, now)) reminded += 1;
    }
    if (autocloseHours > 0) {
      const idle = await this.infra.db.$queryRaw<{ id: string }[]>(Prisma.sql`
        SELECT id FROM support_tickets
        WHERE status <> 'closed' AND last_operator_at IS NOT NULL
          AND (last_customer_at IS NULL OR last_customer_at < last_operator_at)
          AND last_operator_at < ${new Date(now.getTime() - autocloseHours * 3_600_000)}
        ORDER BY last_operator_at LIMIT 50`);
      for (const { id } of idle) if (await this.autoClose(id, destination)) closed += 1;
    }
    return { reminded, closed };
  }

  /** Once per ticket: `⏰ Тикет #N ждёт…` in the operators' chat, with a link to it. */
  private async remind(ticket: Ticket, destination: Destination, now: Date): Promise<boolean> {
    const { count } = await this.infra.db.supportTicket.updateMany({
      where: { id: ticket.id, remindedAt: null, takenAt: null },
      data: { remindedAt: now },
    });
    if (count === 0) return false;
    const customer = await this.infra.db.user.findUnique({ where: { id: ticket.userId } });
    const t = await this.operatorTranslate();
    await this.bestEffort(async () => {
      await telegramCall(destination.token, 'sendMessage', {
        chat_id: destination.chatId,
        text: t('bot.support.op.reminder', {
          number: Number(ticket.number),
          minutes: Math.max(1, Math.round((now.getTime() - ticket.createdAt.getTime()) / 60_000)),
          name: customer?.firstName ?? customer?.username ?? customer?.telegramId.toString() ?? '',
        }),
        parse_mode: 'HTML',
        ...(messageLink(destination.chatId, ticket)
          ? {
              reply_markup: {
                inline_keyboard: [
                  [
                    {
                      text: t('bot.support.btn.open'),
                      url: messageLink(destination.chatId, ticket),
                    },
                  ],
                ],
              },
            }
          : {}),
      });
    });
    return true;
  }

  private async autoClose(id: string, destination: Destination): Promise<boolean> {
    const closed = await this.tickets.closeIfLive(id, 'auto', false);
    if (!closed) return false;
    const customer = await this.infra.db.user.findUnique({ where: { id: closed.userId } });
    await this.bestEffort(async () => {
      const t = await this.operatorTranslate();
      if (customer)
        await this.tellCustomer(closed, customer, 'bot.support.ticket.autoClosed', destination, {
          rating: true,
        });
      await this.postSystem(
        closed,
        destination,
        t('bot.support.op.autoClosed', { number: Number(closed.number) }),
      );
      await this.refreshCard(closed);
      if (customer) await this.renameTopic(closed, customer, destination);
    });
    return true;
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
    if (command.name === 'extend' || command.name === 'credit') {
      const action = parseAction(command.name, command.args);
      if (!action) {
        await this.reply(input, destination, t(`bot.support.act.usage.${command.name}`));
        return;
      }
      const target =
        ticket ??
        (await this.infra.db.supportTicket.findFirst({
          where: { userId: customer.id },
          orderBy: { createdAt: 'desc' },
        }));
      if (!target) {
        await this.reply(input, destination, t('bot.support.op.noTicket'));
        return;
      }
      // Telegram may deliver an update twice; the command message runs once.
      const fresh = await this.infra.redis.set(
        `rr:support:cmd:${String(input.chatId)}:${String(input.messageId)}`,
        '1',
        'EX',
        7 * 24 * 3600,
        'NX',
      );
      if (fresh !== 'OK') return;
      const result = await this.act(target, action, input.from, destination);
      if (result.alert) await this.reply(input, destination, result.text);
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

  /**
   * Runs a card action through `SupportActions` (console admins only) and
   * leaves a line about it in the ticket; the link goes to the customer.
   */
  private async act(
    ticket: Ticket,
    action: SupportAction,
    operator: { id: number; name: string },
    destination: Destination,
  ): Promise<{ text: string; alert?: boolean }> {
    const t = await this.operatorTranslate();
    const outcome = await this.actions.run(
      action,
      ticket.userId,
      operator.id,
      Number(ticket.number),
    );
    if (!outcome.ok) return { text: t(`bot.support.act.${outcome.reason}`), alert: true };
    const customer = await this.infra.db.user.findUnique({ where: { id: ticket.userId } });
    if (outcome.kind === 'link' && customer) {
      const customerT = await this.customerTranslate(customer.language);
      try {
        await telegramCall(destination.token, 'sendMessage', {
          chat_id: Number(customer.telegramId),
          text: customerT('bot.support.ticket.link', { url: outcome.url }),
          parse_mode: 'HTML',
        });
      } catch (error) {
        // The customer blocked the bot: the operator is told why.
        if (!(error instanceof TelegramCallError)) throw error;
        return {
          text: t('bot.screen.support.undelivered', { reason: error.description }),
          alert: true,
        };
      }
    }
    const line = await this.actionLine(outcome, operator.name);
    await this.bestEffort(async () => {
      await this.postSystem(ticket, destination, line);
      await this.refreshCard(ticket);
    });
    return { text: line };
  }

  private async actionLine(outcome: ActionOutcome & { ok: true }, name: string): Promise<string> {
    const t = await this.operatorTranslate();
    const f = formats(
      await this.operatorLocale(),
      String(await this.settings.get('locale.timezone')),
    );
    switch (outcome.kind) {
      case 'extend':
        return t('bot.support.act.done.extend', { name, until: f.date(outcome.expiresAt) });
      case 'credit':
        return t('bot.support.act.done.credit', { name, amount: f.money(outcome.amountMinor) });
      case 'reset':
        return t('bot.support.act.done.reset', { name });
      case 'link':
        return t('bot.support.act.done.link', { name });
    }
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
    ticket = await this.tickets.update(ticket.id, {
      lastOperatorAt: now,
      ...(ticket.firstResponseAt === null ? { firstResponseAt: now } : {}),
    });
    // The first answer takes a ticket nobody took — unless it was closed meanwhile.
    const taken =
      ticket.takenAt === null
        ? await this.tickets.updateIfLive(ticket.id, {
            status: 'in_progress',
            takenAt: now,
            assigneeTelegramId: BigInt(input.from.id),
            assigneeName: input.from.name,
          })
        : null;
    const first = taken !== null;
    if (taken) ticket = taken;
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
  ): Promise<Ticket | null> {
    const now = new Date();
    const taken = await this.tickets.updateIfLive(ticket.id, {
      status: 'in_progress',
      takenAt: ticket.takenAt ?? now,
      assigneeTelegramId: BigInt(operator.id),
      assigneeName: operator.name,
    });
    if (!taken) return null;
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
        await this.tellCustomer(current, customer, 'bot.support.ticket.closed', destination, {
          rating: true,
        });
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
    options: { rating?: boolean } = {},
  ): Promise<void> {
    const t = await this.customerTranslate(customer.language);
    await telegramCall(destination.token, 'sendMessage', {
      chat_id: Number(customer.telegramId),
      text: options.rating
        ? `${t(key, { number: Number(ticket.number) })}\n\n${t('bot.support.rate.ask')}`
        : t(key, { number: Number(ticket.number) }),
      parse_mode: 'HTML',
      ...(options.rating ? { reply_markup: ratingKeyboard(ticket.id) } : {}),
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
    const destination = await this.activeDestination();
    return destination && destination.chatId === chatId ? destination : null;
  }

  /** The operators' chat and the bot support runs in now; null when support is off. */
  private async activeDestination(): Promise<Destination | null> {
    const supportToken = await this.settings.get('bot.support_token');
    const via: SupportVia = typeof supportToken === 'string' && supportToken ? 'support' : 'shop';
    return this.destination(via).catch(() => null);
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

/** The card's action buttons. */
const CARD_ACTIONS: Partial<Record<string, SupportAction>> = {
  ext7: { kind: 'extend', days: 7 },
  ext30: { kind: 'extend', days: 30 },
  reset: { kind: 'reset' },
  link: { kind: 'link' },
};

/**
 * `/extend <days> [reason]` and `/credit <amount ₽> [reason]` (whole roubles
 * or kopecks after a point or comma); null when the arguments do not parse.
 */
export function parseAction(name: 'extend' | 'credit', args: string): SupportAction | null {
  const [first = '', ...rest] = args.split(/\s+/u);
  // `1 000` is not a thousand and a reason: a number split by spaces is refused.
  if (/^\d/u.test(rest[0] ?? '')) return null;
  const reason = rest.join(' ').trim() || undefined;
  if (name === 'extend') {
    if (!/^\d{1,4}$/u.test(first)) return null;
    const days = Number(first);
    return days >= 1 && days <= 3650 ? { kind: 'extend', days, reason } : null;
  }
  const match = /^(\d{1,9})(?:[.,](\d{1,2}))?$/u.exec(first);
  if (!match) return null;
  const amountMinor = BigInt(match[1] ?? '0') * 100n + BigInt((match[2] ?? '').padEnd(2, '0'));
  return amountMinor > 0n ? { kind: 'credit', amountMinor, reason } : null;
}

/**
 * `https://t.me/c/<chat>/<message>`: a link to the ticket in a supergroup
 * (its topic, or its card in a plain group), for the members who can see it.
 */
function messageLink(chatId: number, ticket: Pick<Ticket, 'threadId' | 'cardMessageId'>) {
  const internal = String(chatId).replace(/^-100/u, '');
  const target = ticket.threadId ?? ticket.cardMessageId;
  return String(chatId).startsWith('-100') && target !== null
    ? `https://t.me/c/${internal}/${String(target)}`
    : '';
}

/** ★1…★5 under a closed ticket's notice: `rate:<ticket id>:<n>`. */
export function ratingKeyboard(ticketId: string) {
  return {
    inline_keyboard: [
      [1, 2, 3, 4, 5].map((rating) => ({
        text: `${String(rating)}★`,
        callback_data: `rate:${ticketId}:${String(rating)}`,
      })),
    ],
  };
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
