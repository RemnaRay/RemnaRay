import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { WorkerService } from './worker.service';

type Call = (call: { path: string; body?: unknown }) => Promise<unknown>;

let server: Server | undefined;

/** A stand-in for the internal API answering every call with `status` and `body`. */
async function api(status: number, body: string): Promise<Call> {
  server = createServer((_request, response) => {
    response.writeHead(status, body ? { 'content-type': 'application/json' } : {});
    response.end(body);
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  vi.stubEnv('RR_API_URL', `http://127.0.0.1:${String(port)}`);
  const worker = new WorkerService() as unknown as { call: Call };
  return (call) => worker.call(call);
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await new Promise<void>((resolve) => {
    if (server)
      server.close(() => {
        resolve();
      });
    else resolve();
  });
  server = undefined;
});

describe('WorkerService internal calls (R49)', () => {
  it('completes a call the API answered without a body', async () => {
    // `payments.apply-event` used to fail every attempt after the event had
    // been applied: the empty 201 body broke `response.json()`.
    const call = await api(201, '');
    await expect(call({ path: '/api/internal/v1/payments/events/e/apply' })).resolves.toBeNull();
  });

  it('returns the JSON the API answered with', async () => {
    const call = await api(201, '5');
    await expect(call({ path: '/api/internal/v1/payments/poll-pending' })).resolves.toBe(5);
  });

  it('still fails a call the API refused', async () => {
    const call = await api(500, '{"code":"INTERNAL"}');
    await expect(call({ path: '/api/internal/v1/payments/expire' })).rejects.toThrow(
      /job failed: 500/u,
    );
  });
});
