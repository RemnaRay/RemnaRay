# Administration authentication

The admin API uses a separate `rr_asid` cookie with a 12-hour lifetime. A
password login creates a five-minute challenge, and the challenge is completed
with a six-digit TOTP. First-time admins use `POST /api/admin/v1/auth/totp/setup`
and then confirm the generated code; subsequent logins use
`POST /api/admin/v1/auth/totp`.

Mutating admin requests must include the CSRF token returned by
`GET /api/admin/v1/auth/me` in `X-CSRF-Token`, alongside the existing
same-origin request headers. Passwords use Argon2id with 64 MiB memory, three
passes, and one thread. Five failed passwords from one address lock that
address out of that email for 15 minutes, later lockouts growing exponentially
up to 24 hours; an email that belongs to nobody is answered the same way, and a
guesser elsewhere never locks the admin out. Five wrong TOTP codes — the
password was right — lock the admin themselves, on the same schedule. Only a
completed sign-in clears the counts.

The shared RBAC matrix lives in `packages/domain/src/rbac.ts`. Operators receive
operational permissions only; administration, settings, secret-bearing
integrations, balance debits, and anonymization remain admin-only.

Every authenticated admin mutation produces an immutable `audit_log` row. The
interceptor masks password, token, secret, cookie, authorization, TOTP, and API
key fields before writing `before` or `after` values and truncates oversized
objects.

## Administrators (FR-143)

`GET/POST /api/admin/v1/admins`, `PATCH /api/admin/v1/admins/:id`,
`POST /api/admin/v1/admins/:id/reset-password`, `.../reset-totp` and
`.../deactivate` manage administrator accounts. Only the `admin` role may call
them.

The last active `admin` cannot be deactivated or demoted to `operator`: the
request answers `409 LAST_ADMIN`. The check runs inside the same transaction as
the update and locks the remaining admin rows with `SELECT … FOR UPDATE`, so two
concurrent requests cannot each see the other as the survivor.

`reset-totp` clears the stored secret and the `totp_enabled` flag, so the next
login runs the first-login enrolment again. New and reset passwords require at
least twelve characters with a lowercase letter, an uppercase letter and a
digit.

## SSH recovery

If the setup email was mistyped, the password was forgotten, or the
authenticator is unavailable, recover the account from the deployment checkout
over SSH. These commands update only the selected administrator and keep the
PostgreSQL and Valkey data intact.

First list the actual administrator email and account state:

```sh
./scripts/rr admin:list
```

If the password is unknown, reset it. The command also clears the failed-login
counters and any temporary lock, and ends the admin's sessions (a TOTP reset
ends them too):

```sh
./scripts/rr admin:reset-password
```

Enter the email exactly as shown by `admin:list`, then enter a password of at
least twelve characters containing a lowercase letter, an uppercase letter and
a digit. The password is read without echo and is not stored in the audit log.

If the password is known but the TOTP application or secret is unavailable:

```sh
./scripts/rr admin:reset-totp
```

After the next password login, the setup flow displays a new QR code. Register
it in the authenticator and confirm its six-digit code. Resetting TOTP invalidates
the previous TOTP secret; do not run it when the existing authenticator still
works.

The recovery commands create an audit row with a `system` actor and the action
`admins.recovery.reset-password` or `admins.recovery.reset-totp`. They never
write the password or TOTP secret to the database log. Do not use `down -v` or
delete PostgreSQL volumes during recovery.

## Audit contract

Handlers that change state return `Audited(before, after, body?)`. The
interceptor stores the state the handler read _before_ the change, stores the
resulting state, and answers the HTTP request with `body` (defaulting to
`after`). The request body is never stored as `before`; only its `reason` field
is copied into the audit row.

## Session and challenge handling

- The failure counters are atomic increments — the password's in Valkey per
  email and address, the TOTP's in the database — so parallel attempts cannot
  overwrite each other and the fifth failure always locks.
