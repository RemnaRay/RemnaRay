import { GrammyError } from 'grammy';
import { describe, expect, it } from 'vitest';

import { ApiClientError } from './api-client.js';
import { failureOf } from './logger.js';

describe('failureOf (R82)', () => {
  it('keeps the class and codes of a failure, never its message', () => {
    expect(failureOf(new ApiClientError(503, 'UNAVAILABLE'))).toEqual({
      error: 'ApiClientError',
      status: 503,
      code: 'UNAVAILABLE',
    });
    const telegram = new GrammyError(
      'Call to getMe failed! (401: Unauthorized)',
      { ok: false, error_code: 401, description: 'Unauthorized' },
      'getMe',
      {},
    );
    expect(failureOf(telegram)).toMatchObject({
      error: 'GrammyError',
      telegramCode: 401,
      method: 'getMe',
    });
    const leaking = new Error('request to https://api.telegram.org/bot1:SECRET/getMe failed');
    expect(JSON.stringify(failureOf(leaking))).not.toContain('SECRET');
    expect(failureOf('down')).toEqual({ error: 'string' });
  });
});
