import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { GenericContainer } from 'testcontainers';

const listen = (server) =>
  new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

/**
 * Section 9.8 on a real PostgreSQL and Valkey: the events are written in the
 * transactions that cause them, the worker fans an event out to the
 * subscribed recipient, signs the delivery, and retries a failed one after the
 * first 9.8 delay.
 */
test('M4 outgoing webhooks are emitted, signed and retried', { timeout: 240_000 }, async () => {
  const [postgres, valkey] = await Promise.all([
    new PostgreSqlContainer('postgres:18-alpine')
      .withDatabase('remnaray')
      .withUsername('remnaray')
      .withPassword('remnaray')
      .start(),
    new GenericContainer('valkey/valkey:9.1-alpine').withExposedPorts(6379).start(),
  ]);
  const databaseUrl = postgres.getConnectionUri();
  const valkeyUrl = `redis://${valkey.getHost()}:${String(valkey.getMappedPort(6379))}/0`;
  const previous = { ...process.env };
  const servers = [];
  let prisma;
  let worker;
  let relay;
  let redis;
  try {
    execFileSync('pnpm', ['--filter', '@remnaray/db', 'db:migrate:deploy'], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
    });
    const { createPrismaClient } = await import('../packages/db/dist/index.js');
    const { createRedisConnection, OutboxRelay, QUEUE_PREFIX } =
      await import('../packages/queues/dist/index.js');
    const { PaymentsRepository } =
      await import('../apps/api/dist/modules/payments/payments.repository.js');
    const { PaymentsService } =
      await import('../apps/api/dist/modules/payments/payments.service.js');
    const { PaymentProviderRegistry } =
      await import('../apps/api/dist/modules/payments/payments.registry.js');
    const { UsersRepository } = await import('../apps/api/dist/modules/users/users.repository.js');
    const { SubscriptionsRepository } =
      await import('../apps/api/dist/modules/subscriptions/subscriptions.repository.js');
    const { WebhooksService } =
      await import('../apps/api/dist/modules/webhooks/webhooks.service.js');
    const { MockPaymentProvider } = await import('../packages/payments-mock/dist/index.js');
    const { BalanceProvider } =
      await import('../apps/api/dist/modules/payments/builtin-providers.js');
    prisma = createPrismaClient(databaseUrl);
    const registry = new PaymentProviderRegistry();
    registry.register(new MockPaymentProvider());
    registry.register(new BalanceProvider());
    const repository = new PaymentsRepository(prisma);
    const payments = new PaymentsService({ db: prisma }, repository, registry);

    // --- the events, each in the transaction that causes it ---
    const { user } = await new UsersRepository(prisma).upsert(
      { telegramId: 993000001n, username: 'hooked', languageCode: 'ru' },
      {},
      'ru',
    );
    const plan = await prisma.plan.create({
      data: {
        slug: 'm4-hooks',
        name: { ru: 'M4', en: 'M4' },
        durationDays: 30,
        squads: ['01a0b9f0-e699-7032-9841-6d516d4591ad'],
        priceMinor: 29900n,
      },
    });
    // F37: the price is topped up through the provider, and the plan is
    // bought from the balance; each is a `payment.succeeded` of its own.
    const topupInvoice = await payments.createInvoice({
      userId: user.id,
      kind: 'topup',
      provider: 'mock',
      amountMinor: 29900n,
      idempotencyKey: 'm4-hooks-topup',
      target: { planId: plan.id, kind: 'purchase' },
    });
    const body = JSON.stringify({
      eventId: 'hooks-paid-1',
      providerInvoiceId: topupInvoice.providerInvoiceId,
      type: 'paid',
      paidAmountMinorRub: '29900',
    });
    await payments.receiveWebhook(
      'mock',
      Buffer.from(body),
      { 'x-mock-signature': createHmac('sha256', 'mock-secret').update(body).digest('hex') },
      '127.0.0.1',
    );
    const topup = await prisma.transaction.findFirstOrThrow({
      where: { invoiceId: topupInvoice.id },
    });
    const invoice = await payments.createInvoice({
      userId: user.id,
      kind: 'purchase',
      planId: plan.id,
      provider: 'balance',
      idempotencyKey: 'm4-hooks-paid',
    });
    const purchase = await prisma.transaction.findFirstOrThrow({
      where: { invoiceId: invoice.id },
    });
    await repository.refund(purchase.id, 10000n, 'partial');
    const subscription = await prisma.subscription.findFirstOrThrow({
      where: { userId: user.id },
    });
    await prisma.subscription.update({
      where: { id: subscription.id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
    assert.equal(await new SubscriptionsRepository(prisma).expire(new Date()), 1);

    const dispatched = await prisma.outboxJob.findMany({
      where: { name: 'webhooks.dispatch' },
      orderBy: { createdAt: 'asc' },
    });
    assert.deepEqual(
      dispatched.map((row) => row.payload.type),
      [
        'user.created',
        'payment.succeeded',
        'subscription.activated',
        'payment.succeeded',
        'payment.refunded',
        'subscription.expired',
      ],
    );
    for (const row of dispatched) {
      assert.equal(row.queue, 'webhooks');
      assert.equal(row.jobId, `webhook:${row.payload.id}`);
      assert.match(row.payload.id, /^[0-9A-HJKMNP-TV-Z]{26}$/u);
      assert.equal(row.payload.data.userId, user.id);
      assert.equal(row.payload.data.telegramId, 993000001);
    }
    const byType = Object.fromEntries(dispatched.map((row) => [row.payload.type, row.payload]));
    const [toppedUp, bought] = dispatched
      .filter((row) => row.payload.type === 'payment.succeeded')
      .map((row) => row.payload);
    assert.deepEqual(toppedUp.data, {
      userId: user.id,
      telegramId: 993000001,
      transactionId: topup.id,
      invoiceId: topupInvoice.id,
      type: 'topup',
      amountMinor: 29900,
      currency: 'RUB',
      provider: 'mock',
      planId: null,
    });
    assert.deepEqual(bought.data, {
      userId: user.id,
      telegramId: 993000001,
      transactionId: purchase.id,
      invoiceId: invoice.id,
      type: 'purchase',
      amountMinor: 29900,
      currency: 'RUB',
      provider: 'balance',
      planId: plan.id,
    });
    assert.equal(byType['payment.refunded'].data.amountMinor, 10000);
    assert.equal(byType['payment.refunded'].data.refundedTransactionId, purchase.id);
    assert.equal(byType['subscription.expired'].data.subscriptionId, subscription.id);
    assert.equal(byType['subscription.expired'].data.status, 'expired');

    // --- delivery through the worker, to a recipient that fails the
    // purchase's first delivery once ---
    const deliveries = [];
    const typeOf = (delivery) => JSON.parse(delivery.body).data.type;
    const recipient = createServer((request, response) => {
      let text = '';
      request.on('data', (chunk) => (text += chunk.toString()));
      request.on('end', () => {
        deliveries.push({ headers: request.headers, body: text });
        response.statusCode =
          typeOf({ body: text }) === 'purchase' &&
          deliveries.filter((delivery) => typeOf(delivery) === 'purchase').length === 1
            ? 500
            : 200;
        response.end();
      });
    });
    servers.push(recipient);
    const recipientUrl = `http://127.0.0.1:${String(await listen(recipient))}/hook`;
    const settings = {
      get: async () => [
        { url: recipientUrl, secret: 'whsec', events: ['payment.succeeded'], enabled: true },
      ],
    };
    const webhooks = new WebhooksService({ db: prisma }, settings);
    const api = createServer((request, response) => {
      let text = '';
      request.on('data', (chunk) => (text += chunk.toString()));
      request.on('end', () => {
        const route = {
          '/api/internal/v1/webhooks/dispatch': (value) => webhooks.dispatch(value),
          '/api/internal/v1/webhooks/deliver': (value) => webhooks.deliver(value),
        }[request.url];
        response.setHeader('content-type', 'application/json');
        if (!route) return response.end('{}');
        route(JSON.parse(text)).then(
          (result) => response.end(JSON.stringify(result)),
          () => {
            response.statusCode = 502;
            response.end('{}');
          },
        );
      });
    });
    servers.push(api);
    process.env.VALKEY_URL = valkeyUrl;
    process.env.RR_API_URL = `http://127.0.0.1:${String(await listen(api))}`;
    process.env.RR_INTERNAL_TOKEN = 'internal-token';
    process.env.RR_BACKUP_DIR = mkdtempSync(join(tmpdir(), 'rr-backups-'));
    delete process.env.RR_DOMAIN;
    redis = createRedisConnection(valkeyUrl);
    relay = new OutboxRelay(prisma, redis);
    const until = async (predicate, what) => {
      for (let waited = 0; waited < 30_000; waited += 100) {
        if (await predicate()) return;
        await delay(100);
      }
      assert.fail(`timed out waiting for ${what}`);
    };

    const { WorkerService } = await import('../apps/worker/dist/queues/worker.service.js');
    worker = new WorkerService();
    await worker.onModuleInit();
    await relay.runOnce();
    // Only the recipient's events fan out to deliveries: the top-up's and
    // the purchase's `payment.succeeded`.
    await until(
      async () => (await prisma.outboxJob.count({ where: { name: 'webhooks.deliver' } })) === 2,
      'the payment.succeeded deliveries',
    );
    await relay.runOnce();
    await until(() => deliveries.length === 2, 'the first attempts');

    const { Queue } = await import('../apps/worker/node_modules/bullmq/dist/cjs/index.js');
    const queue = new Queue('webhooks', { connection: redis, prefix: QUEUE_PREFIX });
    let retry;
    await until(async () => {
      [retry] = await queue.getDelayed();
      return retry !== undefined;
    }, 'the retry to be scheduled');
    assert.equal(retry.name, 'webhooks.deliver');
    assert.equal(retry.attemptsMade, 1);
    assert.equal(retry.opts.attempts, 6);
    // Section 9.8: the first retry one minute later.
    assert.equal(retry.delay, 60_000);
    await retry.promote();
    await until(() => deliveries.length === 3, 'the retried attempt');
    await until(
      async () => (await queue.getJobCounts('completed')).completed >= 8,
      'every webhooks job to complete',
    );
    await queue.close();

    assert.deepEqual(
      deliveries
        .filter((delivery) => typeOf(delivery) === 'topup')
        .map((delivery) => JSON.parse(delivery.body)),
      [toppedUp],
    );
    const [first, second] = deliveries.filter((delivery) => typeOf(delivery) === 'purchase');
    assert.equal(second.body, first.body, 'a retry sends the same body');
    const event = JSON.parse(second.body);
    assert.deepEqual(event, bought);
    assert.equal(
      second.headers['x-remnaray-signature'],
      `sha256=${createHmac('sha256', 'whsec').update(second.body).digest('hex')}`,
    );
    assert.equal(second.headers['x-remnaray-event'], 'payment.succeeded');
    assert.equal(second.headers['x-remnaray-delivery'], event.id);
  } finally {
    await worker?.onModuleDestroy();
    await relay?.close();
    await redis?.quit().catch(() => undefined);
    for (const server of servers) server.close();
    await prisma?.$disconnect();
    process.env = previous;
    await Promise.all([postgres.stop(), valkey.stop()]);
  }
});
