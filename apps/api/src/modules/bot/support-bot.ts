import { randomBytes } from 'node:crypto';

import type { SettingsService } from '../settings/settings.service';

/**
 * Owner decision F35 (2026-09-26): support may run in a bot of its own. Its
 * token is optional — in the setup wizard's «Бот» step and in the console's
 * «Поддержка» — and empty keeps support in the shop bot. The bot process
 * starts it beside the shop bot, in the same delivery mode.
 */
export class SupportBotRefused extends Error {
  constructor(readonly reason: 'invalid_token' | 'same_as_shop_bot') {
    super(reason);
    this.name = 'SupportBotRefused';
  }
}

/** `getMe` (Bot API): the bot a token belongs to, or null for a bad token. */
export async function telegramGetMe(
  token: string,
): Promise<{ id: number; username: string } | null> {
  const base = process.env.RR_TELEGRAM_API_URL ?? 'https://api.telegram.org';
  try {
    const response = await fetch(`${base}/bot${encodeURIComponent(token)}/getMe`, {
      signal: AbortSignal.timeout(10_000),
    });
    const payload = (await response.json().catch(() => ({}))) as {
      ok?: boolean;
      result?: { id?: number; username?: string };
    };
    if (payload.ok !== true || typeof payload.result?.username !== 'string') return null;
    return { id: payload.result.id ?? 0, username: payload.result.username };
  } catch {
    return null;
  }
}

/**
 * Saves the support bot's token (checked with `getMe`, and refused when it is
 * the shop bot's own), its username and webhook secrets; an empty token turns
 * the support bot off. `bot.*` settings make the bot process rebuild itself.
 */
export async function configureSupportBot(
  settings: Pick<SettingsService, 'get' | 'set'>,
  token: string,
  actor?: { id?: string },
): Promise<{ username: string | null }> {
  if (token === '') {
    // The webhook secrets go with the bot: its address stops answering.
    await settings.set(
      {
        bot: {
          support_token: '',
          support_username: '',
          support_webhook_secret_path: '',
          support_webhook_secret_token: '',
        },
      },
      actor,
    );
    return { username: null };
  }
  const me = await telegramGetMe(token);
  if (!me) throw new SupportBotRefused('invalid_token');
  const shopToken = String(await settings.get('bot.token'));
  if (shopToken.split(':')[0] === String(me.id)) throw new SupportBotRefused('same_as_shop_bot');
  // The same bot keeps its webhook secrets; another bot gets new ones, so
  // what Telegram still sends for the previous bot is refused.
  const previous = String(await settings.get('bot.support_token'));
  const sameBot = previous.split(':')[0] === String(me.id);
  const secretPath =
    (sameBot && String(await settings.get('bot.support_webhook_secret_path'))) ||
    randomBytes(24).toString('base64url');
  const secretToken =
    (sameBot && String(await settings.get('bot.support_webhook_secret_token'))) ||
    randomBytes(24).toString('base64url');
  await settings.set(
    {
      bot: {
        support_token: token,
        support_username: me.username,
        support_webhook_secret_path: secretPath,
        support_webhook_secret_token: secretToken,
      },
    },
    actor,
  );
  return { username: me.username };
}
