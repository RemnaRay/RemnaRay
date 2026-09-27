import { Writable } from 'node:stream';

import { Controller, Get, Logger as NestLogger, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Logger, LoggerModule } from 'nestjs-pino';
import { afterEach, describe, expect, it } from 'vitest';

import { loggerParams } from './logging';

@Controller('health')
class ProbeController {
  private readonly logger = new NestLogger('ProbeController');

  @Get()
  health() {
    this.logger.warn('inside handler');
    return { ok: true };
  }
}

let app: NestFastifyApplication | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('worker request logging (section 19.6, R4)', () => {
  it('writes no cookie, internal token or query string', async () => {
    const lines: string[] = [];
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        lines.push(String(chunk));
        callback();
      },
    });

    @Module({
      imports: [LoggerModule.forRoot(loggerParams(destination))],
      controllers: [ProbeController],
    })
    // eslint-disable-next-line @typescript-eslint/no-extraneous-class
    class LoggedModule {}

    app = await NestFactory.create<NestFastifyApplication>(LoggedModule, new FastifyAdapter(), {
      logger: false,
    });
    app.useLogger(app.get(Logger));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    const response = await app.inject({
      method: 'GET',
      url: '/health?token=SIGNINJWT',
      headers: { cookie: 'rr_sid=USERSESSION', 'x-internal-token': 'INTERNALTOKEN' },
    });
    expect(response.statusCode).toBe(200);

    const output = lines.join('');
    expect(output).toContain('inside handler');
    expect(output).toContain('request completed');
    for (const secret of ['USERSESSION', 'INTERNALTOKEN', 'SIGNINJWT'])
      expect(output, secret).not.toContain(secret);
    const completed = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((record) => record.msg === 'request completed');
    expect(completed?.service).toBe('worker');
  });
});
