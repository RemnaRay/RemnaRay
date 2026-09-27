import { createHash, timingSafeEqual } from 'node:crypto';
import { BlockList, isIP } from 'node:net';
import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { Infrastructure } from '../../infra/infra.module';

export type AuthenticatedRequest = FastifyRequest & {
  user?: { id: string; sessionId?: string };
  admin?: { id: string; csrf: string; role: string };
};
export function readCookie(header: string | undefined, name: string): string | undefined {
  const value = header
    ?.split(';')
    .map((item) => item.trim())
    .find((item) => item.startsWith(`${name}=`))
    ?.slice(name.length + 1);
  return value && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : undefined;
}
export function equalToken(actual: unknown, expected: string | undefined): boolean {
  if (typeof actual !== 'string' || !expected) return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
/**
 * A secret compared in constant time whatever its length: both sides are
 * hashed first, so neither the content nor the length leaks through timing.
 */
export function equalSecret(actual: string, expected: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(actual), digest(expected));
}
export function trustedInternal(address: string): boolean {
  const ip = address.replace(/^::ffff:/, '');
  const family = isIP(ip) === 4 ? 'ipv4' : 'ipv6';
  const list = new BlockList();
  for (const cidr of (process.env.RR_TRUSTED_INTERNAL_CIDR ?? '172.28.0.0/16').split(',')) {
    const [subnet, bits] = cidr.trim().split('/');
    if (!subnet || !bits || !isIP(subnet)) continue;
    list.addSubnet(subnet, Number(bits), isIP(subnet) === 4 ? 'ipv4' : 'ipv6');
  }
  return list.check(ip, family);
}
@Injectable()
export class InternalTokenGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<FastifyRequest>();
    if (
      !trustedInternal(req.raw.socket.remoteAddress ?? '') ||
      !equalToken(req.headers['x-internal-token'], process.env.RR_INTERNAL_TOKEN)
    ) {
      throw new UnauthorizedException('UNAUTHENTICATED');
    }
    return true;
  }
}
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(@Inject(Infrastructure) private readonly infra: Infrastructure) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const path = req.routeOptions.url ?? req.url.split('?')[0] ?? '';
    if (path.startsWith('/api/internal/')) return new InternalTokenGuard().canActivate(context);
    if (path.startsWith('/api/admin/')) {
      if (path.startsWith('/api/admin/v1/auth/login') || path.startsWith('/api/admin/v1/auth/totp'))
        return true;
      const sid = readCookie(req.headers.cookie, 'rr_asid');
      const raw = sid ? await this.infra.redis.get(`rr:asess:${sid}`) : null;
      const session = raw
        ? (JSON.parse(raw) as { adminId?: string; totpVerified?: boolean; csrf?: string })
        : null;
      if (!session?.adminId || session.totpVerified !== true || !session.csrf)
        throw new UnauthorizedException('UNAUTHENTICATED');
      const admin = await this.infra.db.admin.findUnique({ where: { id: session.adminId } });
      if (!admin?.isActive || admin.deletedAt || !admin.totpEnabled)
        throw new ForbiddenException('FORBIDDEN');
      req.admin = { id: admin.id, csrf: session.csrf, role: admin.role };
      return true;
    }
    if (!path.startsWith('/api/v1/me') && path !== '/api/v1/auth/logout') return true;
    // The session cookie only: the bot's link token is no Bearer credential
    // (R79, owner decision О-9).
    let id: string | undefined;
    const sid = readCookie(req.headers.cookie, 'rr_sid');
    const raw = sid ? await this.infra.redis.getex(`rr:sess:${sid}`, 'EX', 2592000) : null;
    if (raw && sid) {
      const session = JSON.parse(raw) as { userId?: string };
      id = session.userId;
      if (id) req.user = { id, sessionId: sid };
    }
    if (!id) throw new UnauthorizedException('UNAUTHENTICATED');
    const user = await this.infra.db.user.findUnique({ where: { id } });
    if (!user || user.isBanned || user.anonymizedAt) throw new ForbiddenException('FORBIDDEN');
    req.user ??= { id };
    return true;
  }
}
@Injectable()
export class CsrfGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const path = req.routeOptions.url ?? req.url.split('?')[0] ?? '';
    if (
      ['GET', 'HEAD', 'OPTIONS'].includes(req.method) ||
      path.startsWith('/api/internal/') ||
      path.startsWith('/webhooks/') ||
      path.startsWith('/tg/webhook/')
    )
      return true;
    const site = req.headers['sec-fetch-site'];
    const expectedOrigin = `https://${process.env.RR_DOMAIN ?? ''}`;
    if (
      req.headers['x-requested-with'] !== 'RemnaRay' ||
      !(site === 'same-origin' || site === 'none' || req.headers.origin === expectedOrigin)
    )
      throw new ForbiddenException('FORBIDDEN');
    if (req.admin && !equalToken(req.headers['x-csrf-token'], req.admin.csrf))
      throw new ForbiddenException('FORBIDDEN');
    return true;
  }
}
