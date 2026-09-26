import { Injectable } from '@nestjs/common';
import type { SupportTicket } from '@remnaray/db/generated';

import { Infrastructure } from '../../infra/infra.module';

export type Ticket = SupportTicket;
export type TicketChannel = Ticket['channel'];
export type MessageInput = {
  ticketId: string;
  direction: 'customer' | 'operator' | 'note' | 'system';
  kind: string;
  text?: string | null | undefined;
  fileId?: string | null | undefined;
  fileUniqueId?: string | null | undefined;
  authorTelegramId?: number | null | undefined;
  authorName?: string | null | undefined;
  customerMessageId?: number | null | undefined;
  operatorChatId?: number | null | undefined;
  operatorMessageId?: number | null | undefined;
};

/**
 * Owner decision F36: support requests are numbered tickets. A customer has at
 * most one live ticket — the partial unique index `ux_support_tickets_live_p`
 * holds it even when two messages arrive together.
 */
@Injectable()
export class TicketsRepository {
  constructor(private readonly infra: Infrastructure) {}

  live(userId: string): Promise<Ticket | null> {
    return this.infra.db.supportTicket.findFirst({
      where: { userId, status: { not: 'closed' } },
    });
  }

  byId(id: string): Promise<Ticket | null> {
    return this.infra.db.supportTicket.findUnique({ where: { id } });
  }

  /** The customer's live ticket, or a new one; `created` tells which. */
  async openOrLive(
    userId: string,
    channel: TicketChannel,
    openedBy: 'customer' | 'operator',
  ): Promise<{ ticket: Ticket; created: boolean }> {
    const existing = await this.live(userId);
    if (existing) return { ticket: existing, created: false };
    try {
      const ticket = await this.infra.db.supportTicket.create({
        data: { userId, channel, openedBy },
      });
      return { ticket, created: true };
    } catch (error) {
      // Another message opened it a moment ago.
      if (!uniqueViolation(error)) throw error;
      const winner = await this.live(userId);
      if (!winner) throw error;
      return { ticket: winner, created: false };
    }
  }

  update(id: string, data: Parameters<Infrastructure['db']['supportTicket']['update']>[0]['data']) {
    return this.infra.db.supportTicket.update({ where: { id }, data });
  }

  /** Closes a live ticket; null when it was already closed (by someone else). */
  async closeIfLive(
    id: string,
    closedBy: 'operator' | 'customer' | 'auto',
    silently: boolean,
  ): Promise<Ticket | null> {
    const { count } = await this.infra.db.supportTicket.updateMany({
      where: { id, status: { not: 'closed' } },
      data: { status: 'closed', closedAt: new Date(), closedBy, closedSilently: silently },
    });
    return count === 0 ? null : this.byId(id);
  }

  async addMessage(input: MessageInput): Promise<void> {
    await this.infra.db.supportMessage.create({
      data: {
        ticketId: input.ticketId,
        direction: input.direction,
        kind: input.kind,
        text: input.text ?? null,
        fileId: input.fileId ?? null,
        fileUniqueId: input.fileUniqueId ?? null,
        authorTelegramId:
          input.authorTelegramId === null || input.authorTelegramId === undefined
            ? null
            : BigInt(input.authorTelegramId),
        authorName: input.authorName ?? null,
        customerMessageId: input.customerMessageId ?? null,
        operatorChatId:
          input.operatorChatId === null || input.operatorChatId === undefined
            ? null
            : BigInt(input.operatorChatId),
        operatorMessageId: input.operatorMessageId ?? null,
      },
    });
  }

  /** The ticket a message in the operators' chat (a copy, a card) belongs to. */
  async byOperatorMessage(chatId: number, messageId: number): Promise<Ticket | null> {
    const message = await this.infra.db.supportMessage.findFirst({
      where: { operatorChatId: BigInt(chatId), operatorMessageId: messageId },
      select: { ticketId: true },
    });
    return message ? this.byId(message.ticketId) : null;
  }

  async topic(chatId: number, userId: string): Promise<number | null> {
    const topic = await this.infra.db.supportTopic.findUnique({
      where: { chatId_userId: { chatId: BigInt(chatId), userId } },
    });
    return topic?.threadId ?? null;
  }

  async setTopic(chatId: number, userId: string, threadId: number): Promise<void> {
    await this.infra.db.supportTopic.upsert({
      where: { chatId_userId: { chatId: BigInt(chatId), userId } },
      create: { chatId: BigInt(chatId), userId, threadId },
      update: { threadId },
    });
  }

  async dropTopic(chatId: number, userId: string): Promise<void> {
    await this.infra.db.supportTopic.deleteMany({ where: { chatId: BigInt(chatId), userId } });
  }

  async userByTopic(chatId: number, threadId: number): Promise<string | null> {
    const topic = await this.infra.db.supportTopic.findUnique({
      where: { chatId_threadId: { chatId: BigInt(chatId), threadId } },
    });
    return topic?.userId ?? null;
  }
}

function uniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  return (
    code === 'P2002' ||
    (typeof message === 'string' && /ux_support_tickets_live_p|23505/u.test(message))
  );
}
