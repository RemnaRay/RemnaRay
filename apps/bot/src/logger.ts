import { createLogger } from '@remnaray/logger';

/**
 * Sections 19.6 and 20.1: the bot logs pino JSON lines with the shared
 * redaction list, at `RR_LOG_LEVEL`. Lines go through `process.stdout.write`
 * like the other services' do.
 */
export const logger = createLogger({
  base: { service: 'bot' },
  level: process.env.RR_LOG_LEVEL ?? 'info',
  destination: { write: (line: string) => process.stdout.write(line) },
});

/**
 * What is safe to log about a failure: its class and codes — never its
 * message, which can quote a request URL (and so the bot token) or a payload.
 */
export function failureOf(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { error: typeof error };
  const detail = error as Error & {
    status?: unknown;
    code?: unknown;
    error_code?: unknown;
    method?: unknown;
  };
  return {
    error: error.name,
    ...(detail.status === undefined ? {} : { status: detail.status }),
    ...(detail.code === undefined ? {} : { code: detail.code }),
    ...(detail.error_code === undefined ? {} : { telegramCode: detail.error_code }),
    ...(detail.method === undefined ? {} : { method: detail.method }),
  };
}
