import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
 * on the PATH is the real one from `postgres:18-alpine`, on the host network,
 * handed exactly the libpq variables `migrate` gives it.
 *
 * R91: the dump used to ignore `POSTGRES_PORT` (and an explicit
 * `DATABASE_URL`, which the migration itself uses), so it read another
 * database or none; and a failed `pg_dump` left a truncated file under the
 * dump's own name. Here the database listens on a port other than 5432.
 */
test(
  'M5 the pre-migrate dump reads the migrated database and is written whole',
  { timeout: 240_000 },
  async () => {
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
      const port = String(postgres.getMappedPort(5432));
      assert.notEqual(port, '5432');
      execFileSync('pnpm', ['--filter', '@remnaray/db', 'db:migrate:deploy'], {
        env: { ...process.env, DATABASE_URL: postgres.getConnectionUri() },
        stdio: 'pipe',
      });
      execFileSync('docker', [
        'exec',
        postgres.getId(),
        'psql',
        '-U',
        'remnaray',
        '-d',
        'remnaray',
        '-c',
        'CREATE TABLE r91_marker (v int)',
      ]);
      // Every applied migration, and one more that cannot be undone.
      cpSync('packages/db/prisma/migrations', migrations, { recursive: true });
      const irreversible = (name) => {
        mkdirSync(join(migrations, name));
        writeFileSync(join(migrations, name, 'migration.sql'), '-- reversible: no\nSELECT 1;\n');
      };
      irreversible('9998_irreversible');

      const uid = `${String(process.getuid())}:${String(process.getgid())}`;
      const pgDump = (extra = '') =>
        writeFileSync(
          join(bin, 'pg_dump'),
          [
            '#!/bin/sh',
            extra,
            // `-e NAME` passes NAME only when it is set, as the environment would.
            `exec docker run --rm --network host --user ${uid} \\`,
            '  -e PGHOST -e PGPORT -e PGUSER -e PGPASSWORD -e PGDATABASE -e PGSSLMODE \\',
            `  -v "${backups}:${backups}" postgres:18-alpine pg_dump "$@"`,
            '',
          ].join('\n'),
          { mode: 0o755 },
        );
      const migrate = () =>
        spawnSync('node', [resolve('apps/api/dist/tools/migrate.js')], {
          cwd: resolve('packages/db'),
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH ?? ''}`,
            // No DATABASE_URL: the one `migrate` builds from POSTGRES_*, with
            // its port, is what both Prisma and the dump must use.
            DATABASE_URL: '',
            POSTGRES_USER: 'remnaray',
            POSTGRES_PASSWORD: PASSWORD,
            POSTGRES_DB: 'remnaray',
            POSTGRES_HOST: '127.0.0.1',
            POSTGRES_PORT: port,
            RR_MIGRATIONS_DIR: migrations,
            RR_BACKUP_DIR: backups,
            RR_VERSION: '9.9.9',
          },
        });

      pgDump();
      const result = migrate();
      const output = `${result.stdout}${result.stderr}`;
      assert.match(output, /taking a pre-migrate dump/u, output);
      assert.equal(result.status, 0, output);
      // R59: named after the schema the upgrade leaves — its last applied
      // migration — and when, never after RR_VERSION.
      const outgoing = readdirSync('packages/db/prisma/migrations', { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
        .at(-1);
      const dumps = readdirSync(backups);
      assert.equal(dumps.length, 1, dumps.join(', '));
      assert.match(dumps[0], new RegExp(`^pre-migrate-${outgoing}-\\d{8}-\\d{6}\\.dump$`, 'u'));
      const listing = execFileSync(
        'docker',
        [
          'run',
          '--rm',
          '-v',
          `${backups}:/b:ro`,
          'postgres:18-alpine',
          'pg_restore',
          '--list',
          `/b/${dumps[0]}`,
        ],
        { encoding: 'utf8' },
      );
      assert.match(listing, /TABLE public r91_marker/u);

      // A dump that fails half-way leaves no file that looks like a dump, and
      // the earlier one stays.
      irreversible('9999_irreversible');
      pgDump(
        'for last; do :; done; echo truncated > "$(printf %s "$*" | sed -n "s/.*--file \\([^ ]*\\).*/\\1/p")"; exit 1',
      );
      const failed = migrate();
      assert.notEqual(failed.status, 0, `${failed.stdout}${failed.stderr}`);
      assert.deepEqual(readdirSync(backups), dumps);
    } finally {
      await postgres.stop();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
