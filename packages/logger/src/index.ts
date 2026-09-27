import { randomUUID } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

import pino, { type DestinationStream, type Logger, type LoggerOptions } from 'pino';

export type { DestinationStream } from 'pino';

export const REDACT_PATHS = [
  'authorization',
  'cookie',
  'set-cookie',
  'hash',
  'initData',
  'token',
  'secret',
  'secretKey',
  'apiToken',
  'api_key',
  'password',
  'totp',
  'totpCode',
  'secret_path',
  'idempotency-key',
  'headers.authorization',
  'headers.cookie',
  'headers.set-cookie',
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers.set-cookie',
  'request.headers.authorization',
  'request.headers.cookie',
  'request.headers.set-cookie',
  'req.headers["x-internal-token"]',
  'req.headers["x-telegram-bot-api-secret-token"]',
  'req.headers["x-csrf-token"]',
  'req.headers["idempotency-key"]',
  'req.headers.signature',
  'req.headers["crypto-pay-api-signature"]',
  'res.headers["set-cookie"]',
  'body.token',
  'body.secret',
  'body.password',
  'body.hash',
  'body.initData',
  'body.secret_path',
  'body.idempotency-key',
  '*.token',
  '*.secret',
  '*.password',
  '*.secretKey',
  '*.apiToken',
  '*.hash',
  '*.initData',
  '*.secret_path',
  '*.totpCode',
  '*.idempotency-key',
  'email',
  '*.email',
];

export function maskEmail(value: unknown): string {
  const email = String(value);
  const at = email.indexOf('@');
  if (at <= 0 || at === email.length - 1) {
    return '[Redacted]';
  }
  return `${email.charAt(0)}***${email.slice(at)}`;
}

function censor(value: unknown, path: string[]): string {
  return path[path.length - 1] === 'email' ? maskEmail(value) : '[Redacted]';
}

export function createLogger(
  options: Omit<LoggerOptions, 'redact'> & { destination?: DestinationStream } = {},
): Logger {
  const { destination, ...loggerOptions } = options;
  return pino(
    {
      ...loggerOptions,
      redact: { paths: REDACT_PATHS, censor },
    },
    destination,
  );
}

/** An `X-Request-Id` a proxy set is reused only when it cannot break a log line. */
const REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/u;

/**
 * Section 20.1: a request carries the proxy's `X-Request-Id` through the logs;
 * a missing or malformed one gets a fresh id. Fastify's `genReqId` and the
 * logger's share it, since the logger reuses the id Fastify gave the request.
 */
export function requestId(request: { headers: IncomingHttpHeaders }): string {
  const header = request.headers['x-request-id'];
  const value = Array.isArray(header) ? header[0] : header;
  return value && REQUEST_ID.test(value) ? value : randomUUID();
}

/**
 * Section 19.6: the path is logged without its query string (`/auth/tg?token=`)
 * and the Telegram webhook without its `secret_path`.
 */
export function logUrl(url: unknown): string {
  const path = typeof url === 'string' ? (url.split('?')[0] ?? '') : '';
  return /^\/tg\/webhook\//u.test(path) ? '/tg/webhook/***' : path;
}

type SerializedRequest = { id?: unknown; method?: unknown; url?: unknown; remoteAddress?: unknown };
type SerializedResponse = { statusCode?: unknown };

/**
 * Options of the HTTP request logger (`pino-http`, through `nestjs-pino`) of
 * the API and the worker. The request is logged from an allowlist — never its
 * headers (cookies, `X-Internal-Token`, the webhook secret, signatures) or
 * query — and the redaction list stays as a second line of defence.
 */
export function httpLoggerOptions(options: { service: string; level?: string | undefined }) {
  return {
    level: options.level ?? 'info',
    base: { service: options.service },
    redact: { paths: REDACT_PATHS, censor },
    genReqId: requestId,
    serializers: {
      req: (request: SerializedRequest) => ({
        id: request.id,
        method: request.method,
        url: logUrl(request.url),
        remoteAddress: request.remoteAddress,
      }),
      res: (response: SerializedResponse) => ({ statusCode: response.statusCode }),
    },
  };
}
