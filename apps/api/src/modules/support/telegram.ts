/** A Bot API call that Telegram refused (`ok: false`) or did not answer. */
export class TelegramCallError extends Error {
  constructor(
    readonly method: string,
    readonly code: number | undefined,
    readonly description: string,
  ) {
    super(`${method}: ${description}`);
    this.name = 'TelegramCallError';
  }
}

/**
 * One Bot API call with `token` (the shop bot's or the support bot's). The
 * API makes the support calls itself: it knows which bot runs support and
 * which chat and topic a ticket lives in.
 */
export async function telegramCall<T = unknown>(
  token: string,
  method: string,
  body: Record<string, unknown>,
): Promise<T> {
  const base = process.env.RR_TELEGRAM_API_URL ?? 'https://api.telegram.org';
  const response = await fetch(`${base}/bot${encodeURIComponent(token)}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(10_000),
    body: JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => ({}))) as {
    ok?: boolean;
    result?: T;
    error_code?: number;
    description?: string;
  };
  if (!payload.ok || payload.result === undefined)
    throw new TelegramCallError(
      method,
      payload.error_code,
      payload.description ?? `HTTP ${String(response.status)}`,
    );
  return payload.result;
}

/** "message is not modified": an edit that changes nothing is not a failure. */
export function notModified(error: unknown): boolean {
  return error instanceof TelegramCallError && /message is not modified/iu.test(error.description);
}
