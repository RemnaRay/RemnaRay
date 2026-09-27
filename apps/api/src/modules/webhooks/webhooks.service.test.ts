import { createHmac } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { metricsText } from '@remnaray/metrics';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Infrastructure } from '../../infra/infra.module';
import type { SettingsService } from '../settings/settings.service';
import { emitWebhook, signature, ulid, type OutgoingEventBody } from './outgoing';
import { WebhooksService, recipientKey } from './webhooks.service';

const event: OutgoingEventBody = {
  id: ulid(Date.parse('2026-09-18T10:00:00Z')),
  type: 'payment.succeeded',
  createdAt: '2026-09-18T10:00:00.000Z',
  data: { userId: 'u-1', telegramId: 123, amountMinor: 29900, currency: 'RUB' },
};

type Received = { headers: IncomingHttpHeaders; body: string };

let server: Server | undefined;

afterEach(async () => {
  await new Promise<void>((resolve) => {
    if (server)
      server.close(() => {
        resolve();
      });
    else resolve();
  });
  server = undefined;
});

/** A recipient on a random local port that answers `status` and records what came. */
async function recipient(status: number, headers: Record<string, string> = {}) {
  const received: Received[] = [];
  server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString()));
    request.on('end', () => {
      received.push({ headers: request.headers, body });
      response.writeHead(status, headers).end('ok');
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${String(port)}/hook`, received };
}

function service(recipients: unknown[]) {
  const created: unknown[] = [];
  const tx = {
    outboxJob: {
      create: vi.fn((row: unknown) => {
        created.push(row);
        return Promise.resolve();
      }),
    },
  };
  const db = { $transaction: vi.fn(async (run: (t: typeof tx) => Promise<void>) => run(tx)) };
  const settings = { get: vi.fn().mockResolvedValue(recipients) };
  return {
    created,
    webhooks: new WebhooksService(
      { db } as unknown as Infrastructure,
      settings as unknown as SettingsService,
    ),
  };
}

async function failures(): Promise<number> {
  const line = (await metricsText())
    .split('\n')
    .find((row) => row.startsWith('rr_outgoing_webhook_failures_total '));
  return Number(line?.split(' ')[1] ?? 0);
}

describe('section 9.8 outgoing webhooks', () => {
  it('sends the event signed with the recipient secret and the three headers', async () => {
    const target = await recipient(204);
    const { webhooks } = service([
      { url: target.url, secret: 's3cret', events: ['payment.succeeded'], enabled: true },
    ]);

    await expect(webhooks.deliver({ event, recipient: recipientKey(target.url) })).resolves.toEqual(
      {
        status: 'delivered',
      },
    );

    const [delivery] = target.received;
    expect(delivery?.body).toBe(JSON.stringify(event));
    const expected = createHmac('sha256', 's3cret')
      .update(delivery?.body ?? '')
      .digest('hex');
    expect(delivery?.headers['x-remnaray-signature']).toBe(`sha256=${expected}`);
    expect(delivery?.headers['x-remnaray-event']).toBe('payment.succeeded');
    expect(delivery?.headers['x-remnaray-delivery']).toBe(event.id);
    expect(delivery?.headers['content-type']).toBe('application/json');
  });

  it.each([
    [500, {}],
    [404, {}],
    // A redirect is not a 2xx and is not followed with the signed body.
    [302, { location: 'http://127.0.0.1:1/elsewhere' }],
  ])('fails the attempt on %i so the job is retried, and counts it', async (status, headers) => {
    const target = await recipient(status, headers);
    const { webhooks } = service([
      { url: target.url, secret: 's', events: ['payment.succeeded'], enabled: true },
    ]);
    const before = await failures();

    await expect(
      webhooks.deliver({ event, recipient: recipientKey(target.url) }),
    ).rejects.toMatchObject({
      status: 502,
    });
    expect(target.received).toHaveLength(1);
    expect(await failures()).toBe(before + 1);
  });

  it('fails an attempt the recipient never answers', async () => {
    const { webhooks } = service([
      { url: 'http://127.0.0.1:1/hook', secret: 's', events: ['payment.succeeded'], enabled: true },
    ]);
    await expect(
      webhooks.deliver({ event, recipient: recipientKey('http://127.0.0.1:1/hook') }),
    ).rejects.toMatchObject({ status: 502 });
  });

  it('skips a recipient removed, disabled or unsubscribed since the event', async () => {
    const target = await recipient(200);
    for (const recipients of [
      [],
      [{ url: target.url, secret: 's', events: ['payment.succeeded'], enabled: false }],
      [{ url: target.url, secret: 's', events: ['user.created'], enabled: true }],
    ]) {
      const { webhooks } = service(recipients);
      await expect(
        webhooks.deliver({ event, recipient: recipientKey(target.url) }),
      ).resolves.toEqual({
        status: 'skipped',
      });
    }
    expect(target.received).toHaveLength(0);
  });

  it('still delivers a job queued with the recipient`s URL before R84', async () => {
    const target = await recipient(200);
    const { webhooks } = service([
      { url: target.url, secret: 's', events: ['payment.succeeded'], enabled: true },
    ]);
    await expect(webhooks.deliver({ event, url: target.url })).resolves.toEqual({
      status: 'delivered',
    });
    expect(target.received).toHaveLength(1);
  });

  it('dispatches one delivery per enabled recipient subscribed to the event', async () => {
    const { webhooks, created } = service([
      { url: 'https://a.example/hook', secret: 'a', events: ['payment.succeeded'], enabled: true },
      { url: 'https://b.example/hook', secret: 'b', events: ['user.created'], enabled: true },
      { url: 'https://c.example/hook', secret: 'c', events: ['payment.succeeded'], enabled: false },
      {
        url: 'https://d.example/hook',
        secret: 'd',
        events: ['user.created', 'payment.succeeded'],
        enabled: true,
      },
    ]);

    await expect(webhooks.dispatch(event)).resolves.toEqual({ recipients: 2 });
    const rows = created as { data: Record<string, unknown> }[];
    // R84: the recipient's URL is a secret setting (it often carries a token),
    // so the outbox row and the BullMQ job name the recipient by a hash.
    expect(rows.map((row) => row.data.payload)).toEqual([
      { event, recipient: recipientKey('https://a.example/hook') },
      { event, recipient: recipientKey('https://d.example/hook') },
    ]);
    expect(recipientKey('https://a.example/hook')).toMatch(/^[0-9a-f]{16}$/u);
    expect(JSON.stringify(rows)).not.toMatch(/a\.example|d\.example/u);
    expect(rows[0]?.data).toMatchObject({ queue: 'webhooks', name: 'webhooks.deliver' });
    expect(rows[0]?.data.jobId).toMatch(new RegExp(`^webhook:${event.id}:[0-9a-f]{16}$`, 'u'));
    expect(rows[0]?.data.jobId).not.toBe(rows[1]?.data.jobId);
  });

  it('refuses a body that is not a section 9.8 event', async () => {
    const { webhooks } = service([]);
    await expect(webhooks.dispatch({ ...event, type: 'user.deleted' })).rejects.toThrow();
  });
});

