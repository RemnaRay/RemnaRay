import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import Redis from 'ioredis';
import { metricsContentType, metricsText } from '@remnaray/metrics';
import { ApiClient } from './api-client.js';
import { createBot, registerCommands, type BotRuntime } from './bot.js';
import { BotIngress, SUPPORT_CHANNEL } from './ingress.js';
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

function configure(): Promise<void> {
  configuring = configuring
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
      await configureSupport(config, runtime);
    })
    .catch(() => {
      ready = false;
      console.error('Bot configuration unavailable; retrying');
    });
  return configuring;
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
        ingress: new BotIngress(runtime.bot, redis, `support-${randomUUID()}`, SUPPORT_CHANNEL),
      };
    }
    await support.ingress.start({
      mode: config.mode,
      webhookUrl: wanted.webhookUrl,
      secretToken: wanted.secretToken,
    });
    supportReady = true;
  } catch {
    supportReady = false;
    console.error('Support bot configuration unavailable; retrying');
  }
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
  if (!ready || !supportReady) void configure();
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
