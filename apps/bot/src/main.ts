import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import Redis from 'ioredis';
import { metricsContentType, metricsText } from '@remnaray/metrics';
import { ApiClient } from './api-client.js';
import { createBot, registerCommands, type BotRuntime } from './bot.js';
import { BotIngress, supportChannel } from './ingress.js';
import { createSupportBot, type SupportContext, type SupportRuntime } from './support-bot.js';
import type { BotConfig } from './types.js';

const redisUrl = process.env.VALKEY_URL ?? 'redis://valkey:6379/0';
const api = new ApiClient();
const subscriber = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });
let runtime: BotRuntime | undefined;
let ingress: BotIngress | undefined;
let activeToken: string | undefined;
/** The optional support bot (F35), run beside the shop bot. */
let support:
  | { token: string; runtime: SupportRuntime; ingress: BotIngress<SupportContext>; redis: Redis }
  | undefined;
let supportReady = true;
/** Backoff of the support bot's retries: a revoked token must not hammer Telegram. */
let supportFailures = 0;
let supportRetryAt = 0;
let lastConfig: BotConfig | undefined;
/** Runs queued on `configuring`; the timer adds none while one is waiting. */
let queued = 0;
let stopping = false;
let configuring = Promise.resolve();
let ready = false;
// Section 20.2: `/metrics` on `:3002` beside the health check. The port is
// `expose`, never published, so the compose network is the only client.
const server = createServer((request, response) => {
  if (request.url?.split('?')[0] === '/metrics') {
    void metricsText().then(
      (text) => {
        response.writeHead(200, { 'content-type': metricsContentType });
        response.end(text);
      },
      () => {
        response.writeHead(500, { 'content-type': 'text/plain' });
        response.end('metrics unavailable\n');
      },
    );
    return;
  }
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ status: 'ok', service: 'bot', ready }));
});
server.listen(Number(process.env.PORT ?? 3002), '0.0.0.0');

/** Queues `work` after the running configuration, counting it in `queued`. */
function enqueue(work: () => Promise<void>): Promise<void> {
  queued += 1;
  configuring = configuring
    .then(work)
    .catch(() => undefined)
    .finally(() => {
      queued -= 1;
    });
  return configuring;
}

function configure(): Promise<void> {
  return enqueue(() =>
    Promise.resolve()
      .then(async () => {
        if (stopping) return;
        const config = await api.getConfig({ fresh: true });
        if (config.token !== activeToken) {
          await ingress?.stop();
          runtime?.redis.disconnect();
          ingress = undefined;
          runtime = undefined;
          activeToken = undefined;
        }
        if (!config.token) {
          ready = false;
          return;
        }
        runtime ??= createBot({ token: config.token, api });
        ingress ??= new BotIngress(runtime.bot, runtime.redis);
        await registerCommands(runtime.bot, config);
        await ingress.start(config);
        activeToken = config.token;
        ready = true;
        lastConfig = config;
        await configureSupport(config, runtime);
      })
      .catch(() => {
        ready = false;
        console.error('Bot configuration unavailable; retrying');
      }),
  );
}

/** Retries only the support bot: the shop bot is not set up again for it. */
function retrySupport(): Promise<void> {
  return enqueue(async () => {
    if (stopping || !ready || !runtime || !lastConfig) return;
    await configureSupport(lastConfig, runtime);
  });
}
/**
 * Starts, replaces or stops the support bot to match the settings. A bot that
 * is replaced or turned off loses its webhook, so Telegram stops sending its
 * updates here; a failure leaves the shop bot running and is retried.
 */
async function configureSupport(config: BotConfig, shop: BotRuntime): Promise<void> {
  try {
    const wanted = config.supportBot;
    if (support && support.token !== wanted?.token) {
      const old = support;
      support = undefined;
      await old.ingress.stop();
      await old.runtime.bot.api.deleteWebhook({ drop_pending_updates: false }).catch(() => {
        console.error('Support bot webhook not removed');
      });
      // What it had not handled is for a bot that is gone.
      await old.redis.del(supportChannel(botIdOf(old.token)).stream).catch(() => 0);
      old.redis.disconnect();
    }
    if (!wanted) {
      supportReady = true;
      return;
    }
    if (!support) {
      const redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: null });
      const runtime = createSupportBot({ token: wanted.token, api, i18n: shop.i18n, redis });
      support = {
        token: wanted.token,
        runtime,
        redis,
        ingress: new BotIngress(
          runtime.bot,
          redis,
          `support-${randomUUID()}`,
          supportChannel(botIdOf(wanted.token)),
        ),
      };
    }
    await support.ingress.start({
      mode: config.mode,
      webhookUrl: wanted.webhookUrl,
      secretToken: wanted.secretToken,
    });
    supportReady = true;
    supportFailures = 0;
  } catch {
    supportReady = false;
    supportFailures += 1;
    // 2 s, 4 s, 8 s … up to 5 minutes between attempts.
    supportRetryAt = Date.now() + Math.min(300_000, 1000 * 2 ** supportFailures);
    console.error('Support bot configuration unavailable; retrying');
  }
}

function botIdOf(token: string): string {
  return token.split(':')[0] ?? '';
}

subscriber.on('error', () => {
  ready = false;
});
subscriber.on('message', (channel: string) => {
  if (channel === 'rr:i18n.changed') {
    runtime?.i18n.invalidate();
    return;
  }
  void configure();
});
void subscriber
  .subscribe('rr:bot.reconfigure', 'rr:settings.changed', 'rr:i18n.changed')
  .catch(() => {
    console.error('Bot settings subscription unavailable');
  });
void configure();
// Reconcile after missed Pub/Sub messages or an initial API outage.
const timer = setInterval(() => {
  if (queued > 0) return;
  if (!ready) void configure();
  else if (!supportReady && Date.now() >= supportRetryAt) void retrySupport();
}, 2000);

async function shutdown() {
  stopping = true;
  clearInterval(timer);
  await configuring;
  await ingress?.stop();
  await support?.ingress.stop();
  support?.redis.disconnect();
  runtime?.redis.disconnect();
  subscriber.disconnect();
  server.close();
}
process.once('SIGINT', () => {
  void shutdown();
});
process.once('SIGTERM', () => {
  void shutdown();
});
