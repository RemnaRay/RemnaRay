import { describe, expect, it } from 'vitest';

import { CONCURRENCY, maintenanceCall, panelCall } from './worker.service';

describe('panel jobs', () => {
  const data = { userId: '0199a0b0-0000-7000-8000-000000000001' };

  it.each([
    ['panel.sync-user', '/api/internal/v1/remnawave/sync-user', data],
    ['panel.reset-traffic', '/api/internal/v1/remnawave/reset-traffic', data],
    ['panel.delete-user', '/api/internal/v1/remnawave/delete-user', data],
  ])('performs %s with the job data', (name, path, body) => {
    expect(panelCall({ name, data })).toEqual({ path, body });
  });

  it('reconciles only for panel.reconcile-all', () => {
    expect(panelCall({ name: 'panel.reconcile-all', data: {} })).toEqual({
      path: '/api/internal/v1/remnawave/reconcile',
    });
  });

  it('fails a job it does not know instead of reconciling', () => {
    // Reset traffic and delete-user used to fall through to reconciliation.
    expect(() => panelCall({ name: 'panel.unknown', data })).toThrow(/unknown panel job/u);
  });
});

describe('worker concurrency (section 7.3)', () => {
  it('runs each queue at the concurrency the table gives it', () => {
    expect(CONCURRENCY).toEqual({
      panel: 2,
      payments: 4,
      notify: 5,
      broadcast: 1,
      maintenance: 1,
      webhooks: 5,
    });
  });
});

describe('maintenance jobs', () => {
  it('sends the support sweep to its own endpoint (F36)', () => {
    expect(maintenanceCall({ name: 'maintenance.support-sweep' })).toEqual({
      path: '/api/internal/v1/support/sweep',
    });
    expect(maintenanceCall({ name: 'maintenance.subscriptions-expire' })).toEqual({
      path: '/api/internal/v1/subscriptions/expire',
    });
  });
});
