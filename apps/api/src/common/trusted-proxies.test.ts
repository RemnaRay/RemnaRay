import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { trustedProxies } from './trusted-proxies';

async function ipSeenBy(trustProxy: string | false, remoteAddress: string): Promise<string> {
  const app = Fastify({ trustProxy });
  app.get('/whoami', (request) => ({ ip: request.ip, protocol: request.protocol }));
  try {
    const response = await app.inject({
      method: 'GET',
      url: '/whoami',
      remoteAddress,
      headers: { 'x-forwarded-for': '9.9.9.9', 'x-forwarded-proto': 'https' },
    });
    return response.json<{ ip: string }>().ip;
  } finally {
    await app.close();
  }
}

describe('trustedProxies (section 21.7)', () => {
  it('builds Fastify`s list, and trusts nobody when nothing is configured', () => {
    expect(trustedProxies('172.28.0.0/16')).toBe('172.28.0.0/16');
    expect(trustedProxies(' 127.0.0.1/32 , 10.0.0.0/8 ')).toBe('127.0.0.1/32,10.0.0.0/8');
    expect(trustedProxies('')).toBe(false);
    expect(trustedProxies(undefined)).toBe(false);
  });

  it('keeps the source address when a forged header comes from outside the list', async () => {
    const trusted = trustedProxies('172.28.0.0/16');

    // The acceptance of TASK-M5-005: a request from outside the trusted
    // network cannot pass itself off as another address.
    expect(await ipSeenBy(trusted, '203.0.113.7')).toBe('203.0.113.7');
    // From inside it, the header is the proxy telling us who the client is.
    expect(await ipSeenBy(trusted, '172.28.0.10')).toBe('9.9.9.9');
    // With nothing configured, no header is believed at all.
    expect(await ipSeenBy(trustedProxies(''), '172.28.0.10')).toBe('172.28.0.10');
  });
});

describe('behind the external edge (R25)', () => {
  // The owner's proxy on the host appends the visitor, the published port
  // reaches `edge` from the compose gateway, and `edge` appends that.
  async function behindEdge(list: string): Promise<string> {
    const app = Fastify({ trustProxy: trustedProxies(list) });
    app.get('/whoami', (request) => ({ ip: request.ip }));
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/whoami',
        remoteAddress: '172.28.1.5',
        headers: { 'x-forwarded-for': '203.0.113.7, 172.28.0.1' },
      });
      return response.json<{ ip: string }>().ip;
    } finally {
      await app.close();
    }
  }

  it('finds the visitor with the compose network trusted', async () => {
    expect(await behindEdge('172.28.0.0/16')).toBe('203.0.113.7');
    expect(await behindEdge('172.28.0.0/16,127.0.0.1/32')).toBe('203.0.113.7');
  });

  it('sees only the edge without it', async () => {
    expect(await behindEdge('127.0.0.1/32')).toBe('172.28.1.5');
  });
});
