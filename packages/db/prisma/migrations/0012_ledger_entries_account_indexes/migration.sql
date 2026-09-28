-- reversible: yes — DROP INDEX ix_ledger_entries_debit_account_id; DROP INDEX ix_ledger_entries_credit_account_id;
-- Repair queue R19: the nightly `maintenance.ledger-audit` and every
-- per-account look at the ledger read entries by the account on either side;
-- without these they scan the whole table.
CREATE INDEX ix_ledger_entries_debit_account_id ON ledger_entries (debit_account_id);
CREATE INDEX ix_ledger_entries_credit_account_id ON ledger_entries (credit_account_id);
