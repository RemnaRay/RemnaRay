import { Buffer } from 'node:buffer';

import { describe, expect, it } from 'vitest';

import { loadEnv } from './env.js';

const valid = {
  RR_DOMAIN: 'shop.example.com',
  RR_ACME_EMAIL: 'owner@example.com',
  RR_PROXY_PROFILE: 'nginx',
  RR_TLS_MODE: 'acme',
  RR_APP_KEY: Buffer.alloc(32, 7).toString('base64'),
  RR_SETUP_TOKEN: 'setup-token',
  RR_INTERNAL_TOKEN: 'internal-token',
  POSTGRES_PASSWORD: 'database-password',
};

describe('loadEnv', () => {
  it('loads required values and safe defaults', () => {
    const result = loadEnv(valid);
    expect(result.RR_PROXY_PROFILE).toBe('nginx');
    expect(result.POSTGRES_USER).toBe('remnaray');
    expect(result.VALKEY_URL).toBe('redis://valkey:6379/0');
    expect(result.RR_API_DOCS).toBe(false);
    expect(result.RR_PAYMENTS_MOCK).toBe(false);
  });

  it('requires ACME email only for ACME mode', () => {
    expect(() => loadEnv({ ...valid, RR_ACME_EMAIL: undefined })).toThrow('RR_ACME_EMAIL');
    expect(loadEnv({ ...valid, RR_ACME_EMAIL: undefined, RR_TLS_MODE: 'custom' }).RR_TLS_MODE).toBe(
      'custom',
    );
  });

  it('pairs each TLS mode with the profiles that can serve it', () => {
    // Section 21.7: `none` means RemnaRay terminates no TLS at all.
    expect(() => loadEnv({ ...valid, RR_TLS_MODE: 'none' })).toThrow('RR_TLS_MODE');
    // Section 21.4: Caddy issues and renews its own certificates.
    expect(() => loadEnv({ ...valid, RR_PROXY_PROFILE: 'caddy', RR_TLS_MODE: 'certbot' })).toThrow(
      'RR_TLS_MODE',
    );
    expect(loadEnv({ ...valid, RR_TLS_MODE: 'certbot' }).RR_TLS_MODE).toBe('certbot');
    expect(
      loadEnv({ ...valid, RR_PROXY_PROFILE: 'caddy', RR_TLS_MODE: 'custom' }).RR_TLS_MODE,
    ).toBe('custom');
  });

  it('rejects TLS with an external proxy', () => {
    expect(() => loadEnv({ ...valid, RR_PROXY_PROFILE: 'external' })).toThrow('RR_TLS_MODE');
    expect(
      loadEnv({ ...valid, RR_PROXY_PROFILE: 'external', RR_TLS_MODE: 'none' }).RR_PROXY_PROFILE,
    ).toBe('external');
  });

  it('does not include secret values in validation errors', () => {
    expect(() => loadEnv({ ...valid, RR_APP_KEY: '' })).toThrow('RR_APP_KEY');
    expect(() => loadEnv({ ...valid, RR_APP_KEY: '' })).not.toThrow('database-password');
  });

  // R67: the key is AES-256-GCM's (section 17.1 p. 4): 32 bytes, base64. A
  // shorter or longer one passed and failed later, at the first secret.
  it('accepts only a base64 key of 32 bytes', () => {
    expect(() => loadEnv({ ...valid, RR_APP_KEY: 'a'.repeat(40) })).toThrow('RR_APP_KEY');
    expect(() => loadEnv({ ...valid, RR_APP_KEY: Buffer.alloc(16).toString('base64') })).toThrow(
      'RR_APP_KEY',
    );
    expect(() => loadEnv({ ...valid, RR_APP_KEY: `${valid.RR_APP_KEY}!` })).toThrow('RR_APP_KEY');
  });

  // compose hands an empty `.env` line to the process as ''; that is unset.
  it('takes an empty value as unset', () => {
    const result = loadEnv({
      ...valid,
      RR_BACKUP_S3_ENDPOINT: '',
      RR_BACKUP_S3_BUCKET: '',
      DATABASE_URL: '',
      RR_TLS_MODE: 'custom',
      RR_ACME_EMAIL: '',
    });
    expect(result.RR_BACKUP_S3_ENDPOINT).toBeUndefined();
    expect(() => loadEnv({ ...valid, RR_DOMAIN: '' })).toThrow('RR_DOMAIN');
  });

  // Section 17.2: DATABASE_URL overrides the connection for an external
  // database, and the application then never uses POSTGRES_PASSWORD.
  it('needs POSTGRES_PASSWORD only without DATABASE_URL', () => {
    expect(() => loadEnv({ ...valid, POSTGRES_PASSWORD: undefined })).toThrow('POSTGRES_PASSWORD');
    expect(
      loadEnv({
        ...valid,
        POSTGRES_PASSWORD: undefined,
        DATABASE_URL: 'postgresql://u:p@db.example.com:5432/shop',
      }).DATABASE_URL,
    ).toBe('postgresql://u:p@db.example.com:5432/shop');
  });

  it('names every variable at fault and why, never a value', () => {
    try {
      loadEnv({ ...valid, RR_APP_KEY: 'secret-key-value', RR_ACME_EMAIL: undefined });
      expect.unreachable();
    } catch (error) {
      const message = String(error);
      expect(message).toContain('RR_APP_KEY');
      expect(message).toContain('RR_ACME_EMAIL (required when RR_TLS_MODE=acme)');
      expect(message).not.toContain('secret-key-value');
    }
  });
});
