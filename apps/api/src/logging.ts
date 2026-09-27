import { httpLoggerOptions, type DestinationStream } from '@remnaray/logger';
import type { Params } from 'nestjs-pino';

/** Request logging of the API (section 19.6). */
export function loggerParams(destination?: DestinationStream): Params {
  const options = httpLoggerOptions({ service: 'api', level: process.env.RR_LOG_LEVEL });
  return { pinoHttp: destination ? [options, destination] : options };
}
