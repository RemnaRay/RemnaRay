# Notifications and alerts

## Trigger events (section 16.1)

`NotifyService` owns every event in the section 16.1 table. A delivery is
identified by `(user_id, dedup_key)`, which `notification_log` enforces with a
unique index, so the same event is never delivered twice (FR-160, AC-160).

`notification_log` is immutable, so the row is written once with its final
status. A short Valkey lock on the dedup key keeps two workers from delivering
before either row exists; the unique index is the backstop. Migration
`0003_notification_log_status` adds `skipped` to the allowed statuses, which
section 16.2 needs for a banned recipient.

Emitters write an outbox job rather than sending inline, so the notification
shares the transaction of the change that caused it:

| Event                                                           | Emitted by                                             |
| --------------------------------------------------------------- | ------------------------------------------------------ |
| `sub.activated`                                                 | subscription activation inside the payment transaction |
| `payment.succeeded`, `payment.to_balance`                       | `applyEvent` and the balance settlement                |
| `referral.reward`, `referral.invitee_bonus`                     | the accrual engine                                     |
| `promo.applied`                                                 | promo code settlement                                  |
| `admin.message`                                                 | the operator action on the user card                   |
| `sub.expires_in_3d`, `sub.expires_in_1d`, `trial.expires_in_1d` | the `notify.scan-expiring` cron                        |

## Delivery (section 16.2)

`notify.send` renders the template in `users.language` from the merged catalog,
sends it with `parse_mode=HTML` and the event's buttons, and records the result.
It never delivers to a banned user (`skipped`), to one who blocked the bot
(`skipped_blocked`), or a marketing event to a user who opted out
(`skipped_opt_out`). A Telegram `403` marks `users.bot_blocked_at`.

## Cron

The worker ticks every ten minutes for `notify.scan-expiring` and
`maintenance.referral-release`, and every thirty seconds for payment polling and
invoice expiry. The scan covers the whole three-day horizon, so a missed window
after downtime is picked up on the next tick without sending twice.

## Administrator alerts (FR-163)

`POST /api/internal/v1/notify/alert` delivers to every active `admin` with a
`telegram_id`, in `settings.admin.language`, and deduplicates on
`rr:alert:<type>` with a one-hour TTL (AC-163). The types are the section 16.5
list; `payment.late`, `payment.underpaid` and `referral.daily_cap` are already
emitted by the payment and referral paths, and `ledger.mismatch` by the
nightly `maintenance.ledger-audit` (from 02:00 UTC, once a day, naming the
accounts whose balance disagrees with their entries).

## Verification

`test/m4.notify.integration.test.mjs` runs three cron windows against
PostgreSQL 18 and asserts a single delivery (AC-160), that a second window with
a different dedup key does send, that a blocked user is recorded and skipped,
and that a repeated alert of the same type is deduplicated while another type is
not (AC-163).
