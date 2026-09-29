# Referrals and promo codes

## Accrual (section 15.2)

`RewardsService` runs inside the payment transaction, so a reward can never
exist without its source. The rules it applies:

- only `topup` sources — money actually received: a provider top-up, an
  underpaid or late payment credited to the balance, the Stars second charge.
  A purchase from the balance spends a top-up that was already a source, so it
  is never one (F37, ADR-021; closes R135). `settings.referral.count_topups` is
  removed; an older settings export that still carries it imports, the key is
  skipped;
- `min_source_amount_minor` filters small top-ups out;
- `percent_first` and `fixed_first` accrue on the first top-up only,
  `percent_all` accrues on every top-up while `all_months` has not elapsed since
  attribution;
- `max_rewards_per_day` caps a referrer's daily accruals and queues an
  administrator alert when the cap is hit;
- the accrual is idempotent on `source_transaction_id`.

`hold_hours` marks a reward `held`. `ledger.available()` subtracts held rewards,
so they cannot be spent; `POST /api/internal/v1/rewards/release-held` is the
`maintenance.referral-release` cron.

Refunding the source reverses the reward: fully when the refund is full, and
proportionally rounded down otherwise. Under F37 the automatic reversal applies
only to rewards written before F37 on a purchase source: a top-up is not
refunded (FR-066 refunds purchases) and a purchase is no longer a source.
The protection is `hold_hours` and the manual reversal from `/admin/referrals`.
The section 15.4 flag «paid from a balance topped up a minute before» is not
implemented and will not be: every purchase is now paid that way (ADR-021).

The invitee bonus is granted at sign-up or on the first top-up, depending on
`settings.referral.invitee_bonus_trigger`. `days` extends a live subscription or
creates one with the trial limits; `balance` posts `promo_expense → user`.

## Attribution (section 15.3)

The bot attributes `/start ref_<code>` on creation, or within 24 hours of a
sign-up that has no attribution and no payments. The site sets `rr_ref` for 30
days from `/r/<code>`, and `POST /api/v1/auth/telegram` turns that cookie into
the same start payload. A self-referral is ignored silently, and a banned
referrer's code never attributes.

## Promo codes (section 15.5)

Creating an invoice reserves the slot under a `SELECT … FOR UPDATE` on the promo
code row, so two concurrent buyers can never oversell `max_uses`: the loser gets
`PROMO_EXHAUSTED` (AC-155). The reservation carries the discount onto the
invoice, becomes `applied` and bumps `used_count` when the invoice is paid, and
is `released` when the invoice is canceled, underpaid or fails. Under F37 a plan
is bought from the balance, so the slot is taken, applied or released within the
one purchase request; a top-up never reserves one. Only a provider purchase
written before F37 can still hold a reservation until it is paid or expires.

Codes are stored uppercase; user input is trimmed, uppercased and folded
(`O→0`, `I→1`, `L→1`), and both forms are looked up. Batch generation uses the
section 15.6 alphabet `[A-HJ-NP-Z2-9]` with an optional prefix.

Section 14.2 limits an operator to `max_uses ≤ 100` and forbids `bonus_balance`.

## Verification

`test/m4.rewards.integration.test.mjs` runs against PostgreSQL 18 and covers
AC-152 (one reward for two top-ups under `percent_first`, none for the purchase
from the balance), `percent_all` over top-ups, the `first_paid` invitee bonus at
the first top-up, AC-153 (a purchase refund leaves the reward, the manual
reversal restores the balance, held rewards not spendable) and AC-155 (the promo
code race).
