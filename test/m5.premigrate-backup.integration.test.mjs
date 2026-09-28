import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';
import { PostgreSqlContainer } from '@testcontainers/postgresql';

const PASSWORD = 'premigrate-secret';

/**
 * Section 20.4: before a pending `reversible: no` migration, `migrate` takes a
 * `pg_dump`. The runtime image has the client; this host may not, so `pg_dump`
 * on the PATH is the real one from `postgres:18-alpine`, handed exactly the
 * libpq variables `migrate` gives it. It reaches the server by the
 * container's bridge address, where the official image asks for a password
 * (`host all all all scram-sha-256`), as the `postgres` service does.
 */
test('M5 the pre-migrate dump authenticates and is written', { timeout: 240_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'rr-premigrate-'));
  const backups = join(directory, 'backups');
  const migrations = join(directory, 'migrations');
  const bin = join(directory, 'bin');
  mkdirSync(backups);
  mkdirSync(bin);
  const postgres = await new PostgreSqlContainer('postgres:18-alpine')
    .withDatabase('remnaray')
    .withUsername('remnaray')
    .withPassword(PASSWORD)
    .start();
  try {
    const databaseUrl = postgres.getConnectionUri();
    execFileSync('pnpm', ['--filter', '@remnaray/db', 'db:migrate:deploy'], {
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
    });
    // Every applied migration, and one more that cannot be undone.
    cpSync('packages/db/prisma/migrations', migrations, { recursive: true });
    mkdirSync(join(migrations, '9999_irreversible'));
    writeFileSync(
      join(migrations, '9999_irreversible', 'migration.sql'),
      '-- reversible: no\nSELECT 1;\n',
    );

    const address = postgres.getIpAddress(postgres.getNetworkNames()[0]);
    const uid = `${String(process.getuid())}:${String(process.getgid())}`;
    writeFileSync(
      join(bin, 'pg_dump'),
      [
        '#!/bin/sh',
        // `-e NAME` passes NAME only when it is set, as the environment would.
        `exec docker run --rm --user ${uid} -e PGPASSWORD -e PGPORT -e PGSSLMODE \\`,
        `  -v "${backups}:${backups}" postgres:18-alpine pg_dump "$@"`,
        '',
      ].join('\n'),
    );
    chmodSync(join(bin, 'pg_dump'), 0o755);

    const result = spawnSync('node', [resolve('apps/api/dist/tools/migrate.js')], {
      cwd: resolve('packages/db'),
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        // Prisma, from this host, through the published port; `pg_dump`,
        // from a container, by POSTGRES_HOST — both as the service sees them.
        DATABASE_URL: databaseUrl,
        POSTGRES_USER: 'remnaray',
        POSTGRES_PASSWORD: PASSWORD,
        POSTGRES_DB: 'remnaray',
        POSTGRES_HOST: address,
        RR_MIGRATIONS_DIR: migrations,
        RR_BACKUP_DIR: backups,
        RR_VERSION: '9.9.9',
      },
    });
    const output = `${result.stdout}${result.stderr}`;
    assert.match(output, /taking a pre-migrate dump/u, output);
    assert.equal(result.status, 0, output);
    // R59: named after the schema the upgrade leaves — its last applied
    // migration — not after RR_VERSION, which names where it goes (and,
    // on the `1` channel, the same file at every upgrade).
    const outgoing = readdirSync('packages/db/prisma/migrations', { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .at(-1);
    const name = `pre-migrate-${outgoing}.dump`;
    assert.deepEqual(readdirSync(backups), [name]);
    assert.ok(statSync(join(backups, name)).size > 0);
  } finally {
    await postgres.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});
