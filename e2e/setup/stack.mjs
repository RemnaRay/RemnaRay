import { execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer, request as httpRequest } from 'node:http';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import { Buffer } from 'node:buffer';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { GenericContainer } from 'testcontainers';

const HOP_BY_HOP = ['connection', 'keep-alive', 'transfer-encoding', 'upgrade'];

const APP_KEY = Buffer.alloc(32, 11).toString('base64');
const INTERNAL_TOKEN = 'e2e-internal-token';
const BRAND_NAME = 'Manta E2E';
const SETUP_TOKEN = 'e2e-setup-token';
const BOT_TOKEN = '4242:e2e-setup-bot-token';

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => {
        resolve(port);
      });
    });
    server.on('error', reject);
  });
}

async function waitFor(url, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await globalThis.fetch(url);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

/**
 * Minimal stand-in for the deployment's reverse proxy: `/api` and `/webhooks`
 * go to the API, everything else to `web`. The browser therefore sees one
 * origin, exactly as it does behind nginx or Caddy.
 */
function startProxy(port, apiPort, webPort) {
  const server = createServer((request, response) => {
    const toApi =
      request.url?.startsWith('/api/v1') ||
      request.url?.startsWith('/api/admin') ||
      request.url?.startsWith('/api/internal') ||
      request.url?.startsWith('/api/setup') ||
      request.url?.startsWith('/webhooks');
    const target = toApi ? apiPort : webPort;
    const upstream = httpRequest(
      {
        host: '127.0.0.1',
        port: target,
        method: request.method,
        path: request.url,
        headers: {
          ...Object.fromEntries(
            Object.entries(request.headers).filter(([key]) => !HOP_BY_HOP.includes(key)),
          ),
          host: `127.0.0.1:${String(target)}`,
        },
      },
      (upstreamResponse) => {
        // Hop-by-hop headers belong to the upstream connection, not to ours.
        const headers = Object.fromEntries(
          Object.entries(upstreamResponse.headers).filter(([key]) => !HOP_BY_HOP.includes(key)),
        );
        response.writeHead(upstreamResponse.statusCode ?? 502, headers);
        upstreamResponse.pipe(response, { end: true });
      },
    );
    upstream.on('error', () => {
      response.statusCode = 502;
      response.end('bad gateway');
    });
    request.pipe(upstream, { end: true });
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve(server);
    });
  });
}

/**
 * `seed: false` boots the same stack with an empty database and
 * `RR_SETUP_TOKEN` set, which is what AC-171 needs: the wizard is only
 * reachable while `setup.completed` is false (section 17.4).
 */
