import { Writable } from 'node:stream';

import { Controller, Logger as NestLogger, Module, Post, Res } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyReply } from 'fastify';
import { requestId } from '@remnaray/logger';
import { Logger, LoggerModule } from 'nestjs-pino';
import { afterEach, describe, expect, it } from 'vitest';

import { loggerParams } from './logging';

const SECRETS = [
  'ADMINSESSION',
  'INTERNALTOKEN',
  'TGSECRETTOKEN',
  'SECRETPATH',
  'SIGNINJWT',
  'CSRFTOKEN',
  'SETCOOKIEVALUE',
];

@Controller('tg/webhook')
class WebhookController {
  private readonly logger = new NestLogger('WebhookController');

  @Post(':secretPath')
  receive(@Res({ passthrough: true }) reply: FastifyReply) {
    this.logger.warn('inside handler');
    void reply.header('set-cookie', 'rr_sid=SETCOOKIEVALUE; HttpOnly');
    return { ok: true };
  }
}

@Module({ controllers: [WebhookController] })
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
class ProbeModule {}

let app: NestFastifyApplication | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('API request logging (section 19.6, R4)', () => {
  it('writes no cookie, token, webhook secret or query string', async () => {
    const lines: string[] = [];
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        lines.push(String(chunk));
        callback();
      },
    });

    @Module({ imports: [LoggerModule.forRoot(loggerParams(destination)), ProbeModule] })
    // eslint-disable-next-line @typescript-eslint/no-extraneous-class
    class LoggedModule {}

    app = await NestFactory.create<NestFastifyApplication>(
      LoggedModule,
      new FastifyAdapter({ genReqId: requestId }),
      {
        logger: false,
      },
    );
    app.useLogger(app.get(Logger));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    const response = await app.inject({
      method: 'POST',
      url: '/tg/webhook/SECRETPATH?token=SIGNINJWT',
      headers: {
        cookie: 'rr_asid=ADMINSESSION',
        authorization: 'Bearer SIGNINJWT',
        'x-internal-token': 'INTERNALTOKEN',
        'x-telegram-bot-api-secret-token': 'TGSECRETTOKEN',
        'x-csrf-token': 'CSRFTOKEN',
        'x-request-id': 'probe-1',
      },
      payload: {},
    });
    expect(response.statusCode).toBe(201);

    const output = lines.join('');
    expect(output).toContain('inside handler');
    expect(output).toContain('request completed');
    for (const secret of SECRETS) expect(output, secret).not.toContain(secret);
    const completed = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((record) => record.msg === 'request completed');
    expect(completed?.req).toMatchObject({
      id: 'probe-1',
      method: 'POST',
      url: '/tg/webhook/***',
    });
    expect(completed?.service).toBe('api');
  });
});
