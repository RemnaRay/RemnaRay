/**
 * The `migrate` one-shot service of section 21.1: it applies the migrations
 * before `api`, `bot` and `worker` start, and section 20.4 makes it take a
 * `pg_dump` first when a pending migration is marked `reversible: no`, so a
 * downgrade has something to go back to.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { createPrismaClient, resolveDatabaseUrl } from '@remnaray/db';

const MIGRATIONS_DIRECTORY =
  process.env.RR_MIGRATIONS_DIR ?? resolve(process.cwd(), 'prisma/migrations');
const BACKUP_DIRECTORY = process.env.RR_BACKUP_DIR ?? '/backups';

/** A migration whose header says it cannot be undone (section 11.6). */
export function isIrreversible(sql: string): boolean {
  return /^--\s*reversible:\s*no\b/imu.test(sql);
}

export function migrationNames(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/**
 * The names that are on disk but not yet in `_prisma_migrations`, which is the
 * same comparison `prisma migrate status` makes.
 */
export function pendingNames(onDisk: string[], applied: string[]): string[] {
  const done = new Set(applied);
  return onDisk.filter((name) => !done.has(name));
}

export function needsPreMigrateBackup(directory: string, pending: string[]): boolean {
  return pending.some((name) => {
    const file = resolve(directory, name, 'migration.sql');
    return existsSync(file) && isIrreversible(readFileSync(file, 'utf8'));
  });
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): void {
  const result = spawnSync(command, args, { stdio: 'inherit', env });
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(' ')} exited with ${String(result.status ?? -1)}`);
}

/** The CLI lives beside the schema, and the image has no global install. */
function prismaCli(): string {
  const local = resolve(process.cwd(), 'node_modules/.bin/prisma');
  return existsSync(local) ? local : 'prisma';
}

/**
 * The dump is named after the schema it holds: the last migration already
 * applied, which is the version the upgrade leaves. `RR_VERSION` names where
 * it goes, and on the `1` channel every upgrade wrote the same file (R59).
 */
export function preMigrateDumpName(applied: string[]): string {
  const outgoing = [...applied].sort().at(-1) ?? 'empty';
  return `pre-migrate-${outgoing}.dump`;
}

function preMigrateBackup(name: string): void {
  mkdirSync(BACKUP_DIRECTORY, { recursive: true });
  const target = resolve(BACKUP_DIRECTORY, name);
  process.stdout.write(`migrate: taking a pre-migrate dump into ${target}\n`);
  run(
    'pg_dump',
    [
      '--host',
      process.env.POSTGRES_HOST ?? 'postgres',
      '--username',
      process.env.POSTGRES_USER ?? 'remnaray',
      '--dbname',
      process.env.POSTGRES_DB ?? 'remnaray',
      '--format=custom',
      '--compress=6',
      '--file',
      target,
    ],
    {
      ...process.env,
      // The `postgres` service asks every network client for the password
      // (`scram-sha-256`), and a one-shot container has no terminal to type it.
      PGPASSWORD: process.env.POSTGRES_PASSWORD ?? '',
    },
  );
}

async function main(): Promise<void> {
  const db = createPrismaClient();
  let applied: string[];
  try {
    const rows = await db.$queryRaw<
      { migration_name: string }[]
    >`SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL`;
    applied = rows.map((row) => row.migration_name);
  } catch {
    // An empty database has no `_prisma_migrations` table yet; everything is
    // pending, and there is nothing worth dumping.
    applied = [];
  } finally {
    await db.$disconnect();
  }

  const onDisk = migrationNames(MIGRATIONS_DIRECTORY);
  const pending = pendingNames(onDisk, applied);
  process.stdout.write(
    `migrate: ${String(pending.length)} pending of ${String(onDisk.length)} migrations\n`,
  );

  if (
    applied.length > 0 &&
    process.env.RR_AUTO_PREMIGRATE_BACKUP !== 'false' &&
    needsPreMigrateBackup(MIGRATIONS_DIRECTORY, pending)
  )
    preMigrateBackup(preMigrateDumpName(applied));

  // `prisma.config.ts` reads DATABASE_URL, which compose no longer assembles.
  const url = resolveDatabaseUrl();
  if (url) process.env.DATABASE_URL = url;
  run(prismaCli(), ['migrate', 'deploy']);
  process.stdout.write('migrate: done\n');
}

void main().catch((error: unknown) => {
  process.stderr.write(`migrate: ${String(error)}\n`);
  process.exitCode = 1;
});
