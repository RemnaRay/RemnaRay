import { Buffer } from 'node:buffer';
import process, { env as processEnv } from 'node:process';

import { z } from 'zod';

const booleanFromEnv = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

/** Section 17.1 p. 4: the AES-256-GCM key, base64 of exactly 32 bytes. */
const appKey = z
  .string()
  .regex(/^[A-Za-z0-9+/]+={0,2}$/u, 'must be base64')
  .refine((value) => Buffer.from(value, 'base64').length === 32, 'must decode to 32 bytes');

const envSchema = z
  .object({
    RR_DOMAIN: z.string().min(1),
    RR_ACME_EMAIL: z.email().optional(),
    RR_PROXY_PROFILE: z.enum(['nginx', 'caddy', 'external']).default('nginx'),
    RR_TLS_MODE: z.enum(['acme', 'certbot', 'custom', 'none']).default('acme'),
    RR_APP_KEY: appKey,
    RR_SETUP_TOKEN: z.string().min(1),
    RR_INTERNAL_TOKEN: z.string().min(1),
    // Required unless DATABASE_URL names the database (below).
    POSTGRES_PASSWORD: z.string().min(1).optional(),
    POSTGRES_USER: z.string().min(1).default('remnaray'),
    POSTGRES_DB: z.string().min(1).default('remnaray'),
    DATABASE_URL: z.url().optional(),
    VALKEY_URL: z.url().default('redis://valkey:6379/0'),
    RR_VERSION: z.string().min(1).default('latest'),
    RR_EXTERNAL_HTTP_PORT: z.coerce.number().int().min(1).max(65535).default(8080),
    RR_TRUSTED_PROXIES: z.string().default('172.28.0.0/16'),
    RR_LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    RR_API_DOCS: booleanFromEnv,
    RR_THEME_UPLOAD: booleanFromEnv,
    // Section 22.4: development and test stands only.
    RR_PAYMENTS_MOCK: booleanFromEnv,
    RR_BACKUP_S3_ENDPOINT: z.url().optional(),
    RR_BACKUP_S3_BUCKET: z.string().min(1).optional(),
    RR_BACKUP_S3_ACCESS_KEY: z.string().min(1).optional(),
    RR_BACKUP_S3_SECRET_KEY: z.string().min(1).optional(),
    RR_BACKUP_S3_PREFIX: z.string().default(''),
    TZ: z.string().default('UTC'),
  })
  .superRefine((value, context) => {
    // Section 17.2: DATABASE_URL overrides the connection for an external
    // database, and the password is then never used.
    if (!value.POSTGRES_PASSWORD && !value.DATABASE_URL) {
      context.addIssue({
        code: 'custom',
        path: ['POSTGRES_PASSWORD'],
        message: 'required unless DATABASE_URL is set',
      });
    }

    if (value.RR_TLS_MODE === 'acme' && !value.RR_ACME_EMAIL) {
      context.addIssue({
        code: 'custom',
        path: ['RR_ACME_EMAIL'],
        message: 'required when RR_TLS_MODE=acme',
      });
    }

    if (value.RR_PROXY_PROFILE === 'external' && value.RR_TLS_MODE !== 'none') {
      context.addIssue({
        code: 'custom',
        path: ['RR_TLS_MODE'],
        message: 'must be none when RR_PROXY_PROFILE=external',
      });
    }

    if (value.RR_PROXY_PROFILE !== 'external' && value.RR_TLS_MODE === 'none') {
      context.addIssue({
        code: 'custom',
        path: ['RR_TLS_MODE'],
        message: 'none is only valid when RR_PROXY_PROFILE=external',
      });
    }

    // Section 21.4: Caddy issues and renews its own certificates.
    if (value.RR_PROXY_PROFILE === 'caddy' && value.RR_TLS_MODE === 'certbot') {
      context.addIssue({
        code: 'custom',
        path: ['RR_TLS_MODE'],
        message: 'certbot is not supported when RR_PROXY_PROFILE=caddy',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source?: Record<string, string | undefined>): Env {
  // compose hands an empty `.env` line to the process as '': that is unset.
  const input = Object.fromEntries(
    Object.entries(source ?? processEnv).filter(([, value]) => value !== ''),
  );
  const result = envSchema.safeParse(input);
  if (!result.success) {
    // The names and what is wrong with them; never a value (section 17.2).
    const fields = result.error.issues
      .map((issue) => `${issue.path.join('.')} (${issue.message})`)
      .join(', ');
    throw new Error(`Invalid environment configuration: ${fields}`);
  }
  return result.data;
}

/**
 * Section 17.2 and 17.5, R67: the first thing `api`, `worker` and `bot` do.
 * A wrong environment stops the process at once, naming the variables,
 * instead of starting and failing later somewhere else.
 */
export function checkEnvironment(): Env {
  try {
    return loadEnv();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

export { envSchema };
