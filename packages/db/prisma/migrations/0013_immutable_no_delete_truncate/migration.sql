-- reversible: yes — restore 0002's payment_events_guard() and DROP TRIGGER the five *_no_truncate triggers.
-- Repair queue L-20 (section 8.1): the append-only tables refuse a DELETE
-- and a TRUNCATE outright. 0002's payment_events_guard() compared NEW with
-- OLD on DELETE too; NEW is NULL there, the comparison was NULL, and the
-- trigger returned NULL — which skips the row, so a DELETE reported success
-- and removed nothing. Row triggers never see TRUNCATE, so it needs a
-- statement trigger on every immutable table.
CREATE OR REPLACE FUNCTION payment_events_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'immutable table: %', TG_TABLE_NAME USING ERRCODE = '27000';
  END IF;
  IF to_jsonb(NEW) - ARRAY['processed_at','process_error'] <> to_jsonb(OLD) - ARRAY['processed_at','process_error'] THEN
    RAISE EXCEPTION 'payment_events are immutable except processing markers' USING ERRCODE = '27000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER payment_events_no_truncate BEFORE TRUNCATE ON payment_events FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER transactions_no_truncate BEFORE TRUNCATE ON transactions FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER ledger_entries_no_truncate BEFORE TRUNCATE ON ledger_entries FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER notification_log_no_truncate BEFORE TRUNCATE ON notification_log FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
