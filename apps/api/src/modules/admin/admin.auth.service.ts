import { HttpException, Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import * as QRCode from 'qrcode';

import { adminMe, type AdminRole } from '@remnaray/domain/rbac';

import { Infrastructure } from '../../infra/infra.module';
import {
  decryptTotpSecret,
  createTotp,
  encryptTotpSecret,
  totpFromBase32,
  verifyAdminPassword,
} from './admin.crypto';
import { adminChallengeSchema, adminLoginSchema, adminTotpSchema } from './admin.schemas';
import { adminSessionKey, dropAdminSession, storeAdminSession } from './admin-sessions';

const CHALLENGE_TTL = 5 * 60;

type Challenge = { adminId: string; pendingSecretEnc?: string };
type AdminSession = { adminId: string; role: AdminRole; totpVerified: true; csrf: string };

export class AdminAuthFailure extends HttpException {
  constructor(
    readonly code:
      'ADMIN_INVALID_CREDENTIALS' | 'ADMIN_LOCKED' | 'ADMIN_TOTP_REQUIRED' | 'ADMIN_TOTP_INVALID',
    httpStatus: 401 | 423 = code === 'ADMIN_LOCKED' ? 423 : 401,
  ) {
    super({ error: { code, message: code } }, httpStatus);
  }
}

@Injectable()
export class AdminAuthService {
  private readonly appKey = process.env.RR_APP_KEY ?? '';

  constructor(private readonly infra: Infrastructure) {}

  async login(value: unknown) {
    const input = adminLoginSchema.parse(value);
    const admin = await this.infra.db.admin.findUnique({ where: { email: input.email } });
    if (!admin || !admin.isActive || admin.deletedAt) {
      await this.auditFailure(undefined, input.email);
      throw new AdminAuthFailure('ADMIN_INVALID_CREDENTIALS');
    }
    if (admin.lockedUntil && admin.lockedUntil > new Date()) {
      throw new AdminAuthFailure('ADMIN_LOCKED');
    }

    const valid = await verifyAdminPassword(admin.passwordHash, input.password);
    if (!valid) {
      const locked = await this.recordFailure(admin);
      throw new AdminAuthFailure(locked ? 'ADMIN_LOCKED' : 'ADMIN_INVALID_CREDENTIALS');
    }

    // R27: the count of failures is cleared by a completed sign-in only —
    // the password alone is what the second factor must not trust.
    const challengeId = randomBytes(32).toString('base64url');
    await this.infra.redis.set(
      this.challengeKey(challengeId),
      JSON.stringify({ adminId: admin.id }),
      'EX',
      CHALLENGE_TTL,
    );
    await this.audit(admin.id, 'auth.login.password', 'admin', admin.id, {
      email: this.maskEmail(admin.email),
    });
    return { requiresTotp: true, challengeId };
  }

  async setup(value: unknown) {
    const { challengeId } = adminChallengeSchema.parse(value);
    const challenge = await this.challenge(challengeId);
    const admin = await this.infra.db.admin.findUnique({ where: { id: challenge.adminId } });
    if (!admin || admin.totpEnabled) throw new AdminAuthFailure('ADMIN_TOTP_REQUIRED');
    const totp = challenge.pendingSecretEnc
      ? totpFromBase32(decryptTotpSecret(challenge.pendingSecretEnc, this.appKey), admin.email)
      : createTotp(admin.email);
    await this.infra.redis.set(
      this.challengeKey(challengeId),
      JSON.stringify({
        adminId: admin.id,
        pendingSecretEnc: encryptTotpSecret(totp.secret.base32, this.appKey),
      }),
      'EX',
      CHALLENGE_TTL,
    );
    const otpauthUrl = totp.toString();
    const qrDataUrl = await QRCode.toDataURL(otpauthUrl, { width: 256, margin: 2 });
    const comma = qrDataUrl.indexOf(',');
    return { otpauthUrl, qrPng: comma < 0 ? qrDataUrl : qrDataUrl.slice(comma + 1) };
  }

  async totp(value: unknown) {
    const input = adminTotpSchema.parse(value);
    const challenge = await this.challenge(input.challengeId);
    const admin = await this.infra.db.admin.findUnique({ where: { id: challenge.adminId } });
    await this.refuseLockedOrGone(admin, input.challengeId);
    if (!admin?.totpEnabled || !admin.totpSecretEnc)
      throw new AdminAuthFailure('ADMIN_TOTP_REQUIRED');
    const secret = decryptTotpSecret(admin.totpSecretEnc, this.appKey);
    const totp = totpFromBase32(secret, admin.email);
    const delta = totp.validate({ token: input.code, window: 1 });
    const counter = totp.counter() + (delta ?? 0);
    const accepted =
      delta !== null &&
      (await this.infra.redis.set(
        `rr:admin:totp:${admin.id}:${String(counter)}`,
        '1',
        'EX',
        90,
        'NX',
      )) === 'OK';
    if (!accepted) await this.codeFailure(admin, input.challengeId, 'totp');
    return this.complete(admin.id, admin.role, input.challengeId);
  }

  async confirm(value: unknown) {
    const input = adminTotpSchema.parse(value);
    const challenge = await this.challenge(input.challengeId);
    if (!challenge.pendingSecretEnc) throw new AdminAuthFailure('ADMIN_TOTP_REQUIRED');
    const admin = await this.infra.db.admin.findUnique({ where: { id: challenge.adminId } });
    await this.refuseLockedOrGone(admin, input.challengeId);
    if (!admin) throw new AdminAuthFailure('ADMIN_INVALID_CREDENTIALS');
    const pendingSecret = decryptTotpSecret(challenge.pendingSecretEnc, this.appKey);
    const totp = totpFromBase32(pendingSecret, admin.email);
    if (totp.validate({ token: input.code, window: 1 }) === null)
      await this.codeFailure(admin, input.challengeId, 'totp-setup');
    await this.infra.db.admin.update({
      where: { id: admin.id },
      data: {
        totpSecretEnc: encryptTotpSecret(pendingSecret, this.appKey),
        totpEnabled: true,
      },
    });
    return this.complete(admin.id, admin.role, input.challengeId, 'auth.totp.enabled');
  }

  async me(sessionId: string | undefined) {
    if (!sessionId) throw new AdminAuthFailure('ADMIN_INVALID_CREDENTIALS');
    const session = await this.readSession(sessionId);
    const admin = await this.infra.db.admin.findUnique({ where: { id: session.adminId } });
    if (!admin || !admin.isActive || admin.deletedAt)
      throw new AdminAuthFailure('ADMIN_INVALID_CREDENTIALS');
    return { admin: adminMe(admin), csrfToken: session.csrf };
  }

  async logout(sessionId: string | undefined): Promise<void> {
    if (!sessionId) return;
    const session = await this.session(sessionId);
    await dropAdminSession(this.infra.redis, session?.adminId, sessionId);
  }

  async session(sessionId: string | undefined): Promise<AdminSession | undefined> {
    if (!sessionId) return undefined;
    try {
      return await this.readSession(sessionId);
    } catch {
      return undefined;
    }
  }

  private async complete(
    adminId: string,
    role: AdminRole,
    challengeId: string,
    action = 'auth.login.totp',
  ) {
    // Deleting the challenge is the atomic commit point: only the request whose
    // DEL removed the key may issue a session, so a replayed code cannot mint a
    // second one.
    if ((await this.infra.redis.del(this.challengeKey(challengeId))) !== 1)
      throw new AdminAuthFailure('ADMIN_INVALID_CREDENTIALS');
    const csrf = randomBytes(32).toString('base64url');
    const sessionId = randomBytes(32).toString('base64url');
    await storeAdminSession(
      this.infra.redis,
      adminId,
      sessionId,
      JSON.stringify({ adminId, role, totpVerified: true, csrf }),
    );
    const admin = await this.infra.db.admin.findUniqueOrThrow({ where: { id: adminId } });
    await this.infra.db.admin.update({
      where: { id: adminId },
      data: { lastLoginAt: new Date(), failedLogins: 0, lockedUntil: null },
    });
    await this.audit(adminId, action, 'admin', adminId, { role });
    return { admin: adminMe(admin), csrfToken: csrf, sessionId };
  }

  private async challenge(id: string): Promise<Challenge> {
    const raw = await this.infra.redis.get(this.challengeKey(id));
    if (!raw) throw new AdminAuthFailure('ADMIN_INVALID_CREDENTIALS');
    const parsed = JSON.parse(raw) as unknown;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !('adminId' in parsed) ||
      typeof parsed.adminId !== 'string'
    )
      throw new AdminAuthFailure('ADMIN_INVALID_CREDENTIALS');
    return parsed as Challenge;
  }

  private async readSession(id: string): Promise<AdminSession> {
    const raw = await this.infra.redis.get(adminSessionKey(id));
    if (!raw) throw new AdminAuthFailure('ADMIN_INVALID_CREDENTIALS');
    const parsed = JSON.parse(raw) as Partial<Record<string, unknown>>;
    if (
      parsed.totpVerified !== true ||
      typeof parsed.csrf !== 'string' ||
      typeof parsed.adminId !== 'string' ||
      (parsed.role !== 'admin' && parsed.role !== 'operator')
    )
      throw new AdminAuthFailure('ADMIN_INVALID_CREDENTIALS');
    return {
      adminId: parsed.adminId,
      role: parsed.role,
      totpVerified: true,
      csrf: parsed.csrf,
    };
  }

  /**
   * A challenge of an admin who was locked, deactivated or deleted after the
   * password step is spent, not tried.
   */
  private async refuseLockedOrGone(
    admin: { isActive: boolean; deletedAt: Date | null; lockedUntil: Date | null } | null,
    challengeId: string,
  ): Promise<void> {
    if (
      admin?.isActive &&
      !admin.deletedAt &&
      !(admin.lockedUntil && admin.lockedUntil > new Date())
    )
      return;
    await this.infra.redis.del(this.challengeKey(challengeId));
    throw new AdminAuthFailure(
      admin?.isActive && !admin.deletedAt ? 'ADMIN_LOCKED' : 'ADMIN_INVALID_CREDENTIALS',
    );
  }

  /**
   * R27: a wrong code counts like a wrong password (section 9.2: five lock the
   * admin, 15 minutes and doubling to 24 hours), so the second factor cannot
   * be guessed at the rate limit; a lock also spends the challenge.
   */
  private async codeFailure(
    admin: { id: string; email: string },
    challengeId: string,
    reason: 'totp' | 'totp-setup',
  ): Promise<never> {
    if (await this.recordFailure(admin, reason)) {
      await this.infra.redis.del(this.challengeKey(challengeId));
      throw new AdminAuthFailure('ADMIN_LOCKED');
    }
    throw new AdminAuthFailure('ADMIN_TOTP_INVALID');
  }

  private async recordFailure(
    admin: { id: string; email: string },
    reason = 'password',
  ): Promise<boolean> {
    // The counter is incremented by the database so parallel attempts cannot
    // read the same value and overwrite each other's increment.
    const updated = await this.infra.db.admin.update({
      where: { id: admin.id },
      data: { failedLogins: { increment: 1 } },
      select: { failedLogins: true },
    });
    const minutes =
      updated.failedLogins >= 5 ? Math.min(24 * 60, 15 * 2 ** (updated.failedLogins - 5)) : 0;
    if (minutes > 0) {
      await this.infra.db.admin.update({
        where: { id: admin.id },
        data: { lockedUntil: new Date(Date.now() + minutes * 60_000) },
      });
    }
    await this.auditFailure(admin.id, admin.email, reason);
    return minutes > 0;
  }

  private async auditFailure(
    adminId: string | undefined,
    email: string,
    reason = 'password',
  ): Promise<void> {
    await this.audit(adminId, 'auth.failed', 'admin', adminId, {
      email: this.maskEmail(email),
      reason,
    });
  }

  private async audit(
    actorAdminId: string | undefined,
    action: string,
    entity: string,
    entityId: string | undefined,
    after: unknown,
  ) {
    await this.infra.db.auditLog.create({
      data: {
        ...(actorAdminId ? { actorAdminId } : {}),
        actorType: actorAdminId ? 'admin' : 'system',
        action,
        entity,
        ...(entityId ? { entityId } : {}),
        after: after as never,
      },
    });
  }

  private maskEmail(email: string): string {
    const [name, domain] = email.split('@');
    return `${name?.slice(0, 1) ?? '*'}***@${domain ?? 'unknown'}`;
  }

  private challengeKey(id: string) {
    return `rr:admin:challenge:${id}`;
  }
}