export async function startStack({ seed = true } = {}) {
  const postgres = await new PostgreSqlContainer('postgres:18-alpine')
    .withDatabase('remnaray')
    .withUsername('remnaray')
    .withPassword('remnaray')
    .start();
  const valkey = await new GenericContainer('valkey/valkey:9.1-alpine')
    .withExposedPorts(6379)
    .start();

  const databaseUrl = postgres.getConnectionUri();
  const valkeyUrl = `redis://${valkey.getHost()}:${String(valkey.getMappedPort(6379))}/0`;

  execFileSync('pnpm', ['--filter', '@remnaray/db', 'db:migrate:deploy'], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'pipe',
  });

  // The seeded shop talks to the panel mock too: the console's plan form
  // loads the panel's squads (FR-145).
  const mocks = await startMocks();
  const fixtures = seed
    ? await seedFixtures(databaseUrl, mocks.panelUrl)
    : { setupToken: SETUP_TOKEN };

  const apiPort = await freePort();
  const webPort = await freePort();
  const proxyPort = await freePort();

  // F29: Telegram's OIDC keys, served locally so the specs can sign an
  // id_token the API verifies exactly as it would Telegram's.
  const oidc = await startOidcKeys();

  const apiEnv = {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(apiPort),
    DATABASE_URL: databaseUrl,
    VALKEY_URL: valkeyUrl,
    RR_APP_KEY: APP_KEY,
    RR_INTERNAL_TOKEN: INTERNAL_TOKEN,
    // Section 17.2 (R67): the API checks the environment at start; the
    // default TLS mode, `acme`, needs the contact address.
    RR_ACME_EMAIL: 'ops@example.test',
    RR_SETUP_TOKEN: SETUP_TOKEN,
    RR_TRUSTED_INTERNAL_CIDR: '127.0.0.0/8',
    RR_DOMAIN: `127.0.0.1:${String(proxyPort)}`,
    RR_LOG_LEVEL: 'warn',
    // Section 22.1: the E2E purchase pays through the mock provider.
    RR_PAYMENTS_MOCK: 'true',
    RR_TELEGRAM_OAUTH_URL: oidc.url,
    ...(seed ? {} : { RR_TELEGRAM_API_URL: mocks.telegramUrl }),
  };
  const api = spawn('node', ['apps/api/dist/main.js'], { env: apiEnv, stdio: 'pipe' });
  const apiLog = [];
  for (const stream of [api.stdout, api.stderr])
    stream.on('data', (chunk) => {
      apiLog.push(String(chunk));
      if (process.env.RR_E2E_VERBOSE) process.stderr.write(chunk);
    });
  api.on('exit', (code) => {
    if (code !== 0 && code !== null)
      process.stderr.write(`API exited with ${String(code)}:\n${apiLog.join('')}`);
  });
  try {
    await waitFor(`http://127.0.0.1:${String(apiPort)}/api/v1/health`);
  } catch (error) {
    process.stderr.write(apiLog.join(''));
    throw error;
  }

  // Next's standalone output ships the server but not `.next/static`; the web
  // image copies it in, and so does the harness.
  const standalone = resolve(process.cwd(), 'apps/web/.next/standalone/apps/web');
  cpSync(resolve(process.cwd(), 'apps/web/.next/static'), resolve(standalone, '.next/static'), {
    recursive: true,
  });
  if (existsSync(resolve(process.cwd(), 'apps/web/public')))
    cpSync(resolve(process.cwd(), 'apps/web/public'), resolve(standalone, 'public'), {
      recursive: true,
    });

  const web = spawn('node', ['apps/web/.next/standalone/apps/web/server.js'], {
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(webPort),
      HOSTNAME: '127.0.0.1',
      INTERNAL_API_URL: `http://127.0.0.1:${String(apiPort)}`,
      RR_DOMAIN: `127.0.0.1:${String(proxyPort)}`,
      RR_THEMES_DIR: `${process.cwd()}/themes`,
      RR_LOCALES_DIR: `${process.cwd()}/locales`,
    },
    stdio: 'pipe',
  });
  web.stderr.on('data', (chunk) => {
    if (process.env.RR_E2E_VERBOSE) process.stderr.write(chunk);
  });
  await waitFor(`http://127.0.0.1:${String(webPort)}/api/healthz`);

  const proxy = await startProxy(proxyPort, apiPort, webPort);
  await waitFor(`http://127.0.0.1:${String(proxyPort)}/api/v1/health`);
  const base = `http://127.0.0.1:${String(proxyPort)}`;
  if (seed) for (const locale of ['ru', 'en']) await waitForFreshPage(`${base}/${locale}`);

  return {
    baseURL: base,
    internalToken: INTERNAL_TOKEN,
    brand: { name: BRAND_NAME },
    apiUrl: `http://127.0.0.1:${String(apiPort)}`,
    ...(seed
      ? {}
      : { panelUrl: mocks.panelUrl, telegramUrl: mocks.telegramUrl, botToken: mocks.botToken }),
    ...fixtures,
    oidcPrivateKey: oidc.privateKeyPem,
    async stop() {
      oidc.server.close();
      proxy.close();
      api.kill('SIGTERM');
      web.kill('SIGTERM');
      await sleep(500);
      await mocks.stop();
      await valkey.stop();
      await postgres.stop();
    },
  };
}

/** An RS256 key under kid `oidc-1`, published at `/.well-known/jwks.json`. */
async function startOidcKeys() {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwks = JSON.stringify({
    keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'oidc-1', alg: 'RS256' }],
  });
  const server = createServer((request, response) => {
    if (request.url === '/.well-known/jwks.json') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(jwks);
      return;
    }
    response.writeHead(404);
    response.end();
  });
  const port = await freePort();
  await new Promise((done) => server.listen(port, '127.0.0.1', done));
  return {
    server,
    url: `http://127.0.0.1:${String(port)}`,
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
}

/** Section 25.6 asks AC-171 to run against mocks, not a real panel or Telegram. */
async function startMocks() {
  const { createRemnawaveMock } = await import('../../packages/remnawave-mock/dist/index.js');
  const { TelegramMock } = await import('../../packages/telegram-mock/dist/index.js');
  const panel = createRemnawaveMock();
  const panelUrl = await panel.listen({ port: 0, host: '127.0.0.1' });
  const telegram = new TelegramMock({
    token: BOT_TOKEN,
    user: { id: 4242, first_name: 'Manta Setup', username: 'manta_setup_bot' },
  });
  const telegramUrl = await telegram.start();
  return {
    panelUrl,
    telegramUrl,
    botToken: BOT_TOKEN,
    async stop() {
      await panel.close();
      await telegram.stop();
    },
  };
}

