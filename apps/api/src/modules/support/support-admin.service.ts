import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@remnaray/db';
import { z } from 'zod';

import { Infrastructure } from '../../infra/infra.module';
import { Audited } from '../admin/audit.interceptor';
import { ApiError } from '../me/me.errors';

const localizedText = (max: number) =>
  z
    .object({ ru: z.string().max(max), en: z.string().max(max) })
    .refine((value) => value.ru.trim() !== '' || value.en.trim() !== '', {
      message: 'At least one language is required.',
    });

export const templateSchema = z.object({
  code: z.string().regex(/^[a-z0-9_-]{1,32}$/u),
  title: z.string().trim().min(1).max(64),
  body: localizedText(4000),
  sortOrder: z.number().int().min(0).max(10_000).default(100),
});

export const faqSchema = z.object({
  question: localizedText(128),
  answer: localizedText(4000),
  sortOrder: z.number().int().min(0).max(10_000).default(100),
  enabled: z.boolean().default(true),
});

export const ticketListSchema = z.object({
  status: z.enum(['open', 'in_progress', 'closed', 'live']).optional(),
  assignee: z
    .string()
    .regex(/^\d{1,20}$/u)
    .optional(),
  userId: z.uuid().optional(),
  q: z.string().trim().min(1).max(64).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  cursor: z.uuid().optional(),
});

export const periodSchema = z.object({
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
});

type Totals = {
  opened: bigint;
  closed: bigint;
  open_now: bigint;
  avg_first_response: number | null;
  median_first_response: number | null;
  avg_resolution: number | null;
  avg_rating: number | null;
  rated: bigint;
};
type AssigneeRow = {
  telegram_id: bigint;
  name: string | null;
  closed: bigint;
  open_now: bigint;
  avg_first_response: number | null;
  avg_rating: number | null;
  rated: bigint;
};

/** The console's side of support (owner decision F36): templates, FAQ, tickets, statistics. */
@Injectable()
export class SupportAdminService {
  constructor(private readonly infra: Infrastructure) {}

