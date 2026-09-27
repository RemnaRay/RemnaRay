import { Prisma, ReferralStatus, type PrismaClient } from '@remnaray/db';
import { randomInt } from 'node:crypto';

import { emitWebhook } from '../webhooks/outgoing';
import type { ParsedStartPayload, UserUpsertInput } from './users.schemas';

export type UserSummary = {
  id: string;
  telegramId: string;
  username: string | null;
  firstName: string | null;
  language: string;
  referralCode: string;
  isBanned: boolean;
};

export type UserUpsertResult = {
  user: UserSummary;
  created: boolean;
  attributed: boolean;
  promoReserved: boolean;
  planSlug?: string;
};

export interface UsersRepositoryPort {
  upsert(
    input: UserUpsertInput,
    payload: ParsedStartPayload,
    defaultLanguage: string,
  ): Promise<UserUpsertResult>;
  findSummary(id: string): Promise<UserSummary | null>;
}

const REFERRAL_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateReferralCode(): string {
  let value = '';
  for (let index = 0; index < 8; index += 1) {
    const symbol = REFERRAL_ALPHABET[randomInt(REFERRAL_ALPHABET.length)];
    if (!symbol) throw new Error('Referral alphabet is empty');
    value += symbol;
  }
  return value;
}

function summary(user: {
  id: string;
  telegramId: bigint;
  username: string | null;
  firstName: string | null;
  language: string;
  referralCode: string;
  isBanned: boolean;
}): UserSummary {
  return {
    id: user.id,
    telegramId: user.telegramId.toString(),
    username: user.username,
    firstName: user.firstName,
    language: user.language,
    referralCode: user.referralCode,
    isBanned: user.isBanned,
  };
}

export class UsersRepository implements UsersRepositoryPort {
  constructor(private readonly prisma: PrismaClient) {}

  async findSummary(id: string): Promise<UserSummary | null> {
    const user = await this.prisma.user.findUnique({ where: { id } });
    return user && !user.anonymizedAt ? summary(user) : null;
  }

  async upsert(
    input: UserUpsertInput,
    payload: ParsedStartPayload,
    defaultLanguage: string,
  ): Promise<UserUpsertResult> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await this.prisma.$transaction(async (transaction) => {
          const existing = await transaction.user.findUnique({
            where: { telegramId: input.telegramId },
          });
          if (existing) {
            let attributed = false;
            let referrerId: string | null = null;
            if (!existing.referrerId && payload.referralCode) {
              const createdRecently =
                existing.createdAt.getTime() >= Date.now() - 24 * 60 * 60 * 1000;
              const paidTransactions = await transaction.transaction.count({
                where: { userId: existing.id, type: { in: ['purchase', 'topup'] } },
              });
              if (createdRecently && paidTransactions === 0) {
                const referrer = await transaction.user.findFirst({
                  where: { referralCode: payload.referralCode, isBanned: false },
                  select: { id: true },
                });
                if (referrer && referrer.id !== existing.id) {
                  referrerId = referrer.id;
                  attributed = true;
                }
              }
            }
            const updated = await transaction.user.update({
              where: { id: existing.id },
              data: {
                username: input.username ?? existing.username,
                firstName: input.firstName ?? existing.firstName,
                language: existing.language,
                ...(referrerId ? { referrerId } : {}),
                lastSeenAt: new Date(),
              },
            });
            await this.ensureTelegramIdentity(transaction, updated.id, input.telegramId.toString());
            if (attributed && referrerId) {
              await transaction.referralAttribution.create({
                data: {
                  refereeId: updated.id,
                  referrerId,
                  source: 'telegram',
                  code: payload.referralCode ?? null,
                  status: ReferralStatus.pending,
                },
              });
            }
            return {
              user: summary(updated),
              created: false,
              attributed,
              promoReserved: existing.pendingPromocodeId !== null,
              ...(payload.planSlug ? { planSlug: payload.planSlug } : {}),
            };
          }

          const referrer = payload.referralCode
            ? await transaction.user.findFirst({
                where: { referralCode: payload.referralCode, isBanned: false },
                select: { id: true },
              })
            : null;
          const referralCode = await this.uniqueReferralCode(transaction);
          const promo = payload.promoCode
            ? await transaction.promocode.findFirst({
                where: {
                  code: { equals: payload.promoCode, mode: 'insensitive' },
                  isActive: true,
                  deletedAt: null,
                },
                select: { id: true },
              })
            : null;
          const language =
            input.languageCode === 'ru' || input.languageCode === 'en'
              ? input.languageCode
              : defaultLanguage;
          const user = await transaction.user.create({
            data: {
              telegramId: input.telegramId,
              username: input.username ?? null,
              firstName: input.firstName ?? null,
              language,
              referralCode,
              referrerId: referrer?.id ?? null,
              pendingPromocodeId: promo?.id ?? null,
              lastSeenAt: new Date(),
            },
          });
          await this.ensureTelegramIdentity(transaction, user.id, input.telegramId.toString());
          await emitWebhook(transaction, 'user.created', user.id, {
            username: user.username,
            language: user.language,
            referrerId: user.referrerId,
          });
          if (referrer && referrer.id !== user.id) {
            await transaction.referralAttribution.create({
              data: {
                refereeId: user.id,
                referrerId: referrer.id,
                source: 'telegram',
                code: payload.referralCode ?? null,
                status: ReferralStatus.pending,
              },
            });
          }

          return {
            user: summary(user),
            created: true,
            attributed: referrer !== null && referrer.id !== user.id,
            promoReserved: promo !== null,
            ...(payload.planSlug ? { planSlug: payload.planSlug } : {}),
          };
        });
      } catch (error) {
        if (attempt === 0 && isUniqueConstraintError(error)) continue;
        throw error;
      }
    }
    throw new Error('User upsert retry limit exceeded');
  }

  private async uniqueReferralCode(transaction: Prisma.TransactionClient): Promise<string> {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const code = generateReferralCode();
      const existing = await transaction.user.findUnique({
        where: { referralCode: code },
        select: { id: true },
      });
      if (!existing) return code;
    }
    throw new Error('Unable to allocate a unique referral code');
  }

  private async ensureTelegramIdentity(
    transaction: Prisma.TransactionClient,
    userId: string,
    externalId: string,
  ): Promise<void> {
    const identity = await transaction.channelIdentity.findFirst({
      where: { channel: 'telegram', externalId },
      select: { id: true },
    });
    if (!identity) {
      await transaction.channelIdentity.create({
        data: { userId, channel: 'telegram', externalId, meta: {} },
      });
    }
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}
