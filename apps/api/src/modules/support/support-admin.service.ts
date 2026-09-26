import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
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

/** The console's side of support (owner decision F36): templates, FAQ, tickets, statistics. */
@Injectable()
export class SupportAdminService {
  constructor(private readonly infra: Infrastructure) {}

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

function duplicateCode(error: unknown): unknown {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'P2002'
    ? new ApiError('CONFLICT', HttpStatus.CONFLICT, 'A template with this code exists.')
    : error;
}
