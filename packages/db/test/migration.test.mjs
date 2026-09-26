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
