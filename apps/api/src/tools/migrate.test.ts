import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  isIrreversible,
  migrationNames,
  needsPreMigrateBackup,
  pendingNames,
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
    expect(isIrreversible('-- reversible: restore the previous CHECK.\n')).toBe(false);
    expect(isIrreversible('CREATE TABLE t ();\n-- a comment mentioning reversible: no')).toBe(
      false,
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
      '0002_safe': '-- reversible: drop the column again.\n',
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

  it('names the pre-migrate dump after the schema the upgrade leaves', () => {
    // The database returns the applied names in no particular order.
    expect(preMigrateDumpName(['0012_indexes', '0001_init', '0013_guards'])).toBe(
      'pre-migrate-0013_guards.dump',
    );
  });
});
