-- F37 (owner decision О-12, ADR-021): plans are bought only from the balance.
-- A provider invoice is always a top-up; one «for a plan» remembers its
-- purpose, and every provider invoice carries a per-provider number
-- «NN-00001» (the receipt line and the payment description).
-- reversible: no — the stored `referral.count_topups` value is dropped.
ALTER TABLE invoices
  ADD COLUMN number text,
  ADD COLUMN target_plan_id uuid REFERENCES plans(id),
  ADD COLUMN target_kind invoice_kind,
  ADD COLUMN target_promocode text;

CREATE UNIQUE INDEX ux_invoices_number ON invoices (number) WHERE number IS NOT NULL;

-- NOT VALID: new rows are checked; rows written before F37 do not fail the
-- migration (the stand is recreated anyway, О-20).
ALTER TABLE invoices
  ADD CONSTRAINT ck_invoices_provider_topup
    CHECK (provider = 'balance' OR kind = 'topup') NOT VALID;
ALTER TABLE invoices
  ADD CONSTRAINT ck_invoices_target
    CHECK (
      (target_plan_id IS NULL AND target_kind IS NULL AND target_promocode IS NULL)
      OR (kind = 'topup' AND target_plan_id IS NOT NULL
          AND target_kind IN ('purchase', 'plan_change'))
    ) NOT VALID;

CREATE TABLE invoice_counters (
  provider text PRIMARY KEY,
  last bigint NOT NULL
);

DELETE FROM settings WHERE key = 'referral.count_topups';

UPDATE settings
SET value = to_jsonb('Пополнение баланса (#{number})'::text)
WHERE key = 'fiscal.item_name_template'
  AND value = to_jsonb('Subscription {plan}'::text);
