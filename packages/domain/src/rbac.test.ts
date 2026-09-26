import { describe, expect, it } from 'vitest';

import { can, limitKeyFor, permissionsFor } from './rbac.js';

describe('admin RBAC matrix', () => {
  it('gives operators only the operational permissions', () => {
    expect(can('operator', 'users.mutate')).toBe(true);
    expect(can('operator', 'users.balance.debit')).toBe(false);
    expect(can('operator', 'settings.write')).toBe(false);
    expect(permissionsFor('operator')).not.toContain('admins.write');
  });

  it('denies operators every settings, panel, bot, theme and locale tab', () => {
    for (const permission of [
      'settings.read',
      'settings.write',
      'providers.write',
      'panel.write',
      'bot.write',
      'themes.read',
      'themes.write',
      'i18n.read',
      'i18n.write',
      'subscriptions.bulk',
      'plans.write',
      'referrals.write',
      'users.anonymize',
      'system.write',
    ] as const) {
      expect(can('operator', permission), permission).toBe(false);
    }
    expect(can('operator', 'legal.read')).toBe(true);
  });

  it('limits the operator journal to their own actions', () => {
    expect(can('operator', 'audit.read')).toBe(false);
    expect(can('operator', 'audit.read.self')).toBe(true);
    expect(can('admin', 'audit.read')).toBe(true);
    expect(permissionsFor('admin')).not.toContain('audit.read.self');
  });

  it('exposes the settings key that caps an operator amount', () => {
    expect(limitKeyFor('operator', 'users.balance.credit')).toBe('operator.max_credit_minor');
    expect(limitKeyFor('operator', 'payments.refund')).toBe('operator.max_refund_minor');
    expect(limitKeyFor('admin', 'payments.refund')).toBeUndefined();
    expect(limitKeyFor('operator', 'users.read')).toBeUndefined();
  });

  it('shows operators the support tickets, but leaves templates and FAQ to admins (F36)', () => {
    expect(can('operator', 'support.read')).toBe(true);
    expect(can('operator', 'support.write')).toBe(false);
    expect(can('admin', 'support.write')).toBe(true);
  });

  it('gives admins the complete permission set', () => {
    expect(can('admin', 'admins.write')).toBe(true);
    expect(can('admin', 'settings.write')).toBe(true);
    expect(permissionsFor('admin')).toContain('system.write');
  });
});
