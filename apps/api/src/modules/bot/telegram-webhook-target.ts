import { equalToken } from '../auth/auth.guards';
import type { SettingsService } from '../settings/settings.service';

export type TelegramWebhookTarget = { prefix: string; stream: string; received: string };

/** Where a support bot's updates wait for the bot process (F35). */
export function supportUpdatesStream(botId: string): string {
  return `tg:support-updates:${botId}`;
}

/**
 * The bot a Telegram webhook request belongs to, or none when its secret path
 * or `X-Telegram-Bot-Api-Secret-Token` matches no configured bot. The shop
 * bot and, when configured, the support bot (F35) each have a secret path and
 * token of their own, and a stream of their own; the support bot's is named
 * after the bot, so a replaced bot's leftovers are never read by the next one.
 */
export async function telegramWebhookTarget(
  settings: Pick<SettingsService, 'get'>,
  secretPath: string,
  token: string | undefined,
): Promise<TelegramWebhookTarget | undefined> {
  const bots: TelegramWebhookTarget[] = [
    { prefix: 'bot.', stream: 'tg:updates', received: 'tg:received:' },
  ];
  const supportToken = await settings.get('bot.support_token');
  const supportBotId = typeof supportToken === 'string' ? supportToken.split(':')[0] : '';
  if (supportBotId)
    bots.push({
      prefix: 'bot.support_',
      stream: supportUpdatesStream(supportBotId),
      received: `tg:support-received:${supportBotId}:`,
    });
  let target: TelegramWebhookTarget | undefined;
  for (const bot of bots) {
    const configuredPath = String(await settings.get(`${bot.prefix}webhook_secret_path`));
    const configuredToken = String(await settings.get(`${bot.prefix}webhook_secret_token`));
    if (
      configuredPath !== '' &&
      equalToken(secretPath, configuredPath) &&
      equalToken(token, configuredToken)
    )
      target = bot;
  }
  return target;
}

/** The secret-token header of a Telegram webhook request. */
export function telegramSecretToken(
  headers: Record<string, string | string[] | undefined>,
): string | undefined {
  const header = headers['x-telegram-bot-api-secret-token'];
  return Array.isArray(header) ? header[0] : header;
}
