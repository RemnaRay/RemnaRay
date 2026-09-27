import { Body, Controller, Get, HttpCode, Param, Patch, Post, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { FastifyReply } from 'fastify';

import { type AuthenticatedRequest, readCookie } from '../auth/auth.guards';
import { AdminAuthService } from './admin.auth.service';
import { AdminsService } from './admins.service';
import { Audit } from './audit.interceptor';
import { Permissions, Roles } from './admin.rbac';

const ADMIN_COOKIE_MAX_AGE = 12 * 60 * 60;

@Controller('api/admin/v1/auth')
export class AdminAuthController {
  constructor(private readonly auth: AdminAuthService) {}

  // Section 9.1: sign-in steps are limited like `POST /api/v1/auth/*` —
  // the TOTP steps too (R27).
  @Post('login')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  login(@Body() body: unknown) {
    return this.auth.login(body);
  }

  @Post('totp/setup')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  setup(@Body() body: unknown) {
    return this.auth.setup(body);
  }

  @Post('totp')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async totp(@Body() body: unknown, @Res({ passthrough: true }) reply: FastifyReply) {
    const result = await this.auth.totp(body);
    setAdminCookie(reply, result.sessionId);
    return { admin: result.admin, csrfToken: result.csrfToken };
  }

  @Post('totp/confirm')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async confirm(@Body() body: unknown, @Res({ passthrough: true }) reply: FastifyReply) {
    const result = await this.auth.confirm(body);
    setAdminCookie(reply, result.sessionId);
    return { admin: result.admin, csrfToken: result.csrfToken };
  }

  @Get('me')
  me(@Req() request: AuthenticatedRequest) {
    return this.auth.me(readCookie(request.headers.cookie, 'rr_asid'));
  }

  @Post('logout')
  @HttpCode(204)
  async logout(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    await this.auth.logout(readCookie(request.headers.cookie, 'rr_asid'));
    reply.header('set-cookie', 'rr_asid=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax');
  }
}

function setAdminCookie(reply: FastifyReply, value: string): void {
  reply.header(
    'set-cookie',
    `rr_asid=${encodeURIComponent(value)}; Max-Age=${String(ADMIN_COOKIE_MAX_AGE)}; Path=/; HttpOnly; Secure; SameSite=Lax`,
  );
}

@Controller('api/admin/v1/admins')
@Roles('admin')
@Permissions('admins.write')
export class AdminsController {
  constructor(private readonly admins: AdminsService) {}

  @Get()
  list() {
    return this.admins.list();
  }

  @Post()
  @HttpCode(201)
  @Audit('admins.create', 'admin')
  create(@Body() body: unknown) {
    return this.admins.create(body);
  }

  @Patch(':id')
  @Audit('admins.update', 'admin', 'id')
  update(@Param('id') id: string, @Body() body: unknown) {
    return this.admins.update(id, body);
  }

  @Post(':id/reset-password')
  @HttpCode(200)
  @Audit('admins.reset-password', 'admin', 'id')
  resetPassword(@Param('id') id: string, @Body() body: unknown) {
    return this.admins.resetPassword(id, body);
  }

  @Post(':id/reset-totp')
  @HttpCode(200)
  @Audit('admins.reset-totp', 'admin', 'id')
  resetTotp(@Param('id') id: string) {
    return this.admins.resetTotp(id);
  }

  @Post(':id/deactivate')
  @HttpCode(200)
  @Audit('admins.deactivate', 'admin', 'id')
  deactivate(@Param('id') id: string, @Body() body: unknown) {
    return this.admins.deactivate(id, body);
  }
}
