import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { requestId } from '@remnaray/logger';
import { Logger } from 'nestjs-pino';

import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ genReqId: requestId }),
    {
      bufferLogs: true,
    },
  );

  app.useLogger(app.get(Logger));
  await app.listen(Number(process.env.PORT ?? 3003), '0.0.0.0');
}

void bootstrap();
