import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migration = await readFile('prisma/migrations/0001_init/migration.sql', 'utf8');
const panelUserIdMigration = await readFile(
  'prisma/migrations/0005_panel_user_id/migration.sql',
  'utf8',
);
const schema = await readFile('prisma/schema.prisma', 'utf8');

test('initial migration includes the required tables and immutable triggers', () => {
  for (const table of [
    'settings',
    'users',
    'panel_users',
    'plans',
    'subscriptions',
    'accounts',
    'ledger_entries',
    'transactions',
    'invoices',
    'payment_events',
    'payment_providers',
    'promocodes',
    'admins',
    'audit_log',
    'notification_log',
    'broadcasts',
    'outbox_jobs',
    'setup_state',
  ]) {
    assert.match(migration, new RegExp(`CREATE TABLE ${table}\\b`));
  }
  assert.match(migration, /CREATE OR REPLACE FUNCTION forbid_mutation/);
  assert.match(migration, /CREATE TRIGGER ledger_entries_immutable/);
  assert.match(migration, /CREATE TRIGGER transactions_guard/);
});

test('Prisma uses the Prisma 7 client generator and explicit output', () => {
  assert.match(schema, /provider = "prisma-client"/);
  assert.match(schema, /output\s+=\s+"\.\.\/src\/generated\/prisma"/);
  assert.match(schema, /uuidv7\(\)/);
});

test('the Remnawave v3.4.4 numeric user mapping is migrated and unique', () => {
  assert.match(panelUserIdMigration, /ADD COLUMN panel_user_id integer/);
  assert.match(panelUserIdMigration, /CREATE UNIQUE INDEX ux_panel_users_panel_user_id/);
  assert.match(schema, /panelUserId Int\? @map\("panel_user_id"\)/);
});

test('a plan must name at least one panel squad (section 8)', async () => {
  const squads = await readFile(
    'prisma/migrations/0008_plans_squads_nonempty/migration.sql',
    'utf8',
  );
  assert.match(squads, /CHECK \(cardinality\(squads\) > 0\) NOT VALID/);
});

test('plans without squads are taken off sale, and only such plans may keep none', async () => {
  const squads = await readFile(
    'prisma/migrations/0009_plans_squads_inactive/migration.sql',
    'utf8',
  );
  assert.match(squads, /UPDATE plans SET is_active = false/);
  assert.match(
    squads,
    /CHECK \(cardinality\(squads\) > 0 OR NOT is_active OR deleted_at IS NOT NULL\)/,
  );
});

test('support tickets keep one live ticket per customer (owner decision F36)', async () => {
  const support = await readFile('prisma/migrations/0010_support_tickets/migration.sql', 'utf8');
  for (const table of [
    'support_tickets',
    'support_messages',
    'support_topics',
    'support_templates',
    'support_faq',
  ])
    assert.match(support, new RegExp(`CREATE TABLE ${table}\\b`));
  assert.match(
    support,
    /CREATE UNIQUE INDEX ux_support_tickets_live_p ON support_tickets\(user_id\) WHERE status <> 'closed'/,
  );
  assert.match(schema, /model SupportTicket \{/);
});

test('unapplied payment events are found through a partial index (repair queue backstop)', async () => {
  const unapplied = await readFile(
    'prisma/migrations/0011_payment_events_unapplied/migration.sql',
    'utf8',
  );
  assert.match(unapplied, /-- reversible: yes/);
  assert.match(
    unapplied,
    /CREATE INDEX ix_payment_events_unapplied_p ON payment_events \(received_at\) WHERE processed_at IS NULL AND signature_ok;/,
  );
});

test('ledger entries are indexed by account for the nightly audit (repair queue R19)', async () => {
  const indexes = await readFile(
    'prisma/migrations/0012_ledger_entries_account_indexes/migration.sql',
    'utf8',
  );
  assert.match(indexes, /-- reversible: yes/);
  assert.match(
    indexes,
    /CREATE INDEX ix_ledger_entries_debit_account_id ON ledger_entries \(debit_account_id\);/,
  );
  assert.match(
    indexes,
    /CREATE INDEX ix_ledger_entries_credit_account_id ON ledger_entries \(credit_account_id\);/,
  );
  assert.match(schema, /@@index\(\[debitAccountId\], map: "ix_ledger_entries_debit_account_id"\)/);
});

test('append-only tables refuse DELETE and TRUNCATE (repair queue L-20)', async () => {
  const guard = await readFile(
    'prisma/migrations/0013_immutable_no_delete_truncate/migration.sql',
    'utf8',
  );
  assert.match(guard, /-- reversible: yes/);
  assert.match(guard, /IF TG_OP = 'DELETE' THEN\s+RAISE EXCEPTION/);
  for (const table of [
    'payment_events',
    'transactions',
    'ledger_entries',
    'audit_log',
    'notification_log',
  ])
    assert.match(
      guard,
      new RegExp(
        `CREATE TRIGGER ${table}_no_truncate BEFORE TRUNCATE ON ${table} FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation\\(\\);`,
      ),
    );
});

test('provider invoices are numbered top-ups with a purpose (F37, ADR-021)', async () => {
  const sql = await readFile('prisma/migrations/0014_balance_only_purchases/migration.sql', 'utf8');
  assert.match(sql, /-- reversible: no/);
  assert.match(sql, /ADD COLUMN number text/);
  assert.match(sql, /ADD COLUMN target_plan_id uuid REFERENCES plans\(id\)/);
  assert.match(sql, /ADD COLUMN target_kind invoice_kind/);
  assert.match(sql, /ADD COLUMN target_promocode text/);
  assert.match(
    sql,
    /CREATE UNIQUE INDEX ux_invoices_number ON invoices \(number\) WHERE number IS NOT NULL;/,
  );
  assert.match(sql, /CHECK \(provider = 'balance' OR kind = 'topup'\) NOT VALID/);
  assert.match(sql, /CREATE TABLE invoice_counters/);
  assert.match(sql, /DELETE FROM settings WHERE key = 'referral.count_topups';/);
  assert.match(schema, /number\s+String\?\s+@unique/);
  assert.match(schema, /model InvoiceCounter \{/);
});
