import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import multipart from '@fastify/multipart';
import { requestId } from '@remnaray/logger';
import { Logger } from 'nestjs-pino';

import { AppModule } from './app.module';
import { trustedProxies } from './common/trusted-proxies';
import { ZodValidationPipe } from './common/zod-validation.pipe';

const port = Number(process.env.PORT ?? 3000);

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    // Section 21.7: `X-Forwarded-*` counts only from `RR_TRUSTED_PROXIES`.
    new FastifyAdapter({ trustProxy: trustedProxies(), genReqId: requestId }),
    {
      bufferLogs: true,
      rawBody: true,
    },
  );

  await app.register(multipart as never, {
    limits: { files: 1, parts: 2, fileSize: 10 * 1024 * 1024 },
  });

  app.useLogger(app.get(Logger));
  app.useGlobalPipes(new ZodValidationPipe());
  await app.listen(port, '0.0.0.0');
}

void bootstrap();