  /**
   * Support over a period (the last 30 days by default): tickets opened and
   * closed, open now, the time to the first answer (average and median) and
   * to the close, the ratings, and the same per operator who took tickets.
   * Times are in seconds.
   */
  async stats(query: unknown) {
    const input = periodSchema.parse(query ?? {});
    const to = input.to ? new Date(input.to) : new Date();
    const from = input.from ? new Date(input.from) : new Date(to.getTime() - 30 * 86_400_000);
    if (from >= to) throw new ApiError('VALIDATION_ERROR', HttpStatus.BAD_REQUEST);
    const created = Prisma.sql`created_at >= ${from} AND created_at < ${to}`;
    const closedIn = Prisma.sql`closed_at >= ${from} AND closed_at < ${to}`;
    const ratedIn = Prisma.sql`rated_at >= ${from} AND rated_at < ${to}`;
    const firstResponse = Prisma.sql`extract(epoch FROM first_response_at - created_at)`;
    const [totals] = await this.infra.db.$queryRaw<Totals[]>(Prisma.sql`
      SELECT
        count(*) FILTER (WHERE ${created}) AS opened,
        count(*) FILTER (WHERE ${closedIn}) AS closed,
        count(*) FILTER (WHERE status <> 'closed') AS open_now,
        avg(${firstResponse}) FILTER (WHERE ${created} AND first_response_at IS NOT NULL)::float8
          AS avg_first_response,
        (percentile_cont(0.5) WITHIN GROUP (ORDER BY ${firstResponse})
          FILTER (WHERE ${created} AND first_response_at IS NOT NULL))::float8
          AS median_first_response,
        avg(extract(epoch FROM closed_at - created_at)) FILTER (WHERE ${closedIn})::float8
          AS avg_resolution,
        avg(rating) FILTER (WHERE ${ratedIn})::float8 AS avg_rating,
        count(rating) FILTER (WHERE ${ratedIn}) AS rated
      FROM support_tickets`);
    const assignees = await this.infra.db.$queryRaw<AssigneeRow[]>(Prisma.sql`
      SELECT
        assignee_telegram_id AS telegram_id,
        (array_agg(assignee_name ORDER BY updated_at DESC))[1] AS name,
        count(*) FILTER (WHERE ${closedIn}) AS closed,
        count(*) FILTER (WHERE status <> 'closed') AS open_now,
        avg(${firstResponse}) FILTER (WHERE ${created} AND first_response_at IS NOT NULL)::float8
          AS avg_first_response,
        avg(rating) FILTER (WHERE ${ratedIn})::float8 AS avg_rating,
        count(rating) FILTER (WHERE ${ratedIn}) AS rated
      FROM support_tickets
      WHERE assignee_telegram_id IS NOT NULL
      GROUP BY assignee_telegram_id
      HAVING count(*) FILTER (WHERE ${created} OR ${closedIn} OR status <> 'closed') > 0
      ORDER BY closed DESC, telegram_id`);
    const seconds = (value: number | null) => (value === null ? null : Math.round(value));
    const average = (value: number | null) =>
      value === null ? null : Math.round(value * 100) / 100;
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      opened: Number(totals?.opened ?? 0n),
      closed: Number(totals?.closed ?? 0n),
      openNow: Number(totals?.open_now ?? 0n),
      firstResponseSeconds: {
        average: seconds(totals?.avg_first_response ?? null),
        median: seconds(totals?.median_first_response ?? null),
      },
      resolutionSeconds: seconds(totals?.avg_resolution ?? null),
      rating: { average: average(totals?.avg_rating ?? null), count: Number(totals?.rated ?? 0n) },
      operators: assignees.map((row) => ({
        telegramId: row.telegram_id.toString(),
        name: row.name,
        closed: Number(row.closed),
        openNow: Number(row.open_now),
        firstResponseSeconds: seconds(row.avg_first_response),
        rating: { average: average(row.avg_rating), count: Number(row.rated) },
      })),
    };
  }

  /**
   * The tickets, newest first: by status (`live` = not closed), by the
   * operator who took them, by customer (id, or `q`: Telegram id, #number or
   * @username).
   */
  async tickets(query: unknown) {
    const input = ticketListSchema.parse(query ?? {});
    const where = {
      AND: [
        input.status === 'live'
          ? { status: { not: 'closed' as const } }
          : input.status
            ? { status: input.status }
            : {},
        input.assignee ? { assigneeTelegramId: BigInt(input.assignee) } : {},
        input.userId ? { userId: input.userId } : {},
        await this.search(input.q),
      ],
    };
    const rows = await this.infra.db.supportTicket.findMany({
      where,
      orderBy: { id: 'desc' },
      take: input.limit + 1,
      ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    });
    const page = rows.slice(0, input.limit);
    const customers = await this.infra.db.user.findMany({
      where: { id: { in: [...new Set(page.map((row) => row.userId))] } },
      select: { id: true, telegramId: true, username: true, firstName: true },
    });
    const byId = new Map(customers.map((user) => [user.id, user]));
    return {
      items: page.map((row) => ({
        ...ticketView(row),
        user: userView(byId.get(row.userId), row.userId),
      })),
      nextCursor: rows.length > input.limit ? (page.at(-1)?.id ?? null) : null,
    };
  }

  /** `#128` is a ticket; digits are a Telegram id; anything else is a @username. */
  private async search(q: string | undefined) {
    if (!q) return {};
    if (/^#\d{1,18}$/u.test(q)) return { number: BigInt(q.slice(1)) };
    const users = await this.infra.db.user.findMany({
      where: /^\d{1,18}$/u.test(q)
        ? { telegramId: BigInt(q) }
        : { username: { equals: q.replace(/^@/u, ''), mode: 'insensitive' as const } },
      select: { id: true },
      take: 20,
    });
    return { userId: { in: users.map((user) => user.id) } };
  }

  /** One ticket with its history: messages, notes and the bot's lines, oldest first. */
  async ticket(id: string) {
    const row = await this.infra.db.supportTicket.findUnique({ where: { id: known(id) } });
    if (!row) throw new NotFoundException('NOT_FOUND');
    const [user, messages] = await Promise.all([
      this.infra.db.user.findUnique({
        where: { id: row.userId },
        select: { id: true, telegramId: true, username: true, firstName: true },
      }),
      this.infra.db.supportMessage.findMany({
        where: { ticketId: row.id, NOT: { kind: 'card' } },
        orderBy: { createdAt: 'asc' },
        take: 500,
      }),
    ]);
    return {
      ...ticketView(row),
      user: userView(user ?? undefined, row.userId),
      messages: messages.map((message) => ({
        id: message.id,
        direction: message.direction,
        kind: message.kind,
        text: message.text,
        hasFile: message.fileId !== null,
        authorName: message.authorName,
        createdAt: message.createdAt.toISOString(),
      })),
    };
  }

  async faq() {
    const rows = await this.infra.db.supportFaq.findMany({
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    return { items: rows.map(faqView) };
  }

  async createFaq(body: unknown) {
    const input = faqSchema.parse(body);
    const created = await this.infra.db.supportFaq.create({ data: input });
    return new Audited(null, faqView(created));
  }

  async updateFaq(id: string, body: unknown) {
    const input = faqSchema.parse(body);
    const before = await this.infra.db.supportFaq.findUnique({ where: { id: known(id) } });
    if (!before) throw new NotFoundException('NOT_FOUND');
    const updated = await this.infra.db.supportFaq.update({ where: { id }, data: input });
    return new Audited(faqView(before), faqView(updated));
  }

  async deleteFaq(id: string) {
    const before = await this.infra.db.supportFaq.findUnique({ where: { id: known(id) } });
    if (!before) throw new NotFoundException('NOT_FOUND');
    await this.infra.db.supportFaq.delete({ where: { id } });
    return new Audited(faqView(before), null, { deleted: true });
  }

  async templates() {
    const rows = await this.infra.db.supportTemplate.findMany({
      orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
    });
    return { items: rows.map(templateView) };
  }

  async createTemplate(body: unknown) {
    const input = templateSchema.parse(body);
    try {
      const created = await this.infra.db.supportTemplate.create({ data: input });
      return new Audited(null, templateView(created));
    } catch (error) {
      throw duplicateCode(error);
    }
  }

  async updateTemplate(id: string, body: unknown) {
    const input = templateSchema.parse(body);
    const before = await this.infra.db.supportTemplate.findUnique({ where: { id: known(id) } });
    if (!before) throw new NotFoundException('NOT_FOUND');
    try {
      const updated = await this.infra.db.supportTemplate.update({ where: { id }, data: input });
      return new Audited(templateView(before), templateView(updated));
    } catch (error) {
      throw duplicateCode(error);
    }
  }

  async deleteTemplate(id: string) {
    const before = await this.infra.db.supportTemplate.findUnique({ where: { id: known(id) } });
    if (!before) throw new NotFoundException('NOT_FOUND');
    await this.infra.db.supportTemplate.delete({ where: { id } });
    return new Audited(templateView(before), null, { deleted: true });
  }
}

function templateView(row: {
  id: string;
  code: string;
  title: string;
  body: unknown;
  sortOrder: number;
}) {
  return { id: row.id, code: row.code, title: row.title, body: row.body, sortOrder: row.sortOrder };
}

/** An id that is not a UUID names nothing. */
export function known(id: string): string {
  if (!z.uuid().safeParse(id).success) throw new NotFoundException('NOT_FOUND');
  return id;
}

function ticketView(row: {
  id: string;
  number: bigint;
  status: string;
  channel: string;
  openedBy: string;
  assigneeTelegramId: bigint | null;
  assigneeName: string | null;
  createdAt: Date;
  takenAt: Date | null;
  firstResponseAt: Date | null;
  closedAt: Date | null;
  closedBy: string | null;
  closedSilently: boolean;
  rating: number | null;
}) {
  const iso = (value: Date | null) => value?.toISOString() ?? null;
  return {
    id: row.id,
    number: Number(row.number),
    status: row.status,
    channel: row.channel,
    openedBy: row.openedBy,
    assignee: row.assigneeTelegramId
      ? { telegramId: row.assigneeTelegramId.toString(), name: row.assigneeName }
      : null,
    createdAt: row.createdAt.toISOString(),
    takenAt: iso(row.takenAt),
    firstResponseAt: iso(row.firstResponseAt),
    closedAt: iso(row.closedAt),
    closedBy: row.closedBy,
    closedSilently: row.closedSilently,
    rating: row.rating,
  };
}

function userView(
  user:
    | { id: string; telegramId: bigint; username: string | null; firstName: string | null }
    | undefined,
  id: string,
) {
  return {
    id,
    telegramId: user?.telegramId.toString() ?? null,
    username: user?.username ?? null,
    firstName: user?.firstName ?? null,
  };
}

function faqView(row: {
  id: string;
  question: unknown;
  answer: unknown;
  sortOrder: number;
  enabled: boolean;
}) {
  return {
    id: row.id,
    question: row.question,
    answer: row.answer,
    sortOrder: row.sortOrder,
    enabled: row.enabled,
  };
}

function duplicateCode(error: unknown): unknown {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'P2002'
    ? new ApiError('CONFLICT', HttpStatus.CONFLICT, 'A template with this code exists.')
    : error;
}
