import { describe, expect, it } from 'vitest';

import { paymentCall } from './worker.service';

describe('payment jobs', () => {
  it.each([
    ['payments.poll-pending', '/api/internal/v1/payments/poll-pending'],
    ['payments.expire', '/api/internal/v1/payments/expire'],
    ['payments.reapply-events', '/api/internal/v1/payments/reapply-events'],
  ])('performs %s', (name, path) => {
    expect(paymentCall({ name, data: {} })).toEqual({ path });
  });

  it('applies the event a payments.apply-event job names', () => {
    expect(paymentCall({ name: 'payments.apply-event', data: { eventId: 'event-1' } })).toEqual({
      path: '/api/internal/v1/payments/events/event-1/apply',
    });
  });
});
