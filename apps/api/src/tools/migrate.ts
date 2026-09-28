/**
 * The `migrate` one-shot service of section 21.1: it applies the migrations
 * before `api`, `bot` and `worker` start, and section 20.4 makes it take a
 * `pg_dump` first when a pending migration is marked `reversible: no`, so a
 * downgrade has something to go back to.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { createPrismaClient, resolveDatabaseUrl } from '@remnaray/db';

const MIGRATIONS_DIRECTORY =
  process.env.RR_MIGRATIONS_DIR ?? resolve(process.cwd(), 'prisma/migrations');
const BACKUP_DIRECTORY = process.env.RR_BACKUP_DIR ?? '/backups';

/**
 * A migration that may not be undone (section 11.6). Only a header that says
 * `-- reversible: yes` skips the dump: one that says neither yes nor no, or
 * none at all, is taken as irreversible (R91), because a missing dump cannot
 * be taken afterwards. The first such header line counts.
 */
export function isIrreversible(sql: string): boolean {
  const value = /^--\s*reversible:\s*(\S*)/imu.exec(sql)?.[1] ?? '';
  return !/^yes\b/iu.test(value);
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
 * The dump is named after the schema it holds — the last migration already
 * applied, which is the version the upgrade leaves — and the time it was
 * taken. `RR_VERSION` names where the upgrade goes, and on the `1` channel
 * every upgrade wrote the same file (R59); the time keeps a second attempt at
 * the same upgrade from replacing the first one's dump (R91).
 */
export function preMigrateDumpName(applied: string[], now = new Date()): string {
  const outgoing = [...applied].sort().at(-1) ?? 'empty';
  const stamp = now.toISOString().replace(/[-:]/gu, '').replace('T', '-').slice(0, 15);
  return `pre-migrate-${outgoing}-${stamp}.dump`;
}

/**
 * The connection the migration uses, as libpq variables for `pg_dump`: the
 * same host, port and database (R91 — the dump used to ignore `POSTGRES_PORT`
 * and an explicit `DATABASE_URL`), and the password in the environment rather
 * than on a command line anyone on the host can read.
 */
export function libpqEnvironment(url: string): Record<string, string> {
  const parsed = new URL(url);
  const environment: Record<string, string> = {
    PGHOST: decodeURIComponent(parsed.hostname).replace(/^\[(.*)\]$/u, '$1'),
    PGPORT: parsed.port || '5432',
    PGUSER: decodeURIComponent(parsed.username),
    PGPASSWORD: decodeURIComponent(parsed.password),
    PGDATABASE: decodeURIComponent(parsed.pathname.replace(/^\//u, '')),
  };
  const sslmode = parsed.searchParams.get('sslmode');
  if (sslmode) environment.PGSSLMODE = sslmode;
  return environment;
}

/**
 * Into a `.partial` file renamed once `pg_dump` succeeded: a dump cut short
 * never sits under a dump's name (R91).
 */
function preMigrateBackup(name: string, url: string): void {
  mkdirSync(BACKUP_DIRECTORY, { recursive: true });
  const target = resolve(BACKUP_DIRECTORY, name);
  const partial = `${target}.partial`;
  process.stdout.write(`migrate: taking a pre-migrate dump into ${target}\n`);
  try {
    run('pg_dump', ['--format=custom', '--compress=6', '--file', partial], {
      ...process.env,
      ...libpqEnvironment(url),
    });
  } catch (error) {
    rmSync(partial, { force: true });
    throw error;
  }
  renameSync(partial, target);
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

  // `prisma.config.ts` reads DATABASE_URL, which compose no longer assembles.
  const url = resolveDatabaseUrl();
  if (url) process.env.DATABASE_URL = url;

  if (
    applied.length > 0 &&
    process.env.RR_AUTO_PREMIGRATE_BACKUP !== 'false' &&
    needsPreMigrateBackup(MIGRATIONS_DIRECTORY, pending)
  ) {
    // The client above connected with this URL, so it is there.
    if (!url) throw new Error('no database URL to take the pre-migrate dump from');
    preMigrateBackup(preMigrateDumpName(applied), url);
  }
  run(prismaCli(), ['migrate', 'deploy']);
  process.stdout.write('migrate: done\n');
}

void main().catch((error: unknown) => {
  process.stderr.write(`migrate: ${String(error)}\n`);
  process.exitCode = 1;
});