- Each session is listed under its admin, so a password or TOTP reset and a
  deactivation end all of them.
- The TOTP enrolment secret is encrypted with `RR_APP_KEY` before it is written
  to Valkey, exactly like the stored secret.
- Deleting the login challenge is the atomic commit point for issuing a session:
  only the request whose `DEL` removed the key receives `rr_asid`, so a replayed
  code cannot mint a second session.
- CSRF applies to `/api/admin/v1/auth/*` as well. Login and TOTP requests have no
  session yet, so they are checked by origin and `X-Requested-With`; once a
  session exists, `X-CSRF-Token` is also required.

## Console

`/admin` is served without a locale prefix and always uses the neutral `_admin`
theme; its texts come from the shipped `admin.json` only, which section 18.4
keeps outside the owner's override surface. The interface language follows
`settings.locale.default` until an administrator profile language exists.

| Path                                | Content                                                                                   |
| ----------------------------------- | ----------------------------------------------------------------------------------------- |
| `/admin/login`                      | email + password → TOTP, with first-login enrolment and a QR code                         |
| `/admin`                            | FR-142 widgets, revenue and registration charts, "requires attention"                     |
| `/admin/users`, `/admin/users/[id]` | FR-140 search and filters; FR-141 actions behind reason modals                            |
| `/admin/subscriptions`              | Status, plan and expiry filters; bulk extension up to 500 rows                            |
| `/admin/payments`                   | Invoices (number, kind filter) with masked provider events, recheck, transactions, refund |
| `/admin/plans`                      | FR-145 create/edit (squads from the panel), ordering, soft delete                         |

`AdminShell` loads `GET /api/admin/v1/auth/me` once, keeps the CSRF token for
later mutations and hides every section the role does not carry. Server-side,
`@Roles`/`@Permissions` enforce the same matrix, so hiding a control is a
convenience rather than the boundary.

The console's POSTs that create money or subscriptions — extend, set plan,
balance, refund and bulk extension — take `Idempotency-Key` like the
account's (section 9.1): the response is kept 24 h under
`rr:idem:<adminId>:<key>`, and the same request again is answered from it with
`Idempotent-Replay: true` and no second audit entry. The console sends one key
per opened dialog, so confirming again after an answer that never arrived does
not credit, refund or extend twice; another amount under that key is
`422 IDEMPOTENCY_KEY_REUSED`. A failed request keeps nothing and may be retried.

## Plans (FR-145)

The plan form covers every FR-145 field: names and descriptions per locale,
days, traffic and its reset strategy, devices, price, public/active and the
panel's internal squads (`GET /api/admin/v1/panel/squads`). A plan needs at
least one squad (section 8, `CHECK cardinality(squads) > 0`): the panel receives
them as the customer's `activeInternalSquads`, so a plan without any would take
every squad away from its buyers. The API refuses such a plan, and the list
marks an older one with «Нет сквадов» until it is edited.

## Invoices and numbers (F37, ADR-021)

Every provider invoice carries a number `NN-00001`, numbered per provider
(YooKassa 01, Platega 02, Lava 03, Robokassa 04, CryptoBot 05, Telegram Stars
06), the same one the customer sees on `/pay/<id>` and that stands in the
receipt line. `/admin/payments` has a «Номер» column, a «Вид» filter (top-up,
purchase, plan change) and a search by number («Номер счёта»). A gap in the
numbers is normal: the number is issued before the provider is called. A
provider invoice is always a top-up; a purchase is a balance operation with an
invoice of its own and no provider.

## Dashboard aggregates

