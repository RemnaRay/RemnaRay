import { HttpException, Injectable, NotFoundException } from '@nestjs/common';
import { can, type Permission } from '@remnaray/domain/rbac';
import { ZodError } from 'zod';

import { Infrastructure } from '../../infra/infra.module';
import { AdminUsersService, type ActingAdmin } from '../admin-api/admin-users.service';
import type { Audited } from '../admin/audit.interceptor';

export type SupportAction =
  | { kind: 'extend'; days: number; reason?: string | undefined }
  | { kind: 'reset' }
  | { kind: 'link' }
  | { kind: 'credit'; amountMinor: bigint; reason?: string | undefined };

export type ActionOutcome =
  | { ok: true; kind: 'extend'; expiresAt: Date }
  | { ok: true; kind: 'reset' }
  | { ok: true; kind: 'link'; url: string }
  | { ok: true; kind: 'credit'; amountMinor: bigint }
  | {
      ok: false;
      reason: 'not_admin' | 'forbidden' | 'no_subscription' | 'no_panel' | 'limit' | 'invalid';
    };

const PERMISSION: Record<SupportAction['kind'], Permission> = {
  extend: 'users.mutate',
  reset: 'users.mutate',
  link: 'users.read',
  credit: 'users.balance.credit',
};

/**
 * Owner decision F36: the ticket card's actions on the customer — extend the
 * subscription, reset the traffic, send the subscription link, credit the
 * balance. Only a console admin whose `admins.telegram_id` is the operator's
 * may run them, with the section 14.2 matrix and the operator's daily credit
 * limit; each goes through the console's own FR-141 code and writes the
 * `audit_log` row the console would.
 */
@Injectable()
export class SupportActions {
  constructor(
    private readonly infra: Infrastructure,
    private readonly users: AdminUsersService,
  ) {}

  /** The active console admin behind a Telegram account, if any. */
  async admin(telegramId: number): Promise<ActingAdmin | null> {
    const admin = await this.infra.db.admin.findFirst({
      where: { telegramId: BigInt(telegramId), isActive: true, deletedAt: null },
      select: { id: true, role: true },
    });
    return admin ? { id: admin.id, role: admin.role } : null;
  }

  async run(
    action: SupportAction,
    userId: string,
    operatorTelegramId: number,
    ticketNumber: number,
  ): Promise<ActionOutcome> {
    const admin = await this.admin(operatorTelegramId);
    if (!admin) return { ok: false, reason: 'not_admin' };
    if (!can(admin.role, PERMISSION[action.kind])) return { ok: false, reason: 'forbidden' };
    const reason = `support #${String(ticketNumber)}${'reason' in action && action.reason ? `: ${action.reason}` : ''}`;
    try {
      switch (action.kind) {
        case 'extend': {
          const result = await this.users.extend(userId, { days: action.days, reason }, admin);
          await this.audit(admin, 'users.extend', userId, result, reason);
          return {
            ok: true,
            kind: 'extend',
            expiresAt: new Date((result.after as { expiresAt: string }).expiresAt),
          };
        }
        case 'reset': {
          const result = await this.users.resetTraffic(userId);
          await this.audit(admin, 'users.reset-traffic', userId, result, reason);
          return { ok: true, kind: 'reset' };
        }
        case 'link': {
          const panel = await this.infra.db.panelUser.findUnique({ where: { userId } });
          if (!panel?.subscriptionUrl) return { ok: false, reason: 'no_panel' };
          return { ok: true, kind: 'link', url: panel.subscriptionUrl };
        }
        case 'credit': {
          const result = await this.users.adjustBalance(
            userId,
            { amountMinor: action.amountMinor.toString(), reason },
            admin,
          );
          await this.audit(admin, 'users.balance', userId, result, reason);
          return { ok: true, kind: 'credit', amountMinor: action.amountMinor };
        }
      }
    } catch (error) {
      if (error instanceof NotFoundException)
        return { ok: false, reason: action.kind === 'reset' ? 'no_panel' : 'no_subscription' };
      if (error instanceof ZodError) return { ok: false, reason: 'invalid' };
      // Section 14.2: the operator's daily credit limit, or a debit.
      if (error instanceof HttpException && error.getStatus() === 403)
        return { ok: false, reason: 'limit' };
      throw error;
    }
  }

  /** The row the console's audit interceptor writes for the same action (FR-144). */
  private async audit(
    admin: ActingAdmin,
    action: string,
    userId: string,
    result: Audited,
    reason: string,
  ): Promise<void> {
    await this.infra.db.auditLog.create({
      data: {
        actorAdminId: admin.id,
        actorType: 'admin',
        action,
        entity: 'user',
        entityId: userId,
        ...(result.before === null || result.before === undefined
          ? {}
          : { before: toJson(result.before) }),
        ...(result.after === null || result.after === undefined
          ? {}
          : { after: toJson(result.after) }),
        reason,
        userAgent: 'telegram:support',
      },
    });
  }
}

function toJson(value: unknown): object {
  return JSON.parse(JSON.stringify(value)) as object;
}