/**
 * The landing pages are prerendered at build time, when no API is reachable, so
 * the first visitor is served that build output while Next.js regenerates the
 * page in the background. Request the page until it carries the seeded brand,
 * so the specs always see the regenerated content.
 */
async function waitForFreshPage(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await globalThis.fetch(url, { headers: { 'cache-control': 'no-cache' } });
    if (response.ok && (await response.text()).includes(BRAND_NAME)) return;
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${url} to serve the seeded content`);
}

async function seedFixtures(databaseUrl, panelUrl) {
  const { createPrismaClient } = await import('../../packages/db/dist/index.js');
  const { hashAdminPassword, encryptTotpSecret, createTotp } =
    await import('../../apps/api/dist/modules/admin/admin.crypto.js');
  const { encryptSetting } =
    await import('../../apps/api/dist/modules/settings/settings.crypto.js');
  const prisma = createPrismaClient(databaseUrl);
  const password = 'E2ePassword123';
  const totp = createTotp('owner@example.test');

  const admin = await prisma.admin.create({
    data: {
      email: 'owner@example.test',
      passwordHash: await hashAdminPassword(password),
      role: 'admin',
      totpEnabled: true,
      totpSecretEnc: encryptTotpSecret(totp.secret.base32, APP_KEY),
    },
  });

  const plan = await prisma.plan.create({
    data: {
      slug: 'e2e-month',
      name: { ru: 'Месяц', en: 'Month' },
      description: { ru: 'Месяц доступа', en: 'A month of access' },
      durationDays: 30,
      trafficLimitBytes: 0n,
      deviceLimit: 3,
      squads: ['01a0b9f0-e699-7032-9841-6d516d4591ad'],
      priceMinor: 29900n,
      isPublic: true,
      isActive: true,
      sortOrder: 10,
    },
  });

  // A second plan: the plan change of F37 needs another plan to change to.
  await prisma.plan.create({
    data: {
      slug: 'e2e-quarter',
      name: { ru: 'Квартал', en: 'Quarter' },
      description: { ru: 'Три месяца доступа', en: 'Three months of access' },
      durationDays: 90,
      trafficLimitBytes: 0n,
      deviceLimit: 5,
      squads: ['01a0b9f0-e699-7032-9841-6d516d4591ad'],
      priceMinor: 79900n,
      isPublic: true,
      isActive: true,
      sortOrder: 20,
    },
  });

  // Section 15.5: a code the plans page previews.
  await prisma.promocode.create({
    data: { code: 'E2E10', type: 'discount_percent', value: 10n, maxUses: 100 },
  });

  await prisma.paymentProvider.create({
    data: {
      code: 'mock',
      enabled: true,
      displayName: { ru: 'Тест', en: 'Mock' },
      sortOrder: 10,
      lastHealthcheckAt: new Date(),
      lastHealthcheckOk: true,
    },
  });

  const botToken = `${String(randomBytes(4).readUInt32BE(0))}:${createHash('sha256').update('e2e').digest('hex').slice(0, 20)}`;
  await prisma.setting.createMany({
    data: [
      // Section 17.4: without this every route answers SETUP_NOT_COMPLETED.
      { key: 'setup.completed', value: true, isSecret: false },
      { key: 'brand.name', value: BRAND_NAME, isSecret: false },
      { key: 'bot.username', value: 'manta_e2e_bot', isSecret: false },
      { key: 'bot.token', value: encryptSetting(botToken, APP_KEY), isSecret: true },
      { key: 'trial.enabled', value: true, isSecret: false },
      { key: 'domain.main', value: 'example.test', isSecret: false },
      { key: 'panel.base_url', value: panelUrl, isSecret: false },
      { key: 'panel.api_token', value: encryptSetting('e2e-panel-token', APP_KEY), isSecret: true },
    ],
    skipDuplicates: true,
  });

  const user = await prisma.user.create({
    data: {
      telegramId: 998000001n,
      username: 'e2euser',
      firstName: 'E2E',
      language: 'ru',
      referralCode: 'E2EUSER1',
    },
  });
  await prisma.account.create({
    data: { kind: 'user', userId: user.id, currency: 'RUB', balanceMinor: 50_000n },
  });

  await prisma.$disconnect();
  return {
    botToken,
    admin: { email: admin.email, password, totpSecret: totp.secret.base32 },
    plan: { id: plan.id, slug: plan.slug, name: plan.name.ru },
    user: {
      id: user.id,
      telegramId: user.telegramId.toString(),
      username: user.username,
      firstName: user.firstName,
    },
  };
}
