import { HttpException, HttpStatus, Injectable, NotFoundException } from '@nestjs/common';

import { type AdminRole } from '@remnaray/domain/rbac';

import { Infrastructure } from '../../infra/infra.module';
import { endAdminSessions } from './admin-sessions';
import { Audited } from './audit.interceptor';
import { hashAdminPassword } from './admin.crypto';
import {
  adminCreateSchema,
  adminReasonSchema,
  adminResetPasswordSchema,
  adminUpdateSchema,
} from './admin.schemas';

export class LastAdminError extends HttpException {
  constructor() {
    super(
      { error: { code: 'LAST_ADMIN', message: 'The last active admin cannot be removed.' } },
      HttpStatus.CONFLICT,
    );
  }
}

type AdminRow = {
  id: string;
  email: string;
  role: AdminRole;
  telegramId: bigint | null;
  isActive: boolean;
  totpEnabled: boolean;
  lastLoginAt: Date | null;
  lockedUntil: Date | null;
  createdAt: Date;
};

function view(admin: AdminRow) {
  return {
    id: admin.id,
    email: admin.email,
    role: admin.role,
    telegramId: admin.telegramId?.toString() ?? null,
    isActive: admin.isActive,
    totpEnabled: admin.totpEnabled,
    lastLoginAt: admin.lastLoginAt?.toISOString() ?? null,
    lockedUntil: admin.lockedUntil?.toISOString() ?? null,
    createdAt: admin.createdAt.toISOString(),
  };
}

const SELECT = {
  id: true,
  email: true,
  role: true,
  telegramId: true,
  isActive: true,
  totpEnabled: true,
  lastLoginAt: true,
  lockedUntil: true,
  createdAt: true,
} as const;

function telegramId(value: string | number | null | undefined): bigint | null | undefined {
  if (value === undefined) return undefined;
  return value === null ? null : BigInt(value);
}

@Injectable()
export class AdminsService {
  constructor(private readonly infra: Infrastructure) {}

  async list() {
    const items = await this.infra.db.admin.findMany({
      where: { deletedAt: null },
      orderBy: [{ role: 'asc' }, { email: 'asc' }],
      select: SELECT,
    });
    return { items: items.map((item) => view(item)) };
  }

  async create(body: unknown) {
    const input = adminCreateSchema.parse(body);
    const existing = await this.infra.db.admin.findUnique({ where: { email: input.email } });
    if (existing) throw new HttpException({ error: { code: 'CONFLICT' } }, HttpStatus.CONFLICT);
    const created = await this.infra.db.admin.create({
      data: {
        email: input.email,
        role: input.role,
        passwordHash: await hashAdminPassword(input.password),
        ...(input.telegramId === undefined
          ? {}
          : { telegramId: telegramId(input.telegramId) as bigint | null }),
      },
      select: SELECT,
    });
    return new Audited(null, view(created));
  }

  async update(id: string, body: unknown) {
    const input = adminUpdateSchema.parse(body);
    const data = {
      ...(input.role === undefined ? {} : { role: input.role }),
      ...(input.telegramId === undefined
        ? {}
        : { telegramId: telegramId(input.telegramId) as bigint | null }),
      ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
    };
    const losesAdmin =
      (input.role !== undefined && input.role !== 'admin') || input.isActive === false;
    return this.mutate(id, data, losesAdmin);
  }

  async deactivate(id: string, body: unknown) {
    adminReasonSchema.parse(body);
    const result = await this.mutate(id, { isActive: false }, true);
    await endAdminSessions(this.infra.redis, id);
    return result;
  }

  async resetPassword(id: string, body: unknown) {
    const input = adminResetPasswordSchema.parse(body);
    const before = await this.require(id);
    await this.infra.db.admin.update({
      where: { id },
      data: {
        passwordHash: await hashAdminPassword(input.password),
        failedLogins: 0,
        lockedUntil: null,
      },
    });
    await endAdminSessions(this.infra.redis, id);
    return new Audited(
      { id: before.id, passwordChangedAt: null },
      { id: before.id, passwordChangedAt: new Date().toISOString() },
      { id: before.id, passwordReset: true },
    );
  }

  /** Clears TOTP enrolment so the next login runs the first-login setup again. */
  async resetTotp(id: string) {
    const priorState = view(await this.require(id));
    const after = await this.infra.db.admin.update({
      where: { id },
      data: { totpEnabled: false, totpSecretEnc: null },
      select: SELECT,
    });
    await endAdminSessions(this.infra.redis, id);
    return new Audited(priorState, view(after));
  }

  /**
   * FR-143: the last active `admin` can never lose the role or be deactivated.
   * The check locks the remaining admin rows so two concurrent requests cannot
   * both observe a survivor.
   */
  private async mutate(
    id: string,
    data: Record<string, unknown>,
    losesAdmin: boolean,
  ): Promise<Audited> {
    return this.infra.db.$transaction(async (tx) => {
      const before = await tx.admin.findFirst({ where: { id, deletedAt: null }, select: SELECT });
      if (!before) throw new NotFoundException('NOT_FOUND');
      if (losesAdmin && before.role === 'admin' && before.isActive) {
        const survivors = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM admins
          WHERE role = 'admin' AND is_active = true AND deleted_at IS NULL AND id <> ${id}::uuid
          FOR UPDATE`;
        if (survivors.length === 0) throw new LastAdminError();
      }
      const priorState = view(before);
      const after = await tx.admin.update({ where: { id }, data, select: SELECT });
      return new Audited(priorState, view(after));
    });
  }

  private async require(id: string) {
    const admin = await this.infra.db.admin.findFirst({
      where: { id, deletedAt: null },
      select: SELECT,
    });
    if (!admin) throw new NotFoundException('NOT_FOUND');
    return admin;
  }
}
