import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  isIrreversible,
  migrationNames,
  needsPreMigrateBackup,
  pendingNames,
  libpqEnvironment,
  preMigrateDumpName,
} from './migrate';

function fixture(migrations: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'rr-migrations-'));
  for (const [name, sql] of Object.entries(migrations)) {
    mkdirSync(resolve(root, name), { recursive: true });
    writeFileSync(resolve(root, name, 'migration.sql'), sql, 'utf8');
  }
  return root;
}

describe('migrate (sections 20.4 and 11.6)', () => {
  it('reads the reversibility header, and nothing else', () => {
    expect(isIrreversible('-- reversible: no\nCREATE TABLE t ();')).toBe(true);
    expect(
      isIrreversible('-- a note\n-- reversible: yes — DROP TABLE t;\nCREATE TABLE t ();'),
    ).toBe(false);
    expect(isIrreversible('-- reversible: yes\nCREATE TABLE t ();\n-- reversible: no')).toBe(false);
  });

  // R91: section 8.1 asks for `-- reversible: yes|no`. A header that says
  // neither, or no header at all, used to count as reversible and the dump
  // was skipped; now only an explicit `yes` skips it.
  it('takes a dump before a migration that does not say yes', () => {
    expect(isIrreversible('-- reversible: restore the previous CHECK.\n')).toBe(true);
    expect(isIrreversible('CREATE TABLE t ();\n')).toBe(true);
    expect(isIrreversible('-- reversible: yesterday\n')).toBe(true);
  });

  // 0002–0005 are applied everywhere and may not be edited (section 8.4);
  // every later migration states yes or no.
  it('gives every migration after 0005 a yes or no header', () => {
    const directory = resolve(__dirname, '../../../../packages/db/prisma/migrations');
    const names = migrationNames(directory);
    expect(names.length).toBeGreaterThan(12);
    for (const name of names.filter((entry) => entry > '0005_z'))
      expect(readFileSync(resolve(directory, name, 'migration.sql'), 'utf8'), name).toMatch(
        /^--\s*reversible:\s*(?:yes|no)\b/mu,
      );
  });

  it('treats every migration missing from the table as pending', () => {
    expect(pendingNames(['0001_init', '0002_next', '0003_last'], ['0001_init'])).toEqual([
      '0002_next',
      '0003_last',
    ]);
    expect(pendingNames(['0001_init'], ['0001_init'])).toEqual([]);
  });

  it('asks for a dump only when a pending migration cannot be undone', () => {
    const root = fixture({
      '0001_init': '-- reversible: no\n',
      '0002_safe': '-- reversible: yes — drop the column again.\n',
      '0003_hard': '-- reversible: no\n',
    });
    try {
      expect(migrationNames(root)).toEqual(['0001_init', '0002_safe', '0003_hard']);
      expect(needsPreMigrateBackup(root, ['0002_safe'])).toBe(false);
      expect(needsPreMigrateBackup(root, ['0002_safe', '0003_hard'])).toBe(true);
      expect(needsPreMigrateBackup(root, [])).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('names the pre-migrate dump after the schema the upgrade leaves, and when', () => {
    // The database returns the applied names in no particular order. The
    // time keeps a second attempt at the same upgrade from replacing the
    // dump of the first (R91).
    expect(
      preMigrateDumpName(
        ['0012_indexes', '0001_init', '0013_guards'],
        new Date('2026-09-28T12:34:56Z'),
      ),
    ).toBe('pre-migrate-0013_guards-20260928-123456.dump');
  });

  // R91: the dump reads the database the migration writes — the same URL,
  // port and all — and the password never reaches the command line.
  it('hands pg_dump the connection the migration uses, through libpq variables', () => {
    expect(
      libpqEnvironment(
        'postgresql://shop%40owner:p%40ss%2Fw@db.internal:6543/shop%20db?sslmode=require',
      ),
    ).toEqual({
      PGHOST: 'db.internal',
      PGPORT: '6543',
      PGUSER: 'shop@owner',
      PGPASSWORD: 'p@ss/w',
      PGDATABASE: 'shop db',
      PGSSLMODE: 'require',
    });
    expect(libpqEnvironment('postgresql://u:p@[::1]/d')).toEqual({
      PGHOST: '::1',
      PGPORT: '5432',
      PGUSER: 'u',
      PGPASSWORD: 'p',
      PGDATABASE: 'd',
    });
  });
});