Every FR-142 number is a SQL aggregate over `transactions`, `subscriptions`,
`users` and `accounts`, cached in Valkey for 60 seconds. Since F37 the
dashboard separates two things. «Поступления» (receipts) is the money
providers brought in, that is the top-ups — and, in the history before F37,
the plans bought at a provider directly; it is what the receipt count, the
average receipt, the daily chart «Поступления по дням» and the top providers
are built from. «Продажи» (sales) is the purchases and plan changes paid from
the balance, minus refunds. This departs from FR-142's
`purchase + topup − refund`, which counted a top-up and the purchase paid from
it twice; the late-payment widget is gone because every provider payment,
late or not, is now just a top-up. The trial conversion is a cohort by trial
date. `test/m4.admin.integration.test.mjs` re-computes each aggregate with an
independent SQL control on fixtures (AC-142) and also covers AC-140 search and
AC-141 audited actions.

## Operator limits

`settings.operator.max_credit_minor` caps an operator's daily total credit and
`settings.operator.max_refund_minor` caps a single refund. An operator can never
debit a balance, run a bulk extension, anonymize a user or edit plans.

## Support (owner decision F36)

`/admin/support` shows the support tickets worked in the operators' Telegram
chat, their statistics, the answer templates and the self-help questions (see
[support.md](support.md)). Beyond section 14.2's matrix, `support.read` (admins
and operators) opens the section and `support.write` (admins) edits templates
and questions. The same limits apply to the card actions in Telegram (extend,
reset traffic, credit), which only a console admin with their Telegram ID set
can run and which are audited like the console's.

## Settings, providers and system (TASK-M4-009)

`/admin/settings` renders the store settings from `GET /settings/schema`, and the
tabs for providers, theme, locales and legal texts. `/admin/admins`,
`/admin/audit` and `/admin/system` complete the section 14.1 list.

### AC-061 — a provider is offered only after a successful healthcheck

`GET /api/admin/v1/providers` reports `offeredToUsers`, which is
`enabled && lastHealthcheckOk === true`. `GET /api/v1/me/payment-methods` uses
the same rule, so a provider that has never been checked, or whose last check
failed, is never offered. Saving a provider configuration runs a healthcheck
immediately, and the console has an explicit «Проверить» action.

### AC-181 — an override reaches the surfaces in time

`PUT /settings` publishes the section 17.6 channels for the keys that changed
(`rr:bot.reconfigure`, `rr:proxy.reload`, `rr:theme.changed`, `rr:i18n.changed`)
and answers with `applied`, `restartRequired` and `reconfigured`. The site
revalidates config, catalogs and theme every five seconds; the bot caches
catalogs for sixty seconds and drops them immediately on `rr:i18n.changed`.

### FR-061 — provider forms

Each provider's form is drawn from its `configSchema`: `GET /api/setup/v1/state`
and `GET /api/admin/v1/providers` list `fields` (`key`, `type` string, number,
boolean or list, `required`, `secret`, `default`), and the setup wizard and the
console's «Платежи» tab render the same fields, with labels and hints from the
locales. A configuration is checked against the schema when it is checked or
saved, and a refused field is `400 VALIDATION_ERROR` with its path; it is stored
with the schema's defaults. In the console «Настроить» edits a provider: enabled,
the name customers see, and the fields. The fields sent replace the stored ones
and a secret left empty keeps its stored value; saving runs the healthcheck.
↑/↓ reorder the providers (`POST /providers/reorder`).

### AC-146 — system page

`GET /api/admin/v1/system` reports the application version, image tags, the last
panel reconciliation, the unpublished outbox depth, the database size, the bot
mode, TLS and backup markers and the health endpoint. `GET /system/queues` gives
waiting/active/failed/delayed per queue and `POST
/system/queues/:name/retry-failed` re-queues failures.

### Journal

`GET /api/admin/v1/audit` filters by actor, action, entity and period. An
operator is restricted to their own rows by the RBAC matrix, and the response
says which scope it returned.

### Locales and legal texts

`GET/PUT /api/admin/v1/i18n/:lang/:namespace` lists the shipped default next to
the active override and applies a patch where `null` clears an override. Every
value is compiled as ICU before it is stored. `GET/PUT
/api/admin/v1/i18n/legal/:doc/:lang` edits a legal document as a whole. Both
invalidate the catalogs, so the site and bot pick the change up inside their
windows.
