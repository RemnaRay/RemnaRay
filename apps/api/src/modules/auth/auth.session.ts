import Redis from 'ioredis';
import { randomBytes } from 'node:crypto';

import type { UserSummary } from '../users/users.repository';

export type SessionRecord = {
  userId: string;
  user?: UserSummary;
  createdAt: string;
  userAgent?: string;
  ip?: string;
};

export interface SessionStorePort {
  create(record: Omit<SessionRecord, 'createdAt'>): Promise<string>;
  get(id: string): Promise<SessionRecord | undefined>;
  delete(id: string): Promise<void>;
  /** True the first time `key` is claimed within `ttlSeconds` (a one-time use). */
  claimOnce(key: string, ttlSeconds: number): Promise<boolean>;
  /** Whether `key` has been claimed and the claim is still held. */
  isClaimed(key: string): Promise<boolean>;
  close(): Promise<void>;
}

export class RedisSessionStore implements SessionStorePort {
  private readonly redis: Redis;
  private readonly ttlSeconds = 30 * 24 * 60 * 60;

  constructor(redisUrl = process.env.VALKEY_URL ?? 'redis://valkey:6379/0') {
    this.redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: null });
  }

  async create(record: Omit<SessionRecord, 'createdAt'>): Promise<string> {
    const id = randomBytes(32).toString('base64url');
    const value: SessionRecord = { ...record, createdAt: new Date().toISOString() };
    await this.redis.set(`rr:sess:${id}`, JSON.stringify(value), 'EX', this.ttlSeconds);
    return id;
  }

  async get(id: string): Promise<SessionRecord | undefined> {
    const value = await this.redis.getex(`rr:sess:${id}`, 'EX', this.ttlSeconds);
    if (!value) return undefined;
    return JSON.parse(value) as SessionRecord;
  }

  async delete(id: string): Promise<void> {
    await this.redis.del(`rr:sess:${id}`);
  }

  async claimOnce(key: string, ttlSeconds: number): Promise<boolean> {
    return (await this.redis.set(`rr:once:${key}`, '1', 'EX', ttlSeconds, 'NX')) === 'OK';
  }

  async isClaimed(key: string): Promise<boolean> {
    return (await this.redis.exists(`rr:once:${key}`)) === 1;
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }
}
