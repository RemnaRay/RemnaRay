import { describe, expect, it } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';

import { sessionRequestLimit, sessionTracker, skipThrottleForInternal } from './auth.module';

function context(url: string, session?: { admin?: { id: string }; user?: { id: string } }) {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ url, routeOptions: { url: undefined }, ip: '192.0.2.1', ...session }),
    }),
  } as unknown as ExecutionContext;
}

describe('internal throttling boundary', () => {
  it('exempts worker-to-api routes from the browser rate limit', () => {
    expect(skipThrottleForInternal(context('/api/internal/v1/payments/poll-pending'))).toBe(true);
    expect(skipThrottleForInternal(context('/api/internal/v1/system/tls-result'))).toBe(true);
    expect(skipThrottleForInternal(context('/api/v1/public/config'))).toBe(false);
  });

  it('uses the session limit and a per-account tracker after authentication', () => {
    const admin = context('/api/admin/v1/auth/me', { admin: { id: 'admin-1' } });
    const user = context('/api/v1/me', { user: { id: 'user-1' } });
    const publicRequest = context('/api/v1/public/config');
    expect(sessionRequestLimit(admin)).toBe(300);
    expect(sessionRequestLimit(user)).toBe(300);
    expect(sessionRequestLimit(publicRequest)).toBe(60);
    expect(sessionTracker(admin.switchToHttp().getRequest())).toBe('admin:admin-1');
    expect(sessionTracker(user.switchToHttp().getRequest())).toBe('user:user-1');
    expect(sessionTracker(publicRequest.switchToHttp().getRequest())).toBe('ip:192.0.2.1');
  });

  // Section 9.1: webhooks — 600/min per provider. They used to be counted as
  // anonymous requests, 60/min per IP in the visitors' bucket, so a burst of
  // provider notifications was refused with 429. P-2 (О-16): one bucket per
  // provider let anyone fill it with forged requests and lock the provider
  // out, so the bucket is the provider's per sending address.
  it.each([
    ['/webhooks/yookassa', 'webhook:yookassa:ip:192.0.2.1'],
    ['/webhooks/robokassa/result', 'webhook:robokassa:ip:192.0.2.1'],
    ['/webhooks/remnawave', 'webhook:remnawave:ip:192.0.2.1'],
    ['/tg/webhook/s3cr3t-path', 'webhook:telegram:ip:192.0.2.1'],
  ])('gives %s its own provider bucket of 600 a minute per address', (url, tracker) => {
    const webhook = context(url);
    expect(sessionRequestLimit(webhook)).toBe(600);
    expect(sessionTracker(webhook.switchToHttp().getRequest())).toBe(tracker);
  });

  it('keeps the query string and other paths out of the webhook buckets', () => {
    expect(sessionTracker(context('/webhooks/lava?x=1').switchToHttp().getRequest())).toBe(
      'webhook:lava:ip:192.0.2.1',
    );
    expect(sessionRequestLimit(context('/webhooksfoo'))).toBe(60);
    expect(sessionTracker(context('/tg/webhookx').switchToHttp().getRequest())).toBe(
      'ip:192.0.2.1',
    );
  });
});