describe('emitWebhook', () => {
  it('writes the event with the user and the Telegram id in the caller transaction', async () => {
    const create = vi.fn();
    const tx = {
      user: { findUnique: vi.fn().mockResolvedValue({ telegramId: 123n }) },
      outboxJob: { create },
    };
    const now = new Date('2026-09-18T10:00:00Z');

    await emitWebhook(tx as never, 'user.created', 'u-1', { language: 'ru' }, now);

    const row = create.mock.calls[0]?.[0] as { data: { payload: OutgoingEventBody } };
    expect(row.data).toMatchObject({
      queue: 'webhooks',
      name: 'webhooks.dispatch',
      jobId: `webhook:${row.data.payload.id}`,
      payload: {
        type: 'user.created',
        createdAt: '2026-09-18T10:00:00.000Z',
        data: { userId: 'u-1', telegramId: 123, language: 'ru' },
      },
    });
  });
});

describe('the section 9.8 helpers', () => {
  it('makes ULIDs that sort by time', () => {
    const early = ulid(Date.parse('2026-09-18T10:00:00Z'));
    const late = ulid(Date.parse('2026-09-18T10:00:01Z'));
    expect(early).toMatch(/^01[0-9A-HJKMNP-TV-Z]{24}$/u);
    expect(early < late).toBe(true);
  });

  it('signs as sha256=<hex hmac>', () => {
    expect(signature('{}', 'k')).toBe(
      `sha256=${createHmac('sha256', 'k').update('{}').digest('hex')}`,
    );
  });
});
