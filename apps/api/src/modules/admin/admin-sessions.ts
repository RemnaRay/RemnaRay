import type Redis from 'ioredis';

/** Section 7.4: an admin session, 12 hours, never extended. */
export const ADMIN_SESSION_TTL = 12 * 60 * 60;

export function adminSessionKey(sessionId: string): string {
  return `rr:asess:${sessionId}`;
}

/** The ids of an admin's live sessions, so they can all be ended at once. */
function indexKey(adminId: string): string {
  return `rr:asess:admin:${adminId}`;
}

type SessionStore = Pick<Redis, 'set' | 'sadd' | 'srem' | 'smembers' | 'expire' | 'del'>;

export async function storeAdminSession(
  redis: SessionStore,
  adminId: string,
  sessionId: string,
  value: string,
): Promise<void> {
  await redis.set(adminSessionKey(sessionId), value, 'EX', ADMIN_SESSION_TTL);
  await redis.sadd(indexKey(adminId), sessionId);
  // The index lives as long as its newest session could.
  await redis.expire(indexKey(adminId), ADMIN_SESSION_TTL);
}

export async function dropAdminSession(
  redis: SessionStore,
  adminId: string | undefined,
  sessionId: string,
): Promise<void> {
  await redis.del(adminSessionKey(sessionId));
  if (adminId) await redis.srem(indexKey(adminId), sessionId);
}

/**
 * R78 (section 7.4: an admin session ends on logout and on a password
 * change): a reset password or TOTP, or a deactivation, ends every session
 * the admin has, so a stolen `rr_asid` does not outlive the credentials.
 */
export async function endAdminSessions(redis: SessionStore, adminId: string): Promise<void> {
  const sessions = await redis.smembers(indexKey(adminId));
  await redis.del(...sessions.map(adminSessionKey), indexKey(adminId));
}
