import { Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { createLogger, httpLoggerOptions, logUrl, REDACT_PATHS, requestId } from './index.js';

describe('logger redaction', () => {
  it('covers every secret category required by section 19.6', () => {
    for (const path of [
      'authorization',
      'cookie',
      'set-cookie',
      'hash',
      'initData',
      'token',
      'secret',
      'password',
      'totpCode',
      'secret_path',
      'idempotency-key',
      'email',
      'req.headers["x-internal-token"]',
      'req.headers["x-telegram-bot-api-secret-token"]',
      'req.headers["x-csrf-token"]',
      'res.headers["set-cookie"]',
    ]) {
      expect(REDACT_PATHS.some((candidate) => candidate.endsWith(path))).toBe(true);
    }
  });

  it('redacts secrets and masks email values in emitted JSON', () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        lines.push(String(chunk));
        callback();
      },
    });
    const logger = createLogger({ destination: stream });

    logger.info(
      {
        authorization: 'Bearer secret',
        email: 'alice@example.com',
        body: { password: 'p', token: 't' },
        safe: 'visible',
      },
      'test',
    );

    const record = JSON.parse(lines[0] as string) as Record<string, unknown>;
    expect(record.authorization).toBe('[Redacted]');
    expect(record.email).toBe('a***@example.com');
    expect(record.safe).toBe('visible');
    expect(record.body).toEqual({ password: '[Redacted]', token: '[Redacted]' });
  });
});

describe('HTTP request logging (R4)', () => {
  it('logs the path without the query string or the webhook secret path', () => {
    expect(logUrl('/auth/tg?token=jwt')).toBe('/auth/tg');
    expect(logUrl('/tg/webhook/s3cr3t?x=1')).toBe('/tg/webhook/***');
    expect(logUrl('/tg/webhookx')).toBe('/tg/webhookx');
    expect(logUrl(undefined)).toBe('');
  });

  it('keeps a well-formed X-Request-Id and replaces anything else', () => {
    const request = (value?: string) =>
      ({ headers: value ? { 'x-request-id': value } : {} }) as never;
    expect(requestId(request('abc-1.2_3'))).toBe('abc-1.2_3');
    expect(requestId(request('a\nb'))).toMatch(/^[0-9a-f-]{36}$/u);
    expect(requestId(request())).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it('serializes the request and the response from an allowlist', () => {
    const { serializers } = httpLoggerOptions({ service: 'api' });
    expect(
      serializers.req({
        id: 'r1',
        method: 'POST',
        url: '/tg/webhook/abc?token=t',
        remoteAddress: '192.0.2.1',
        headers: { cookie: 'c' },
        query: { token: 't' },
      } as never),
    ).toEqual({ id: 'r1', method: 'POST', url: '/tg/webhook/***', remoteAddress: '192.0.2.1' });
    expect(serializers.res({ statusCode: 200, headers: { 'set-cookie': 'x' } } as never)).toEqual({
      statusCode: 200,
    });
  });
});
