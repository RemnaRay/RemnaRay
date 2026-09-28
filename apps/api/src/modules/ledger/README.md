# Ledger module

The ledger module is the single write boundary for internal balance movements.
Each post creates one immutable transaction and one immutable double-entry
`ledger_entries` row, updates both denormalized account balances in the same
PostgreSQL transaction, locks all participating accounts in sorted ID order,
and rejects user debits below `available()`.

Every account, user or system, holds `SUM(credit) − SUM(debit)`: a credit
adds to the balance, a debit subtracts. The accounts money leaves —
`provider_clearing`, `referral_expense`, `promo_expense`, a crediting
`adjustment` — therefore go negative, `revenue` goes positive, and all
balances sum to zero. This is a recorded deviation from
section 8.3, which reads system accounts as `debit − credit` (repair queue
P-6, owner decision 2026-09-28): the posting paths already wrote this
convention, and the audit follows them.

`available()` subtracts held referral rewards from the user account balance.
`audit()` recomputes each account from ledger entries and reports mismatches for
the maintenance worker. All amounts are `bigint` minor units.
