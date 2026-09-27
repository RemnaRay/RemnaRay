-- Repair queue 2026-09-27 (R1, P-1, R74): the `payments.reapply-events`
-- backstop re-applies stored payment events whose apply never finished. It
-- looks for them every five minutes; this index keeps that a read of the few
-- unapplied rows rather than of every event ever received.
-- reversible: yes — DROP INDEX ix_payment_events_unapplied_p;
CREATE INDEX ix_payment_events_unapplied_p ON payment_events (received_at) WHERE processed_at IS NULL AND signature_ok;
