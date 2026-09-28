# RemnaRay Development Progress

## Code review repair queue — 2026-09-27 (next work starts here)

Current milestone remains M5 (NOT VERIFIED); TASK-M5-004 remains the sole
milestone task and its gates wait for this queue (owner decision О-18 below).
A full read-only review of `dev@64ecadd` (findings R1–R138) and an independent
re-verification (none refuted; new findings P-1…P-21 and Lows numbered L-1…L-36)
are kept locally, **not tracked** (`docs/development/*` is ignored):
`docs/development/reviews/2026-09-27-full-review.md`,
`verification-2026-09-27.md` and the working queue `repair-queue-2026-09-27.md`.
This section is the tracked record of that queue.

Rules: one repair — one Conventional Commit naming its IDs, with a regression
test shown red on the old code first; fast gates before each push (`pnpm lint`,
`pnpm format`, `pnpm typecheck`, tests of the touched packages,
`pnpm i18n-check`); the integration suites of the touched area after each
package; VPS actions are collected, not executed; a repair that departs from
the specification or needs an unrecorded decision stops for the owner.

Order (О-18): package 0 (CI green) → P-5 remainder and the `ci-ok` check →
1 (money loss: R49, R1, R102, P-1, R74, re-apply backstop) → 2 (security,
limits) → 4 (ledger and balance) → 3 (install, release, rollback) → F37 →
5 (promocodes and prices) → 6 (Remnawave) → 7 (anonymisation) → 8 (bot) →
9 (support) → 10 (worker, notifications, broadcasts) → 11 (web, themes, i18n);
all of it before the M5-004 gates; package 12 (remaining Lows) before the M5
Definition of Done. The unimplemented requirements among the findings (R18,
R19, R29, R41, R46, R48, R55, R68, R119, R124–R126) belong to M1–M4 tasks and
are repaired here, not moved to M6.

**Owner decisions (2026-09-27):**

- О-1 R13 — publish 80/443 on IPv4 only and document "no `AAAA`"; recorded
  deviation from 21.8.
- О-2 P-5 — images `ghcr.io/remnaray/*`. The repository moved to the
  organisation: `https://github.com/RemnaRay/RemnaRay` (local `origin`
  updated). The workflows derive the namespace from `github.repository_owner`;
  `images.yml` has published `:dev` there and the stand's `.env` now reads
  `RR_REGISTRY=ghcr.io/remnaray`. Rulesets `dev` (no deletion, no force push)
  and `releases` (tags `v*`: creation by repository admins only, no update or
  deletion) exist; the `main` ruleset (PR, 0 approvals, merge commits only,
  required check `ci-ok`) waits for the `ci-ok` job.
- О-3 P-7 — FR-023 literally; a plan change to the same plan is refused.
- О-4 P-10/R36 — grace as FR-012: no past `expireAt` to the panel, no
  `disable`.
- О-5 R20/R73 — EX-06 literally (the remainder is credited to the balance, the
  new plan is bought at its full price).
- О-6 R52 — reminder dedup key per period (`event:<subId>:<expiresAt>`).
- О-7 P-13 — link an existing panel user (EX-11) but never shorten its term or
  limits on the first sync; alert.
- О-8 R77 — an operator sees only their own entries in a user's audit tab.
- О-9 R79/L-3 — the account sign-in JWT is single-use and no Bearer token.
- О-10 R92 — Prisma schema pulled from the DDL; CI `migrate diff --exit-code`.
- О-11 R108 — outgoing webhook URLs: https only, no private addresses.
- О-12 R135 — **F37, purchases only from the balance**: providers only top the
  balance up (the missing amount, rounded up to the provider's minimum); the
  customer buys as a second step (a «Купить» button with the credit notice);
  referral rewards only on top-ups («first purchase» → «first top-up»,
  `count_topups` goes); audience self-employed (НПД) or no status — one
  receipt at the top-up, the ИП/ООО advance-and-offset scheme is out of scope.
  A separate feature between packages 4 and 5; deviations from FR-020/021,
  11.2, FR-062 and 15.1–15.2 to be recorded with it.
- О-13 R136 — unban restores a subscription revoked by the ban if its term is
  not over.
- О-14 R137 — Caddy `admin localhost:2019`, metrics on a separate port.
- О-15 R138 — legal texts revalidate within 5 s (AC-181).
- О-16 P-2/P-9/R26 — webhook secret checked before the throttler, counted per
  IP; the web container passes the client IP to the API.
- О-17 P-21 — Valkey gets a password.
- О-19 P-1 — a payment for a plan taken off sale after invoicing goes to the
  balance with an alert.
- О-20 — the stand is redeployed from scratch after the repairs; no data-fix
  scripts.

### Package 0 — CI green

- **R65 Done (local) — `pnpm i18n-check` red since 2026-09-26, CI `quality`
  failing before Build.** Cause: the "ru still reads as English copy" rule
  (four Latin letters and no Cyrillic) flagged 20 ru values — payment brand
  names (`admin.providers.name.*`, `setup.payments.providerName.*`), OS names
  (`bot.btn.guide.*`), CryptoBot's English menu path (`*.hint.token`), and two
  templates whose only Latin is markup (`<code>{code}</code> — {title}`,
  `bot.support.card.user`); F12, F36 and the subscription screens never ran
  the gate. Repair (`tools/i18n-check.ts`): the rule reads the visible text —
  HTML tags, entities and ICU argument names are removed first — and the 18
  brand/OS/path keys are allowlisted by exact key, so a new English value
  under a neighbouring key still fails. Evidence: `test/tooling.test.mjs`
  «the locale check passes on the committed catalogs» (red: 20 problems →
  green) and «still flags English copy in ru, key by key» (a copy of the
  catalogs with `admin.providers.name.yookassa`=`YooKassa` and `admin.title` in
  English must fail with exactly those 2; red: 22 → green). Checks:
  `pnpm i18n-check` (2286 messages), lint, format, typecheck, root tests 56/57 — the
  one failure is local only and not R65: «every relative link in the
  documentation resolves» walks the file system and reads the untracked
  review file; on a clean worktree with this change it passes 6/6. No
  integration suite covers the tool. **Not yet verified:** the CI `quality`
  job on GitHub (runs on the next push). VPS action: none.
- Found while repairing: `test/docs.test.mjs` scans ignored local files
  (`docs/development/reviews/*`); queued in package 12 (list only tracked
  files).

### After package 0 (owner decisions О-2 and the rulesets)

- **CI Done (local) — CI never ran on `dev`, and no stable required check
  existed.** Found when the owner pushed R65: `ci.yml` ran only on pushes to
  `main` and on pull requests, so direct pushes to `dev` were never checked;
  the check names change with the Node version of the quality matrix
  (`quality / Node 24.21.0`), which would leave a `main` ruleset waiting for a
  check that no longer reports. Repair: `push` also on `dev`; a `ci-ok` job
  (`if: always()`, `needs` quality, e2e, proxy, docker, proxy-smoke) fails
  when any of them failed, was cancelled or skipped — the one check the
  `main` ruleset requires; Lighthouse measures and does not block.
  `needs.<job>.result` values and `always()` checked against the GitHub
  Actions documentation (contexts, workflow syntax) on 2026-09-27.
  CONTRIBUTING describes it. Evidence: `test/tooling.test.mjs` «CI runs on
  dev pushes and gathers the blocking jobs into one required check» red on
  the old workflow → green; the workflow parses (PyYAML); lint, format,
  tooling and proxy-smoke tests 36/36. **Not yet verified:** a run on
  GitHub (the next push to `dev`). Owner action: create the `main` ruleset
  with the required check `ci-ok` once it has reported once.

### The first CI run on `dev` (run 36330571112, 2026-09-27)

`quality` (with R65), `e2e`, `docker`, `proxy` and Lighthouse passed; `ci-ok`
failed as designed because both `proxy-smoke` profiles failed. No CI had run
since 2026-09-20, so three regressions from 2026-09-25/26 had gone unseen.
One commit each:

- **Done — nginx sent `X-Content-Type-Options` twice for theme assets.**
  Since `d4827de` (2026-09-25) `web` sends `nosniff` with every theme asset
  (sandboxed SVGs), and `security-headers.inc` adds it again; Caddy's
  `header` replaces, so only nginx doubled it. Repair: nginx hides the upstream's
  `X-Content-Type-Options` (`proxy_hide_header`) in its `/themes/` location. Evidence:
  `test/m5.proxy.integration.test.mjs` «a security header the upstream also
  sends reaches the client once» (real nginx and Caddy before an upstream
  that sends `nosniff`) red on nginx (2 headers) → green on both; `test:m5`
  10/10, lint, format, proxy tests.

- **Done — the e2e validation test expected the client's `X-Request-Id`
  behind the proxy.** The test added with F8 (`0e385a1`) sent
  `x-request-id: e2e-validation-1` and required it back as `requestId`;
  behind either proxy the id is the proxy's own (section 21: the proxy
  generates `X-Request-Id` and passes it upstream; 9.3: `requestId` comes from
  that header), so the smoke run failed while the proxy was right. The test
  now requires `requestId` to be the `X-Request-Id` the API answered with, and
  the sent value only on a direct call. Evidence: the CI failure (both
  profiles); locally on the direct stack the test passes with the strict
  branch; the smoke profile is confirmed by the next CI run.

- **Done — the smoke stand had no promo code for the account spec.** The
  test added with `d2dc6e0` (2026-09-26) previews `e2e10`, which
  `e2e/setup/stack.mjs` creates for the local stack; the smoke stand is seeded
  with the section 22.3 fixture (`seed-dev`), which has no promo codes, so the
  preview never showed 269,10 ₽. `proxy-smoke.sh` now creates `E2E10` right
  after the fixture (the fixture itself stays as 22.3 defines it). Evidence:
  `test/proxy-smoke.test.mjs` «both stands the browser suite runs on create the
  promo codes it types» red (the smoke script did not) → green; the `INSERT`
  checked on PostgreSQL 18 after all migrations; locally the spec passes on
  the direct stack; the smoke profile is confirmed by the next CI run.

### P-5 remainder (after the repository moved)

- **P-5 Done (local) — the delivery still named `VAQYBIN/remnaray-astra`.**
  After the move to `RemnaRay/RemnaRay` (О-2) the cosign identity in
  `docs/install.md` would have refused every signature of the organisation's
  releases, the clone commands and badges pointed at the old name, and the
  daily update check (`UPDATE_REPOSITORY`) only worked through GitHub's
  redirect. Repair: `RemnaRay/RemnaRay` in `docs/install.md` (clone and
  `--certificate-identity-regexp '^https://github\.com/RemnaRay/RemnaRay/\.github/workflows/(release|rebuild)\.yml@'`,
  identity format checked against the Sigstore cosign documentation),
  both READMEs, `update-check.ts` and `.env.example`; `CODEOWNERS @VAQYBIN`
  stays (the account is the owner). The image namespace needed no change:
  the workflows derive it from the repository owner and compose already
  defaults to `ghcr.io/remnaray`. Evidence: `daily-checks.test.ts` expects
  `api.github.com/repos/RemnaRay/RemnaRay/releases` (red → green);
  `test/docs.test.mjs` «the delivery names the repository RemnaRay/RemnaRay»
  (identity, clone commands, the constant, no tracked file but this history
  with the old name) red → green; docs tests 7/7 on a clean worktree, worker
  30, lint, format, typecheck. **Not yet verified:** `cosign verify` against
  a release signed from the new repository (no release exists yet).

### Package 1 — money loss

- **R49 Done (local) — every `payments.apply-event` job ended `failed` after
  the payment had been applied.** Cause: the apply endpoint
  (`POST /api/internal/v1/payments/events/:id/apply`) returned `undefined`, so the API
  answered 201 with an empty body and the worker's `call()` failed on
  `response.json()` (`SyntaxError: Unexpected end of JSON input`); BullMQ then
  retried four more no-op applies and parked the job in `failed`, burying real
  apply failures in `/admin/system` and `rr_queue_jobs{state="failed"}`. No
  money effect: the apply had committed and repeats are no-ops. Repair: `call()`
  reads the text and parses only a non-empty body (an empty body is `null`,
  a refused call still throws); `PaymentsService.applyEvent` answers
  `{ applied: true }`. Evidence: `apps/worker/src/queues/worker-call.test.ts`
  (a real HTTP server answering 201 without a body) red `SyntaxError` → green;
  `payments.service.test.ts` «answers the worker with a body» red
  (`undefined`) → green. Checks: worker 33, API 394, lint, format, typecheck,
  i18n-check. VPS action: after deploy clear the accumulated failed jobs of
  the `payments` queue.

- **R1 Done (local) — a Stars payment the shop failed to record was
  acknowledged and lost.** Cause: F2 (`fd64949`) made the ingress XACK every
  `BotError`, and grammY wraps every middleware failure in one, so a
  `successful_payment` whose `stars/successful-payment` call failed (API
  restart, 5xx, 10 s timeout) — or whose update failed earlier, in the upsert
  or the catalog middleware — was answered `error.generic` and acknowledged;
  Telegram never redelivers it, so the stars were taken and no
  `payment_events` row existed (a regression of 2a, whose design is "the bot
  stream is the retry"). Also `botErrorHandler` threw on a context without
  `ctx.t` (catalog never bound). Repair (`apps/bot/src/ingress.ts`): an update
  carrying `message.successful_payment` whose handling failed is never
  acknowledged — it stays in the PEL and `XAUTOCLAIM` redelivers it; the
  error handler runs (log + reply) on the first delivery only, a redelivery
  is logged with the update id and the delivery count, never the payload.
  Every other failed update is still acknowledged (F2). `botErrorHandler`
  answers a payment update with the new `bot.payment.received` (payment
  received, being credited, incident id) instead of `error.generic`, and
  skips the reply without `ctx.t`. The misleading comment in
  `screens/stars.ts` and `docs/payments/stars.md` describe the path.
  Invariants: a taken Stars payment is either recorded (idempotent by
  `telegram_payment_charge_id`) or still pending in the stream; the customer
  gets one answer. Evidence: `ingress.test.ts` «keeps a successful_payment
  the shop failed to record pending» (API 503) and «keeps it pending when a
  middleware before the payment handler fails» red (XACK called) → green,
  «answers the customer on the first delivery only» red (3 replies) → green;
  `errors.test.ts` «tells the customer the payment is received» red (generic)
  → green and «logs and does not fail when the catalog never loaded» red
  (`TypeError: ctx.t is not a function`) → green. Checks: bot 85, lint,
  format, typecheck, i18n-check (2288). Until R102 a payment update that can
  never be recorded is retried every minute without a limit or alert. VPS
  action: after deploy compare the bot's `getStarTransactions` with the
  `stars` rows of `payment_events` for payments already lost.

- **R102 Done (local) — the bot stream retried a failing entry forever, and
  one failure held up its batch.** Cause (2a «Recorded debts», half-closed by
  F2 and reopened for payments by R1): no delivery count was read, an entry
  that could not be handled at all (bad envelope, JSON or `update_id`, bot not
  initialised) was reclaimed every 60 s with no limit or alert, and its throw
  left the rest of its batch of ten waiting another minute. Repair
  (`apps/bot/src/ingress.ts`): a claimed entry reads its delivery count with
  `XPENDING <stream> <group> <id> <id> 1` (a new entry is delivery 1); every
  entry has its own try/catch; at `MAX_DELIVERIES = 5` (about five minutes) a
  non-payment entry is written to `<stream>:dead` (`MAXLEN ~ 1000`: id,
  payload, reason, deliveries) and then acknowledged; a `successful_payment`
  is never acknowledged on failure, and from the fifth delivery the shop
  ingress raises `payment.stars_stuck` through the new `ApiClient.alert`
  (`POST /api/internal/v1/notify/alert`; the API sends one per type per hour,
  FR-163), a failed alert only logged. Logs carry the entry id, the count and
  the error class — not the message, since `JSON.parse` quotes its input.
  Contract checked on 2026-09-28 against the Valkey documentation (Context7
  `/valkey-io/valkey-doc`: XPENDING's extended form is `[id, owner, idle ms,
times delivered]`; `XAUTOCLAIM` without `JUSTID` increments the count),
  ioredis 5.11.1 `xpending(key, group, start, end, count)`. The alert type
  extends the 16.x list (like `payment.after_cancel`). Evidence:
  `ingress.test.ts` «delivery limit (R102)» — dead-letter at 5 and not at 2,
  the batch goes on after a broken entry, a payment is kept and alerted at 5
  (and not at 4, also when the failure is not a `BotError`, and when the
  alert fails) — red (no batch handling or count existed) → green, and the
  payload-free log red (the parse message quoted it) → green;
  `api-client.test.ts` `alert()` red → green. Checks: bot 91, lint, format,
  typecheck, i18n-check (2290). VPS action: after deploy check
  `XLEN tg:updates:dead`.
- Follow-up to R1/R102: the new bot tests built `ApiClientError` without its
  `code`, which the root `pnpm typecheck` does not cover but the bot's own
  `tsc -p tsconfig.json` (`pnpm build`) refuses; found by the first
  `pnpm build` of P-1 and fixed in the tests. `pnpm build` is now part of each
  repair's gates.

- **P-1 Done (local) — a payment for a plan taken off sale after invoicing
  was never credited, silently.** Cause: `applyEvent` reached
  `activateSubscription`, which throws `PLAN_UNAVAILABLE` for an inactive or
  deleted plan, and the whole transaction rolled back — on the inline apply
  (the webhook still answered 2xx), on all five `payments.apply-event` retries
  and on every poll; no `process_error`, no alert; for Stars nothing ever
  recovers it. A normal trigger: switching a plan off while someone's 30–60
  minute invoice is open. Repair (`payments.repository.ts`, owner decision
  О-19): inside the apply transaction the plan of a plan invoice is read; one
  that is not available (`planAvailable`, shared with `activateSubscription`)
  sends the money to the balance exactly like the late branch — `topup`
  transaction, `provider_clearing → user`, `payment.to_balance`, invoice
  `paid`, the same reward hooks — with the new `payment.plan_unavailable`
  alert (after underpaid, after_cancel and late in priority). The three
  repeated "to balance" conditions became one `toBalance`. Invariants: one
  transaction per invoice; no revenue and no subscription without an
  available plan; the ledger matches the balance. The alert type extends the
  16.x list. Evidence: new `test/m2.payment-recovery.integration.test.mjs`
  (PostgreSQL 18; added to `test:m2`) «a payment for a plan taken off sale
  goes to the balance» red (invoice `pending`, `PLAN_UNAVAILABLE` in the log)
  → green (paid, one `topup` of 29900, balance 29900, one clearing→user
  entry, no subscription, alert and notice queued, event processed).
  Checks: API 394, `m2.payment` + `m2.stars` 2/2, build, lint, format,
  typecheck, i18n-check (2292); `docs/payments/README.md`. VPS action: none.

- **P-1 part 2 Done (local) — a plan that had been sold could be deleted.**
  Cause: `PlansRepository.remove` refused only when `transactions.plan_id`
  named the plan, and payment transactions carry `invoice_id` instead, so
  `PLAN_HAS_SALES` never fired for real sales. Repair: a sale is a `paid`
  invoice for the plan (or, as before, a transaction naming it); both counts
  are read before the soft delete. Evidence: `plans.repository.test.ts`
  «refuses a plan with a paid invoice, though no transaction names it» red
  (resolved, plan deleted) → green; «deletes a plan nobody paid for» green.
  Checks: API 396, build, lint, format, typecheck. VPS action: none.

- **R74 Done (local) — a payment could deadlock with another money path of
  the same people.** Cause: `applyEvent` locked `{provider_clearing, user}`
  for its first entry and `{user, revenue}` for the second, while
  `settleBalance` and `refund` take `revenue` first (the lowest id, seeded by 0001) — a balance purchase or refund of the same user closed the cycle and
  PostgreSQL aborted one side (40P01). Checking `onPaid` as the queue asked
  found a second cycle: the referral reward (`referrals.engine.ts post()`)
  locks `referral_expense` and the referrer's account only through its
  `UPDATE`s, after the payment's own locks, so a referee's top-up and the
  referrer's own payment could wait on each other whenever the referrer's
  account id is below the clearing account's. Repair: `lockAccounts` in
  `payments.repository.ts` ensures and locks, in one `SELECT … ORDER BY id
FOR UPDATE`, the payer's account, the provider's clearing account, `revenue`
  when revenue moves and — when the reward hooks run and the payer has a
  non-rejected attribution — the referrer's account and `referral_expense`;
  it runs before the first entry in `applyEvent`, `creditSecondCharge`,
  `settleBalance` and `refund`, so every path takes the same rows in one
  global order (the later per-entry locks are already held). PostgreSQL 18
  (Context7 `/websites/postgresql_18`, `SELECT` locking clause) sorts before
  it locks, and `id` never changes, so the order holds. Evidence:
  `m2.payment-recovery` «a purchase does not deadlock with a balance purchase
  on revenue» and «a top-up does not deadlock on the referrer it rewards» —
  deterministic: B holds one account, waits until the apply shows
  `wait_event_type = 'Lock'`, then takes a second — red (`40P01 deadlock
detected`) → green. Checks: API 396, `m2.payment`, `m2.stars`,
  `m4.rewards`, `m4.admin` 4/4, build, lint, format, typecheck. VPS action:
  none.

- **Backstop Done (local) — nothing re-applied a stored payment event whose
  apply never finished** (closes the tails of R1, P-1 and R74). Cause: an
  event is applied inline and by its `payments.apply-event` job (5 attempts
  in ~30 s); if the API stopped between the insert and the job, every attempt
  failed, or a Stars apply failed after its insert (Stars queue no job and
  are not polled), the row stayed `processed_at IS NULL` forever with no
  `process_error` and no alert. Repair: migration
  `0011_payment_events_unapplied` — partial index
  `ix_payment_events_unapplied_p ON payment_events (received_at) WHERE
processed_at IS NULL AND signature_ok` (reversible); repository
  `unappliedEvents(before, limit)` and `markEventError` (only
  `process_error`, which the 0002 guard allows); `PaymentsService.reapplyUnapplied`
  applies up to 100 signed unprocessed events older than two minutes, oldest
  first, keeps a failure's code or error on the event and goes on, and queues
  one `payment.unapplied` alert per event still unapplied after fifteen
  minutes (`jobId alert:payment.unapplied:<eventId>`, not queued twice);
  `POST /api/internal/v1/payments/reapply-events`; the worker's `cronJobs`
  adds `payments.reapply-events` every five minutes
  (`payments:reapply-events:<slot>`), and `paymentCall` is a `switch` with an
  explicit case (its fallback to `expire` stays for R106, package 10).
  Applying twice is safe: `applyEvent` locks the event row and returns once
  `processed_at` is set. The job extends the 7.3 table and the alert the 16.x
  list. `docs/payments/README.md` describes it. Evidence:
  `payments.service.test.ts` (three cases: re-apply and record, alert after
  15 min, no second alert) red → green; `schedule.test.ts` five-minute slot
  and new `payment-call.test.ts` red → green; `packages/db` migration test red
  → green; `m2.payment-recovery` «an event whose apply never finished is
  applied later» (lost event applied and credited, broken one keeps
  `SyntaxError` in `process_error` and one alert, a fresh one untouched,
  index present) red → green. Checks: API 399, worker 38, db 7, build, lint,
  format, typecheck, i18n-check (2294), `test:m1` 7/7. VPS action: migration
  0011 applies at start.

**Package 1 status (2026-09-28): repairs done and verified locally; NOT
VERIFIED on CI, live Telegram or the VPS.** All seven items are committed one
per repair (plus one test-only follow-up). After the last commit: `test:m1`
7/7, `test:m2` 8/8 (with the new `m2.payment-recovery`), `test:m4` 7/7,
API 399, bot 91, worker 38, db 7, build, lint, format, typecheck,
i18n-check (2294). `pnpm test` 59/60: the one failure is the known local-only
docs-link test reading the untracked review files (package 12), not this
package. `test:m5` was not run: nothing in proxy, backup or Grafana changed.
Not yet verified: the CI run on GitHub (after the next push); a real Stars
payment through the ingress and `payment.stars_stuck` delivery (no live
Telegram here); migration 0011 and the new cron on the stand. Specification
extensions made by this package, all named by the repair queue: alert types
`payment.stars_stuck`, `payment.plan_unavailable`, `payment.unapplied`
(16.x list) and the job `payments.reapply-events` (7.3 table). M5 stays NOT
VERIFIED; TASK-M5-004 is unchanged.

VPS actions after deploying package 1: compare the bot's
`getStarTransactions` with the `stars` rows of `payment_events` (R1); clear
the failed jobs of the `payments` queue (R49); confirm migration 0011 applied
at start; check `XLEN tg:updates:dead` (R102).

### Package 2 — security, limits, intake availability

Owner decisions taken while planning this package (2026-09-28), beyond the
list above:

- P-9 — the web container's own server-side requests (a socket inside the
  compose network and no `X-Forwarded-For`, which both bundled proxies and the
  edge always set) are not counted in the anonymous 60/min bucket. The client
  IP is not passed on every SSR fetch: Next 16.3.5 puts request headers into
  the data-cache key (`incremental-cache` `generateCacheKey`), so a per-client
  header would make the cache per client.
- R81 — wrong passwords are counted and locked per (email, IP) in Valkey with
  the 9.2 durations (15 min, doubling to 24 h); an unknown email behaves the
  same. Recorded deviation from 9.2 (`admins.locked_until`).
- L-3 — `/auth/tg?token=` shows a «sign in as <name>?» page and signs in only
  on the button. Recorded deviation from 9.2 (`GET /api/v1/auth/tg` → 302).

- **R4 Done (local) — the api and worker request logs carried cookies,
  tokens and the webhook secret.** Cause: `LoggerModule.forRoot` had only a
  level; pino-http's default request serializer writes the URL with its query,
  the query and every header, and nestjs-pino binds that `req` to every line
  logged inside a request, so `rr_sid`/`rr_asid`/`rr_setup`, `Set-Cookie`,
  `X-Internal-Token`, `X-Telegram-Bot-Api-Secret-Token` and
  `/tg/webhook/<secret_path>`, `X-CSRF-Token`, provider signature headers and
  `/auth/tg?token=<jwt>` reached `docker logs` (19.6, NFR-007, ADR-012);
  `packages/logger` existed but no app used it. The external profile's edge
  logged nginx's `combined` format, whose request line carries the query.
  Repair: `@remnaray/logger` exports `httpLoggerOptions({ service, level })`
  — `base.service`, the redaction list (extended with the internal token,
  webhook secret, CSRF, idempotency and signature headers and
  `res.headers["set-cookie"]`), request and response serializers from an
  allowlist (`id, method, url, remoteAddress`; `statusCode`), the URL without
  its query and `/tg/webhook/***` for the webhook — and `requestId`, the
  proxy's `X-Request-Id` when well formed (20.1), used as Fastify's
  `genReqId` in api and worker, since the logger reuses Fastify's id. api and
  worker take their `LoggerModule` parameters from `logging.ts`. `edge.conf`
  logs a JSON format with `$uri` and the `Referer` without its query (a page
  opened from `/auth/tg?token=` sends it as its assets' referrer).
  Contract checked on 2026-09-28 (Context7 `/pinojs/pino-http`: options,
  `genReqId`, wrapped serializers, stream as second argument;
  `/iamolegga/nestjs-pino`: `pinoHttp` as options or `[options, stream]`).
  Evidence: `apps/api/src/logging.test.ts` (Nest + Fastify + the module's
  parameters, `POST /tg/webhook/SECRETPATH?token=…` with cookie, internal
  token, webhook secret, CSRF and a `Set-Cookie` reply, plus a warning logged
  in the handler) red — every value in the output — → green;
  `apps/worker/src/logging.test.ts` the same red → green;
  `proxy-render.test.ts` «edge access log» red (no named format, then the raw
  referrer) → green, and the rendered edge answers a real `nginx:1.30-alpine`
  request `?token=` with `"uri":"/auth/tg"`, `"referer":"https://shop/auth/tg"`;
  `packages/logger` tests for the new paths (22.2), `logUrl`, `requestId` and
  the serializers. Checks: logger 5, API 401, worker 39, build (both built
  apps load the ESM package), lint, format, typecheck, i18n-check (2294).
  Known residual: nginx's error log (`warn`) writes the request line and
  referrer of a failed upstream request as they are, query included; its
  format cannot be changed. VPS action: after deploy rotate
  `RR_INTERNAL_TOKEN`, change the bot webhook secret path and token, delete
  `rr:asess:*`, and clear the old container logs.

- **R113 Done (local) — the proxies' access logs kept the webhook
  `secret_path`.** Cause: nginx's `rr_json` format logged `$uri` and Caddy's
  filter removed only the query's `token`, so every Telegram update wrote
  `/tg/webhook/<secret_path>` to `docker logs` (19.6 forbids it; 21.4: the
  sensitive fields are cleaned in both proxies); the `Referer` kept its query,
  and a page opened from `/auth/tg?token=` sends that URL as its assets'
  referrer. Repair: nginx (`nginx.conf.tmpl`) and the external edge log
  `$rr_log_uri` (`map $uri`: `/tg/webhook/***`) and the referrer without its
  query; Caddy's filter drops the referrer's query and rewrites `request>uri`
  with two `regexp` filters — the webhook path to `/tg/webhook/***`, then the
  whole query (before: only `token`). Contract checked on 2026-09-28
  (Context7 `/caddyserver/website`, `log` › `filter` › `regexp`); two
  `regexp` filters on one field applied in order was tried on
  `caddy:2.11.4-alpine`, the version the image pins. Evidence:
  `proxy-render.test.ts` «proxy access logs» (nginx format and map, edge,
  Caddy filters) red → green; `test/m5.proxy.integration.test.mjs` «Section
  19.6: the access logs carry neither the webhook secret path nor a query
  token» — real nginx and Caddy images, a signed-looking
  `POST /tg/webhook/SECRETPATH?token=…` and `GET /auth/tg?token=…` with a
  tokened `Referer` — red on nginx (`"uri":"/tg/webhook/SECRETPATH"`,
  `"referer":"…?token=REFERERTOKEN"`) → green on both. Checks: `m5.proxy`
  6/6, API proxy-render 33, lint, format, typecheck; `pnpm test` 59/60 (the
  known local-only docs-link failure on the untracked review files). VPS
  action: none (the proxy re-renders on deploy).

- **R82 Done (local) — the bot logged with `console.error`.** Cause: 19.6 and
  20.1 require pino JSON lines with the shared redaction in every service; the
  bot printed `util.inspect` objects (multi-line, no `level`/`service`, no
  `RR_LOG_LEVEL`, no redaction), and its configuration failures were logged
  without any cause. Repair: `apps/bot/src/logger.ts` — `createLogger` from
  `@remnaray/logger` with `service: bot` at `RR_LOG_LEVEL`, written through
  `process.stdout.write` — replaces all 13 `console.error` calls in `bot.ts`,
  `support-bot.ts`, `ingress.ts` and `main.ts` with the same fields; the four
  configuration failures in `main.ts` log `failureOf(error)`: the class,
  status, code, Telegram code and method, never the message (which can quote
  the Bot API URL with the token). Evidence: `errors.test.ts` «writes one
  pino JSON line with the incident id and no token» (an `HttpError` whose
  cause quotes `…/bot123:SECRETTOKEN/…`) red (no JSON line) → green;
  `logger.test.ts` `failureOf`; the existing error and ingress tests read
  the logger instead of `console`. Checks: bot 93, build (the built bot
  writes `{"level":50,…,"service":"bot",…}`), lint, format, typecheck,
  i18n-check (2294). VPS action: none.

- **R28 Done (local) — provider callbacks were stored with their signatures
  and every request header.** Cause: `receiveWebhook` wrote the parsed body and
  the full `@Headers()` map to `payment_events.raw`/`headers` (19.1 requires
  the provider's `secret`, `token`, `password`, `Signature*`, `X-Secret`
  fields masked): Robokassa's `SignatureValue` (`md5(OutSum:InvId:Password2…)`,
  unsalted) sat in the database and every backup, and `headers` kept cookies,
  authorization and the Lava/CryptoBot signature headers — for unverified
  events, whatever a sender chose to post. Only the console masked `raw` on
  display. Repair: `payments/payment-event-mask.ts` — `maskEventRaw` replaces
  any body field whose name contains `secret`, `token`, `password` or
  `signature` with `***` (nested, arrays included), and `eventHeaders` keeps
  `content-type`, `user-agent`, `x-request-id` and the source `ip` (19.5);
  both run after the signature was checked on the unmasked body and before
  `insertEvent`. The deduplication key and `applyEvent`'s fields
  (`paidAmountMinorRub`, added after masking) are untouched. No data fix
  (О-20). `docs/payments/README.md` describes it. Invariants: duplicate events
  still dedupe on the provider's id or the raw body's hash; the ledger path is
  unchanged. Evidence: `payments.service.test.ts` «stores a Robokassa event
  without its signature or the request's secrets» (a verified ResultURL with
  `SignatureValue`, a body `token`, and cookie/authorization/signature/
  `x-secret` headers) red (`SignatureValue` in `raw`) → green. Checks: API
  405, `test:m2` 8/8, lint, format, typecheck. VPS action: none for the code
  (the stand is recreated, О-20); if a database dump or backup may have
  leaked, change Robokassa's Password1/Password2.

- **R84 Done (local) — outgoing webhook URLs were copied into the outbox in
  clear.** Cause: `webhooks.outgoing` is a secret setting (encrypted, URL and
  secret), but `dispatch` wrote each recipient's full URL into
  `outbox_jobs.payload` and so into the BullMQ job data in Valkey; such URLs
  often carry a token (`https://hooks…/T0/B0/<token>`, `?key=`), which then
  sat unencrypted in the database, its backups and Valkey. Repair:
  `dispatch` names the recipient by `recipientKey(url)` (the 16-hex SHA-256
  prefix the job id already used); `deliver` finds the recipient in the
  settings by that key — it already read the secret there on every attempt —
  and still accepts a job queued with `url` before this change. Evidence:
  `webhooks.service.test.ts` «dispatches one delivery per enabled recipient»
  now requires `{ event, recipient }` and no URL in the rows, red (the URL
  in the payload) → green; «still delivers a job queued with the recipient's
  URL before R84» green; the delivery tests address recipients by key.
  Checks: API 406, `m4.webhooks` 1/1 (dispatch → outbox → worker → signed
  delivery), build, lint, format, typecheck. VPS action: none.

- **P-2 Done (local) — anyone could shut the webhooks out with forged
  requests.** Cause: the section 9.1 webhook bucket was one per provider
  (`webhook:<provider>`, 600/min) and the global `ThrottlerGuard` counted a
  request before its controller checked the secret or signature, so 600
  forged `POST /tg/webhook/x` (or `/webhooks/<provider>`) a minute from one
  address — nginx's `rr_webhooks` lets 30 r/s through per IP — made every
  genuine Telegram update and provider notification answer 429 and blocked
  the bucket for 60 s. Repair (owner decision О-16): the throttler is now
  `WebhookThrottlerGuard` (`ThrottlerGuard` with the same options and
  storage), which refuses a `/tg/webhook/<path>` request whose path and
  `X-Telegram-Bot-Api-Secret-Token` match no bot with 403 before it counts;
  the match — shop bot and support bot — moved from the controller to
  `bot/telegram-webhook-target.ts`, used by both. Payment signatures need the
  body and the provider's configuration, so they stay in the service; for
  them, and for Telegram, the bucket is now the provider's per address
  (`webhook:<provider>:ip:<ip>`, 600/min). Recorded deviation from 9.1
  («600/min per provider» → per provider and sending address). Contract
  checked on 2026-09-28: Context7 `/nestjs/throttler` (extending
  `ThrottlerGuard`, `canActivate`/`shouldSkip`) and the installed 6.7.0
  typings (constructor with `@InjectThrottlerOptions`,
  `@InjectThrottlerStorage`, `Reflector`). Evidence:
  `auth.throttler.test.ts` per-address trackers red
  (`webhook:yookassa`) → green; `webhook-throttler.guard.test.ts` — a forged
  Telegram webhook (wrong token, wrong path, malformed escape) is refused
  without touching the store, a genuine one counts; 601 notifications from
  one address do not block another — red with the stock guard behaviour
  (forged accepted; the second address 429) → green. The built API on the e2e
  stack (PostgreSQL, Valkey) booted with the new guard and answered 650
  forged Telegram webhooks in a row with 403, none with 429. Checks: API 408,
  `test:m1` 7/7, build, lint, format, typecheck. VPS action: none.

- **P-9 + R26 Done (local) — every page render and bot sign-in shared one
  anonymous bucket of 60 a minute.** Cause: the web container calls
  `api:3000` directly for page data (theme, ten i18n namespaces, config,
  plans, legal — `revalidate` 5 s to 5 min), the setup state and, from
  `/auth/tg`, the bot sign-in exchange; none of it carries a client address,
  so the throttler counted all of it as `ip:<web>`, 60/min. Page data alone
  can exceed that (P-9: stale or fallback theme, empty `botUsername`, AC-181),
  and anyone sending 61 `GET /auth/tg?token=x` a minute made «Open account»
  fail for every customer (R26). Repair (owner decision, 2026-09-28):
  `skipThrottleForInternal` also passes a request whose socket is inside
  `RR_TRUSTED_INTERNAL_CIDR` and which has no `X-Forwarded-For` — both
  bundled proxies and the external edge always set it, so a visitor never
  qualifies; visitors stay limited at the proxy and, through it, by their own
  address. The client IP is not forwarded on page data: Next 16.3.5 puts
  request headers in its data-cache key, so it would split the cache per
  visitor. Recorded deviation from 9.1 (the web server is not an anonymous
  visitor). With L-3 the sign-in exchange moves to the browser, where it is
  counted per visitor again. Evidence: `auth.throttler.test.ts` «the web
  container's own requests» — direct requests from the compose network
  (IPv4 and IPv4-mapped) are not counted, red → green; a proxied request is
  still `ip:<visitor>` and a direct request from outside, with or without a
  forged `X-Forwarded-For`, still counted (green before and after);
  `proxy-render.test.ts` «every proxy forwards the client address» pins the
  assumption (nginx sets it for every location and none overrides the
  headers, the edge sets it, Caddy keeps its default). Checks: API 414, lint,
  format, typecheck. VPS action: none.

- **R13 + L-34 Done (local) — an IPv6 visitor could pass as any address.**
  Cause: the proxies published 80/443 without a host address, so on all of
  the host's IPv4 and IPv6 addresses; `rr_net` is IPv4 only, so Docker's
  userland proxy carries an IPv6 connection into it from the network's
  gateway, 172.28.0.1 — inside `set_real_ip_from` / Caddy's
  `trusted_proxies` (172.28.0.0/16, template 21.3/21.4). An IPv6 client's
  `X-Forwarded-For` was believed: the admin allowlist, `rr_signin`/`rr_admin`,
  the API throttler and the setup-token lock were bypassed, `/metrics`
  answered (the gateway is in its `allow`), and all IPv6 visitors shared one
  bucket (`limit_conn` included). L-34: nginx's `listen [::]` also refuses to
  start on a kernel booted with `ipv6.disable=1`. Repair (owner decision
  О-1): `compose.yaml` publishes `0.0.0.0:80:80`, `0.0.0.0:443:443`,
  `0.0.0.0:443:443/udp` for both proxies; no nginx server (site, bootstrap,
  the extra-domains redirect the renderer writes, the external edge) listens
  on `[::]`; `docs/install.md` asks for an `A` record and no `AAAA`, and says
  why. Recorded deviation from 21.8 («`AAAA` with IPv6») and from the 21.3
  listeners. Contract checked on 2026-09-28 (Context7 `/docker/docs`, bridge
  driver: «To restrict a published port to IPv4 only, the address must be
  included in the container's publishing options. For example,
  `-p 0.0.0.0:8080:80`»); on the local engine `-p 18080:80` binds `0.0.0.0`
  and `[::]`, `-p 0.0.0.0:18080:80` only `0.0.0.0`, and `docker compose
config` renders `host_ip: 0.0.0.0` for all six ports. Evidence:
  `test/tooling.test.mjs` «the proxies publish their ports on IPv4 only»
  (compose ports, install guide) red → green; `proxy-render.test.ts` «IPv4
  listeners» (every rendered nginx file, with and without a certificate and
  with an extra domain, and the edge) red → green. Checks: `m5.proxy` 6/6
  (`nginx -t` in every TLS mode, Caddy), API 415, lint, format, typecheck;
  `pnpm test` 60/61 (the known local docs-link failure). VPS action: after
  deploy, `ss -tlnp | grep -E ':(80|443) '` shows only `0.0.0.0`; remove the
  domain's `AAAA` record if there is one.

- **R24 Done (local) — the external profile served `/metrics` to the
  Internet.** Cause: `edge.conf` forwarded `location ^~ /metrics` to the API,
  and the API checks only its socket's address — behind the edge that is the
  edge's own compose address, inside `RR_TRUSTED_INTERNAL_CIDR` — so
  `https://shop/metrics` through the owner's proxy returned revenue, invoice
  and queue counters (19.7: `/metrics` only from the compose network; 21.7
  routes only `/api`, `/webhooks`, `/tg` to the API). Repair: the edge
  answers `location ^~ /metrics` itself with 404, like `/api/internal/`;
  Prometheus scrapes `api:3000` directly; `docs/external-proxy.md` no longer
  draws `/metrics` through the edge. Evidence: `proxy-render.test.ts` «the
  external edge and /metrics» red (proxied) → green; the real
  `nginx:1.30-alpine` with the edge config passes `nginx -t` and answers
  `/metrics`, `/metricsx` and `/api/internal/…` with 404. Checks: API
  proxy-render 38, lint, format; `pnpm test` 60/61 (the known local
  docs-link failure). VPS action: none (the stand runs the nginx profile).

- **R25 Done (local) — the external-profile guide made every visitor one
  address.** Cause: `docs/external-proxy.md`, `install.md`,
  `troubleshooting.md` and `.env.example` told the owner to set
  `RR_TRUSTED_PROXIES=127.0.0.1/32` for a proxy on the same host; the API's
  peer is the `edge` container (172.28.1.x), and the host's connection to the
  published port reaches `edge` from the compose gateway, so with that value
  Fastify believed nothing and `request.ip` was `edge` for everybody — one
  60/min anonymous bucket, a 10/min sign-in limit and a 5-per-15-min setup
  lock for the whole shop, `edge` in `audit_log.ip`, and `X-Forwarded-Proto`
  dropped. The default `172.28.0.0/16` works. Repair (docs only): every guide
  keeps the compose network first and adds what sits in front of `edge`
  (nothing for a proxy on the same host; the proxy's subnet, Traefik's
  network or Cloudflare's ranges after it); the `/admin/system` sample shows
  the default. The specification is not changed: its 21.7 example
  («`127.0.0.1/32` for a proxy on the same host») does not fit this
  architecture, which is recorded here. Evidence: `test/docs.test.mjs` «no
  guide recommends trusted proxies without the compose network» red (four
  files) → green; `trusted-proxies.test.ts` «behind the external edge» pins
  the chain (edge peer, `X-Forwarded-For: <visitor>, 172.28.0.1`): the
  visitor with `172.28.0.0/16`, only the edge with `127.0.0.1/32`. Checks:
  API 4 in the file, lint, format; `pnpm test` 61/62 (the known local
  docs-link failure). VPS action: none (the stand runs the nginx profile).

- **R137 Done (local) — any container could reconfigure Caddy.** Cause: the
  Caddy template (after 21.4) put the admin API on `0.0.0.0:2019` so that
  Prometheus could read `proxy-caddy:2019/metrics`; that API also takes
  `POST /load` from anyone who reaches it, and it checks no `Host`/`Origin`,
  so a compromised `web`, `bot`, `worker` or `api` could serve `/data` (the
  ACME account and certificate keys; Caddy runs as root) or send the shop's
  traffic elsewhere. Repair (owner decision О-14): `admin localhost:2019` —
  `caddy reload`, which the reloader runs inside the container, still
  reaches it — and a metrics-only server `:2020 { metrics }`, never
  published; `prometheus.yml` scrapes `proxy-caddy:2020`;
  `docs/monitoring.md` says so. Recorded deviation from 21.4 (`admin
0.0.0.0:2019`) and 20.2 (metrics on the admin port). Contract checked on
  2026-09-28 (Context7 `/caddyserver/website`: the `metrics` directive in its
  own site block, the global `metrics` option). Evidence:
  `proxy-render.test.ts` «the Caddy admin API» red → green;
  `monitoring.test.mjs` scrape target red → green; the old template answered
  `GET http://proxy-caddy:2019/config/` from another container with 200;
  `m5.proxy` «R137» (real Caddy image) — `:2020/metrics` 200 from the
  network, `:2019/config/` and `POST :2019/load` refused (no listener),
  `caddy reload` inside the container succeeds — red (no metrics port) →
  green. Checks: `m5.proxy` 7/7, `m5.grafana` 1/1, API proxy-render 39,
  lint, format; `pnpm test` 61/62 (the known local docs-link failure). VPS
  action: none (the stand runs the nginx profile).

- **R27 Done (local) — an admin's TOTP could be guessed without limit by
  someone who had the password.** Cause: a wrong code at `POST
/api/admin/v1/auth/totp` (or `totp/confirm`) was only audited — no counter,
  no lock, the challenge stayed usable for its five minutes — and a correct
  password reset `failed_logins` and `locked_until`, so a new challenge every
  five minutes kept guessing open; the TOTP routes had no limit of their own
  (60/min anonymous per IP). Repair: a wrong code counts like a wrong
  password — the same `failed_logins`, five lock the admin for 15 minutes,
  doubling to 24 hours (9.2) — and the lock spends the challenge; a
  challenge of an admin locked, deactivated or deleted after the password
  step is spent, not tried; the counters are cleared only when a sign-in
  completes (in `complete()`), not by the password; `totp/setup`, `totp` and
  `totp/confirm` are limited to 10/min like `login`. Evidence:
  `admin.auth.service.test.ts` «wrong TOTP codes» — three wrong codes, a new
  sign-in with the right password, two more: 423 `ADMIN_LOCKED`, the
  challenge gone, an older one refused and spent, the password refused —
  red (401 each time) → green; «are forgiven only by a completed sign-in»
  red → green; the four routes carry the 10/min limit, red → green (the test
  Valkey now honours `NX` and reports what `DEL` removed). Checks: API 422,
  `m4.admin` 1/1, build, lint, format, typecheck. VPS action: none.

- **R78 Done (local) — a reset password or TOTP left the admin's sessions
  alive.** Cause: `reset-password` changed only the hash and the counters, so
  a stolen `rr_asid` worked for up to 12 more hours (7.4: `rr:asess` ends on
  logout and on a password change); `reset-totp` only made the guard answer
  403 until the admin enrolled again, after which the old session was valid
  once more; there was no index of an admin's sessions to end. Repair
  (`admin/admin-sessions.ts`): a sign-in stores `rr:asess:<sid>` and adds the
  id to `rr:asess:admin:<adminId>` (a set that lives as long as its newest
  session could); logout removes it from the set; `resetPassword`,
  `resetTotp` and `deactivate` end every session in the set. No migration.
  Evidence: new `admin-sessions.test.ts` — both services on one in-memory
  Valkey: a session made by a real sign-in (password, enrolment) is gone
  after a password reset, after a TOTP reset and a new enrolment (the new
  session lives), and after a deactivation — red (still valid, all three)
  → green; the built helpers on a real `valkey:9.1-alpine`: index TTL 43200,
  logout removes one id, ending removes the admin's sessions and not another
  admin's, an empty index is fine. Checks: API 425, `m4.admin` 1/1, build,
  lint, format, typecheck. VPS action: none.

- **R81 Done (local) — an anonymous guesser could lock an admin out, and
  the answers named the admins.** Cause: five wrong passwords from anyone
  set the admin's `locked_until` (9.2), so whoever knew an admin's email kept
  them out of the console for up to 24 hours at a time; an unknown email was
  answered without an Argon2 verify (microseconds against tens of
  milliseconds) and never with 423, which told admins' emails apart; the
  first setup-token comparison was `!==`. Repair (owner decision 2026-09-28,
  recorded deviation from 9.2's «`locked_until` of the admin»): wrong
  passwords are counted in Valkey per email and address
  (`rr:admin:pwfail:<sha256(email)>:<ip>`, 24-hour window) and lock that pair
  (`rr:admin:pwlock:…`, 15 minutes doubling to 24 hours); an unknown or
  inactive email is verified against a decoy Argon2id hash and counted and
  locked the same way; a right password clears its pair's count; the
  admin's own `locked_until` is now set by wrong TOTP codes only (R27);
  `resetPassword` — and the shell's `rr admin:reset-password` — lifts every
  pair of the email (`rr:admin:pwips:<hash>` lists them). The shell recovery
  (`scripts/admin-recovery.mjs`) also ends the admin's sessions on a password
  or TOTP reset (R78's rule; it had been missed there). The setup token is
  compared through `equalSecret` (SHA-256 of both, `timingSafeEqual`).
  `docs/admin.md` describes the locks. Evidence: `admin.auth.service.test.ts`
  «locks the address on the fifth wrong password, not the admin» (423 from
  that address even with the right password, a challenge from another) red
  (the admin locked) → green, «answers an unknown email exactly like a known
  one» red (never 423) → green; `admin.login-timing.test.ts` (Argon2 verify
  runs for an email that belongs to nobody) red → green;
  `setup.token-compare.test.ts` red → green; `admin-sessions.test.ts` «a
  reset password lifts the locks» green; `rr.test.mjs` «the shell recovery
  ends the admin's sessions and lifts password locks» red → green; the built
  app image ran the recovery against PostgreSQL 18 and Valkey 9.1: the
  session, the index, the lock and the list of addresses gone after
  `reset-password`, the session gone after `reset-totp`, `list` works (the
  first try found ioredis unresolvable through the `dist/apps/api` symlink;
  the script now resolves from its real path). Checks: API 429, `m4.admin`
  1/1, build, lint, format, typecheck; `pnpm test` 62/63 (the known local
  docs-link failure). VPS action: none.

- **R79 + L-3 Done (local) — the bot's account link could be reused, used as
  a Bearer token, and used to sign someone else in.** Cause: `exchangeJwt`
  never spent the link, so for its hour anyone who saw
  `/auth/tg?token=<jwt>` (a forwarded message, a screenshot, a log) could open
  any number of sessions, and the same JWT was accepted as
  `Authorization: Bearer` on every `/api/v1/me*` route (R79); and a link
  someone issued for themselves and handed over signed the visitor into
  that person's account without a word (login CSRF, L-3). Repair (owner
  decisions О-9 and, for L-3, 2026-09-28): the link JWT carries a `jti`
  (required); the exchange is `POST /api/v1/auth/tg { token }` — same-origin
  (the section 19.3 CSRF rule), 10/min — and spends the link
  (`claimOnce('bot-jwt:<jti>')` until its expiry), recording the visitor's IP
  and user agent; `POST /api/v1/auth/tg/preview` names the account
  (`firstName`, `username`) without spending it and refuses a spent link or a
  banned or anonymized user; `GET /api/v1/auth/tg` is gone, so a link to the
  API cannot bypass the page; `AuthGuard` no longer accepts Bearer. The web
  `/auth/tg?token=` route only redirects to `/<locale>/auth/tg#<token>` — the
  token in the fragment, out of every log and `Referer` — where the page
  (history cleared of the token) shows «Войти как <имя> (@username)?» and
  signs in only on the button, then opens `/<locale>/account`; a spent or
  broken link says so and offers nothing to press. The bot is unchanged (13.3's
  URL). i18n `account.botSignIn.*`, `seo.botSignInTitle`; OpenAPI routes;
  `docs/account.md`, `docs/e2e.md`. The e2e sign-in and the Lighthouse
  account audit follow the new flow; the audit now puts the session cookie
  into the browser's profile and keeps storage (Lighthouse's recipe for
  authenticated pages, Context7 `/googlechrome/lighthouse`;
  `connectOverCDP`'s `close()` only disconnects, Context7
  `/microsoft/playwright`) — a `Cookie` in `extraHeaders` was tried first and
  never reached the page. Recorded deviations from 9.2: no Bearer (the
  «MiniApp groundwork»), and the exchange is the confirmed POST instead of
  `GET /api/v1/auth/tg` → 302. Evidence: `auth.bot-link.test.ts` — the second
  exchange of a link refused, the preview names the account and spends
  nothing, a valid link token as Bearer gets 401 — red (second session
  opened; no preview; Bearer accepted) → green; web
  `auth-tg-route.test.ts` (redirect to the page with the token in the
  fragment, no API call, no cookie) red → green; `bot-sign-in.test.tsx`
  (names «Анна (@anna)», signs in only on «Войти» with a same-origin POST,
  clears the fragment; a spent link and a missing token offer nothing) red
  (no page) → green; `e2e/specs/account.spec.ts` 15/15 on the local stack,
  with «the bot's link asks before it signs in, and works once» (no `rr_sid`
  before the button; the same link again shows the refusal); Lighthouse
  landing 100/96/100 (ru, en), account accessibility 96. Checks: API 432,
  web 70, bot 93, build, lint, format, typecheck, typecheck:e2e,
  i18n-check (2312); `pnpm test` 62/63 (the known local docs-link failure).
  VPS action: after deploy, open «Личный кабинет» in the bot, confirm on the
  page, and check that the same link opened again is refused.

- **L-6 Done (local) — any made-up key id made the API fetch Telegram's
  keys.** Cause: `TelegramOidcVerifier` reads the `kid` from the token header
  before it checks the signature and reloaded the JWKS for every `kid` it did
  not know, with no pause and no sharing between concurrent requests, so each
  forged `POST /api/v1/auth/telegram/oidc` (10/min per address) cost an
  outgoing request to `oauth.telegram.org` with a 10-second timeout. Repair:
  an unknown `kid` reloads the keys at most once a minute (the hourly refresh
  stays), and concurrent requests share one load. A key Telegram rotated in
  is still found within the minute. Evidence: `telegram-oidc.test.ts`
  «reloads the keys for an unknown key id at most once a minute» — five
  concurrent sign-ins, twenty made-up `kid`s, then one after 61 s: red (five
  loads for the first five) → green (one, then one more after the minute).
  Checks: API 433, lint, format, typecheck. VPS action: none.

- **R101 Done (local) — the shop bot answered in groups, in public.** Cause:
  past the operators' chat nothing checked the chat type, so in any group the
  bot was added to (BotFather allows it by default) `/sub@bot` posted the
  caller's subscription link and «Личный кабинет» the caller's sign-in link
  where every member could read and press them, and every member who wrote
  was registered as a customer. Repair (`apps/bot/src/bot.ts`): right after
  the operators' relay (`supportRelay`, which keeps its chat) an update from
  any chat but a private one stops — a button press there is only answered
  so its spinner stops; updates without a chat (a Stars `pre_checkout_query`)
  go on. Evidence: new `bot.test.ts` on the real `createBot` (in-memory
  Valkey, a recording API): `/sub@shop_bot` in a supergroup, `/start` in a
  group and a button pressed in a group reach no API call but the relay's
  configuration read and no Telegram call but `answerCallbackQuery` — red
  (the screens ran: the user registered, the `sub` and `home` screens
  answered) → green; a private `/start` still registers the user. Checks:
  bot 97, build, lint, format, typecheck, i18n-check (2312). VPS action: none
  (optionally turn off «Allow Groups» for the bot in BotFather).

**Package 2 status (2026-09-28): repairs done and verified locally; NOT
VERIFIED on CI, the VPS or live Telegram.** Seventeen repairs, one commit
each (`8e91ddf` … `2d78d71`). After the last commit: `test:m1` 7/7,
`test:m2` 8/8, `test:m4` 7/7, `test:m5` 12/12, `pnpm test:e2e` 39/39 (local
stack; Chromium's libraries from the documented `LD_LIBRARY_PATH` prefix),
Lighthouse landing 100/96/100, account accessibility 96; unit suites of every
workspace package (API 433, bot 97, web 70, worker 39, logger 5, the others
unchanged), build, lint, format, typecheck, typecheck:e2e, i18n-check (2312);
`pnpm test` 62/63 — the one failure is the known local-only docs-link test
reading the untracked review files (package 12). The app image was built and
ran the shell recovery against PostgreSQL 18 and Valkey 9.1 and loaded the
api, worker and bot loggers; the web and proxy images were not rebuilt as
images (their files ran in `next build`, `m5.proxy` and the e2e stack). Not
yet verified: the CI run on GitHub; the stand (log contents after the
rotation, IPv4-only ports, the bot's link and its confirmation page, group
chats); a host with a global IPv6 address; the Caddy profile on a stand.

Recorded deviations from the specification made by this package, all by
owner decisions: 9.1 webhook limit per provider **and address** (О-16, P-2);
the web container's own requests outside the anonymous limit (P-9); 9.2
password locks per email and address (R81); 9.2 no Bearer and the link
exchange as a confirmed POST (О-9, L-3); 21.8 no `AAAA` and 21.3 no `[::]`
listeners (О-1); 21.4/20.2 Caddy admin on localhost, metrics on `:2020`
(О-14); 21.7's `127.0.0.1/32` example not followed in the docs (R25).

Found while closing the package: `m4.support` failed once under the load of
the full `test:m4` run (`6n !== 2n` for the second ticket's number) and passed
3/3 alone and in the repeated `test:m4`; neither the support module nor the
database changed in this package. Cause: ticket numbers come from a sequence,
and the four losing inserts of five concurrent `openOrLive` calls spend
values when they get past the `live()` check, so numbers can skip under load —
a product defect as well as a flaky test. Queued in package 9.

VPS actions after deploying package 2: rotate `RR_INTERNAL_TOKEN`, change the
bot webhook secret path and token, delete `rr:asess:*` and clear the old
container logs (R4/R113/R82); check `ss -tlnp` shows 80/443 on `0.0.0.0`
only and remove any `AAAA` record (R13); if a dump or backup may have leaked,
change Robokassa's Password1/2 (R28); open «Личный кабинет» from the bot,
confirm, and check the same link is refused the second time (R79/L-3).

### Package 4 — ledger and balance

Owner decisions taken while planning this package (2026-09-28):

- P-6 — the queue's variant: every account, user or system, holds
  `SUM(credit) − SUM(debit)`, as every posting path already writes it;
  `ledger.math` and `audit()` follow the postings. Recorded deviation from
  8.3 (system accounts as `debit − credit`). No data migration: the stored
  balances already use this convention.
- R135 — closed by F37 (О-12, rewards only on top-ups); no code in this
  package, the deviation from 15.2 is recorded with F37.
- L-11 — 11.2 literally: a transaction and its entries carry the invoice
  amount, except an underpaid invoice (< 98 %), which credits what was paid;
  an overpayment is not recorded anywhere.

- **P-6 Done (local) — the ledger audit read system accounts with the
  opposite sign to every posting.** Cause: the posting paths
  (`payments.repository.ts` `postEntry`/`settleBalance`/`refund`,
  `referrals.engine.ts` `post`) subtract a debit and add a credit on every
  account, while `ledger.math.nextBalance` (used by `LedgerRepository.post`)
  and `audit()` read system accounts as `debit − credit` (8.3). Wiring the
  audit (R19) would have reported every `revenue`, `provider_clearing` and
  `referral_expense` account as a mismatch, and repairing R2 through
  `LedgerRepository.post` would have written `adjustment` with the other
  sign. Repair: `nextBalance` adds a credit and subtracts a debit for every
  kind; `audit()` expects `credit − debit` for every account; the module
  README states the convention and the deviation. Invariants: all balances
  sum to zero; every account equals its entries under one rule. Evidence:
  `ledger.math.test.ts` «credits add and debits subtract on every account
  kind» red (revenue credit 750 ≠ 1250) → green; `m2.payment` and
  `m4.rewards` end with `LedgerRepository.audit()` and zero mismatches, red
  (four and two system accounts with the sign flipped) → green; their
  starting balances are now real `adjustment → user` postings. Checks: API
  433, lint, format, typecheck, i18n-check (2312). VPS action: none.

- **R2 + R14 + R70 Done (local) — a manual balance correction bypassed the
  ledger, a debit always failed, and a customer who never paid could not be
  credited.** Cause: `AdminUsersService.adjustBalance` (the console and the
  F36 `/credit` card action) updated `accounts.balance_minor` and wrote a
  signed `transactions(type=adjustment)` with no `ledger_entries` (11.6,
  11.7); a debit's negative amount broke `CHECK amount_minor >= 0` (500),
  the console's `MoneyInput` took no minus sign anyway, and a user without an
  account (created lazily by payments) got 404, which `/credit` reported as
  «no subscription». Repair: the body of `LedgerRepository.post` became the
  exported `postInTransaction(tx, input)` (both accounts found, a user's
  opened with `ON CONFLICT`, locked in `id` order, a user debit refused below
  `available()`, the transaction with `actor_admin_id`, one entry, both
  balances); `adjustBalance` checks the user exists and posts
  `adjustment → user` for a credit or `user → adjustment` for a debit with
  the unsigned amount, the reason and the acting admin, mapping the ledger's
  `INSUFFICIENT_FUNDS` to 409. The console has a «Списать» button for
  `users.balance.debit` (admins only, 14.2) that sends the amount negative.
  Invariants: every correction is one transaction with one entry; the user
  account equals its entries; a debit never goes below the available
  balance (held rewards excluded). Evidence: `m4.admin` — the credit's
  entry `adjustment → user` 2500 with reason and admin red (no entries) →
  green, a debit of 100 red (`transactions_amount_minor_check`) → green
  (`user → adjustment`, amount 100), a first credit to a customer without an
  account → 700, the touched accounts absent from `audit()`'s mismatches;
  `m4.support` — `/credit` to a customer without an account red
  (`no_subscription`) → green (balance 500). Unit tests check the posting's
  direction and amount and the 409. Checks: API 433, web 70, lint, format,
  typecheck, i18n-check (2312). A debit is shown in the histories as an
  `adjustment` of its unsigned amount (the direction is in the entry). VPS
  action: corrections made before this repair have no entries and will show
  in the ledger audit; by О-20 the stand is recreated, no data fix.

- **R15 Done (local) — parallel credits let an operator pass the daily
  limit.** Cause: `assertOperatorLimit` summed the operator's credits of the
  day with an autocommit `aggregate` before the transaction, and the only
  lock taken was the customer's account, so credits to different customers
  (two console tabs, the console and `/credit`) each read the same sum and
  all passed (14.2 «до max_credit_minor в сутки суммарно»). Repair: for an
  operator, `adjustBalance` takes `pg_advisory_xact_lock(hashtext(
'operator-credit:<admin id>'))` in the posting's transaction, then reads
  the day's sum with the transaction's client, then posts; the lock is held
  to the commit. The debit refusal stays before the transaction. Invariant:
  an operator's credits of a UTC day never exceed
  `operator.max_credit_minor`. Evidence: `m4.admin` — five parallel credits
  of 60 000 against a 100 000 limit to five customers, red (5 passed) →
  green (one passes, four 403, 60 000 credited); the unit test checks the
  lock is taken with the operator's key before the limit is read. Checks:
  API 433, `m4.support` (the card's `/credit` under the limit), lint,
  format, typecheck, i18n-check (2312). VPS action: none.

- **R19 + R68 (`ledger.mismatch`) Done (local) — the ledger audit never
  ran, and its query was quadratic.** Cause: `LedgerService.audit()`
  existed but no route or job called it, so 8.3's nightly
  `maintenance.ledger-audit` and FR-163's `ledger.mismatch` alert never
  happened and `rr_ledger_audit_mismatch_total` stayed 0; its
  `LEFT JOIN ledger_entries ON debit = a.id OR credit = a.id` cannot hash
  or merge join and scanned accounts × entries (≈3 min on 20k × 100k in
  the review). `maintenanceCall` sent any unknown maintenance job to
  `subscriptions/expire`. Repair: `audit()` sums the entries once per side
  (`UNION ALL`, `GROUP BY account_id`) and joins the totals to `accounts`
  in one statement (one snapshot); a mismatch is logged with the account
  ids, counted, and raised as `notify.alert {type: 'ledger.mismatch'}` once
  per UTC day (outbox `jobId alert:ledger.mismatch:<yyyymmdd>`).
  `POST /api/internal/v1/ledger/audit` (internal token) answers
  `{ checked, mismatches }`; the worker queues `maintenance.ledger-audit`
  once per UTC day from 02:00 (before the 03:00 backup; a worker down at
  02:00 runs it on return) and routes it by an explicit case. Migration
  0012 (`reversible: yes`) indexes `ledger_entries` by debit and credit
  account. `seed-dev` posts its starting balance `adjustment → user`.
  `docs/notifications.md` and the module README name the job and alert.
  Evidence: `schedule.test.ts` «audits the ledger once per UTC day from
  02:00» red → green; `panel-call.test.ts` «sends the nightly ledger audit
  to the ledger» red (fell back to `subscriptions/expire`) → green;
  `migration.test.mjs` 0012 red (missing) → green; `m4.rewards` — a
  balance changed by 1 is the one mismatch and two audits write one
  `ledger.mismatch` alert naming the account, red (no alert) → green;
  `ledger.controller.test.ts` checks the JSON body. Checks: API 434,
  worker 41, db 8, lint, format, typecheck, i18n-check (2312). VPS action:
  0012 applies at start; the next day `/admin/system` shows
  `maintenance.ledger-audit` completed without failures. On the current
  stand the alert is expected (corrections made before R2 have no
  entries); by О-20 the stand is recreated.

- **R16 Done (local) — a partial refund marked the referral reward
  reversed, and the rest of the refund reversed nothing.** Cause:
  `reverseReferralReward` reversed `reward × refunded / source` and then
  set `status='reversed'` unconditionally; the next refund of the same
  source saw `reversed` and returned 0. A purchase refunded 10 % and then
  90 % left the referrer 90 % of the reward (15.2: a full refund reverses
  the whole reward), and the reward left `held`, so the hold no longer
  covered it. Repair: the reversal due is cumulative — the whole reward
  once the source's refunded total reaches its amount, otherwise
  `floor(reward × refunded / source)` — minus the `referral_reversal`
  transactions already posted under the reward (`parent_id`); only a full
  refund sets `reversed` (with the last reversal's id). A partly reversed
  reward stays `held` until released and holds its whole amount meanwhile
  — conservative: the referrer can spend less, never more. Invariant: the
  reversals of a reward never exceed it and equal it after a full refund.
  Evidence: `m4.rewards` — a 20 % reward of 5980 on a 29 900 purchase,
  refund 2990 then 26 910: reversals [598, 5382], `held` after the first,
  `reversed` and a zero balance after the second, the ledger audit still
  clean; red (`reversed` after the first refund) → green. Checks: API 434,
  lint, format, typecheck, i18n-check (2312). VPS action: none (О-20).

- **R17 Done (local) — a manual reversal racing another reversal of the
  same reward reversed it twice.** Cause: `RewardsService.reverseReward`
  (console, 15.4) and `reverseReferralReward` read the reward without a
  lock and posted unconditionally; two tabs (different `Idempotency-Key`s)
  or a console reversal next to a refund of the source both read the
  reward's pre-reversal state and both debited the referrer (no unique
  constraint stops a second `referral_reversal`). The engine's `post` also
  moved both accounts without locking them in order. Repair:
  `reverseReferralReward` starts with `SELECT … FROM referral_rewards WHERE
source_transaction_id = $1 FOR UPDATE` and reads the reward after it; the
  console path locks the source transaction first, as `refund` does, so
  both take the source, the accounts and the reward in one order; the
  engine's `post` locks both accounts `ORDER BY id FOR UPDATE` (11.7; a
  payment already holds them). Invariant: a reward's reversals never exceed
  it, however the reversals interleave. Evidence: `m4.rewards` — transaction
  A reverses a 5980 reward and holds its commit while the console's
  reversal B starts; red (B reversed 5980 again, two reversals) → green (B
  waits, then reverses 0; one reversal of 5980). `m2.payment` and
  `m2.payment-recovery` (refund paths) pass. Checks: API 434, lint, format,
  typecheck, i18n-check (2312). VPS action: none.

- **R135 — closed by F37 (owner decision 2026-09-28).** No code in this
  package: rewards only on top-ups come with the F37 model (О-12), which
  records the deviation from 15.1–15.2. Until F37 a purchase paid at a
  provider or from the balance still accrues a reward as 15.2 reads.

- **L-11 Done (local) — a purchase's transaction amount disagreed with its
  entries when the payment differed from the invoice.** Cause: `applyEvent`
  wrote `transactions.amount_minor = paid` for every `paid` event, while the
  purchase entries (`provider_clearing → user`, `user → revenue`) carried
  the invoice amount; a payment within 2 % below the invoice, or above it,
  left the two apart. The to-balance branches (late, top-up, plan off sale)
  credited `paid` although 11.2 credits the invoice amount there. Repair
  (owner decision: 11.2 literally): `credit` is what was paid only for an
  underpaid invoice (< 98 %, EX-12); otherwise it is the invoice amount, and
  the transaction, its entries and the `payment.to_balance` notice all carry
  it. An overpayment is not recorded anywhere (as 11.2). The second Stars
  charge (owner decision 2026-09-25) is unchanged. Invariant: a payment's
  transaction amount equals each of its entries. Evidence: `m2.payment` — a
  29 900 purchase paid 30 500, red (transaction 30 500, entries 29 900) →
  green (29 900 both), paid 29 500 → 29 900 both; a late 5000 top-up paid
  5100 credits 5000; a 5000 top-up paid 4000 is `underpaid` and records
  4000; the ledger audit stays clean. Checks: `test:m2` suites 4/4, API
  434, lint, format, typecheck, i18n-check (2312). VPS action: none.

- **L-20 Done (local) — a DELETE on `payment_events` reported success and
  removed nothing, and TRUNCATE emptied the append-only tables.** Cause:
  0002's `payment_events_guard()` compared `NEW` with `OLD` on DELETE too;
  `NEW` is NULL there, the comparison is NULL, and the trigger returned
  NULL — which silently skips the row. Row triggers never see TRUNCATE, and
  none of the immutable tables (8.1) had a statement trigger. Repair:
  migration 0013 (`reversible: yes`) makes the guard raise `27000` on
  DELETE and adds `BEFORE TRUNCATE … FOR EACH STATEMENT EXECUTE FUNCTION
forbid_mutation()` to `payment_events`, `transactions`,
  `ledger_entries`, `audit_log` and `notification_log` — TRUNCATE on the
  other four was the same defect. No code deletes from or truncates these
  tables (checked). Invariant: the append-only tables lose no row through
  SQL. Evidence: `m1.integration` — a stored event: `DELETE` red (no error,
  «Missing expected rejection») → green (`immutable table`, the row still
  there); `TRUNCATE … CASCADE` refused on all five; `migration.test.mjs`
  0013 red (missing) → green. Checks: db 9, lint, format, typecheck,
  i18n-check (2312). VPS action: 0013 applies at start.

**Package 4 status (2026-09-28): repairs done and verified locally; NOT
VERIFIED on CI or the VPS.** Eight repairs, one commit each (`650a803` …
`bf49798`), R135 moved to F37 without code. After the last commit: `test:m1`
7/7, `test:m2` 8/8, `test:m4` 7/7; unit suites API 434, worker 41, db 9,
web 70, bot 97; build (including `next build`), lint, format, typecheck,
i18n-check (2312); `pnpm test` 62/63 — the one failure is the known
local-only docs-link test reading the untracked review files (package 12).
`test:m5` was not run: nothing in proxy, backup or Grafana changed. Not yet
verified: the CI run on GitHub (after the next push); `pnpm test:e2e` (the
console's new «Списать» button was not driven in a browser; the admin spec's
API debit now succeeds where it used to fail); on the stand, migrations 0012
and 0013, the first nightly `maintenance.ledger-audit` and the
`ledger.mismatch` alert delivery. AC-ledger («0 mismatches after all the
tests») is shown by the audits at the end of `m2.payment` and `m4.rewards`,
not after every acceptance suite.

Recorded deviations and decisions of this package, all by the owner
(2026-09-28): 8.3 — every account, system ones included, is `credit − debit`
(P-6); R135 closed by F37; L-11 follows 11.2 literally (an overpayment is not
recorded). Behaviour worth knowing: a debit shows in the histories as an
`adjustment` of its unsigned amount; a partly reversed held reward holds its
whole amount until released; the ledger audit runs once per UTC day from
02:00.

VPS actions after deploying package 4: confirm migrations 0012 and 0013
applied (`\d ledger_entries`, `\d payment_events`); the next day
`/admin/system` shows `maintenance.ledger-audit` completed without failures
(on the current stand a `ledger.mismatch` alert is expected from corrections
made before R2 — by О-20 the stand is recreated); in the console an admin
sees «Начислить» and «Списать», an operator only «Начислить».

### Package 3 — install, release and rollback

- **P-3 + L-35 Done (local) — PostgreSQL, Valkey and the web did not come
  back after a reboot.** Cause: `compose.yaml` gave `restart:
unless-stopped` and log rotation only to the application services and
  the proxies; `postgres`, `valkey` and `web` had neither, and `web` had no
  `no-new-privileges`. A host reboot or an OOM kill left them down, the API,
  bot and worker crash-looped behind them and the site answered 502 until
  `rr up`. The postgres healthcheck asked over the unix socket, which the
  image's initdb server answers before it restarts (L-35; `restore.sh`
  already asked over TCP). Repair: the three services get `restart:
unless-stopped`, `no-new-privileges` and the json-file rotation
  (50m × 5); the healthcheck runs `pg_isready -h 127.0.0.1`. Invariant:
  every long-running core service restarts, rotates its logs and gains no
  privileges. Evidence: `tooling.test.mjs` on the compose file as `docker
compose config` resolves it — «every long-running core service restarts…»
  red (`postgres restart`) → green, «the postgres healthcheck asks over
  TCP» red → green; postgres and valkey from the compose file start
  healthy on fresh volumes under `no-new-privileges`. Checks: `pnpm test`
  64/65 (the known docs-link test), lint, format, typecheck, i18n-check
  (2312). VPS action: none beyond the redeploy.

- **R114 Done (local) — the weekly rebuild refreshed a patch to the previous
  minor instead of the current line.** Cause: `rebuild.yml` took
  `getLatestRelease`, and `release.yml` published every release without
  `make_latest`, which GitHub defaults to `true` for a new release — so a
  security patch to the previous minor (24.5) became «latest» and the
  Monday rebuild kept rebuilding it while `1`/`1.2` aged on old bases.
  Repair: the rebuild pages through `listReleases` and takes the highest
  final version by number (drafts and candidates skipped, a typed version
  still wins); `floating-tags.sh` prints `latest=` (the newest final
  release of all) and the release passes it as `make_latest`. Contracts
  checked: `make_latest` accepts `true`/`false`/`legacy` and defaults to
  `true` (GitHub REST «Create a release»; softprops/action-gh-release via
  Context7); `listReleases` pages at most 100. Evidence: `tooling.test.mjs`
  «the weekly rebuild takes the highest published final release» (the
  step's script run with a fake `github`) red (`1.1.6`) → green (`1.2.10`);
  «a release is marked latest only when…» red → green. Checks: `pnpm test`
  66/67 (the known docs-link test), lint, format, typecheck, i18n-check
  (2312). VPS action: none.

- **R115 Done (local) — a partly failed release moved the floating tags of
  the images that did build, unscanned.** Cause: each matrix job of
  `release.yml` (`fail-fast: false`) pushed `X.Y.Z`, `X.Y` and `X` itself
  and nothing scanned a release; one failed image left `app:1` new and
  `web:1` old, which a deployment on `RR_VERSION=1` pulled together. The
  rebuild pushed `X.Y.Z-<run id>` before its Trivy scan and left it behind
  when the scan failed. Repair: both workflows push by digest under no
  tag (`outputs: type=image,…,push-by-digest=true,name-canonical=true,
push=true`); `release.yml` scans every image with Trivy (the rebuild's
  gate: CRITICAL/HIGH, fixed only), signs and attests it, and hands the
  digest on as an artifact; a new `tags` job (`needs: images`, so it runs
  only when all five succeeded) checks all five digests are there, then
  publishes `X.Y.Z` (`rc` for a candidate, `X.Y`/`X` by
  `floating-tags.sh`) with `imagetools create` from the digest and
  refuses a tag that names another digest; the GitHub Release waits for
  it. The rebuild tags from `IMAGE@DIGEST`. `docs/upgrade.md` says so.
  Contracts checked (Context7): build-push-action passes `outputs` to
  `--output` and returns the manifest-list digest; download-artifact
  `pattern` + `merge-multiple`. Evidence: `tooling.test.mjs` «release tags
  are published only after every image is built and scanned» (the publish
  step run with a fake `docker`: 15 tags for a final release, `X.Y.Z-rc.N`
  and `rc` for a candidate, refusal with four digests or a foreign digest)
  red on the old workflows (no push by digest) → green; actionlint clean.
  Checks: `pnpm test` 67/68 (the known docs-link test), lint, format,
  typecheck, i18n-check (2312). Not verified until a tag runs on GitHub.
  VPS action: none.

- **R116 Done (local) — actions ran from movable tags with write tokens
  granted to whole workflows.** Cause: every `uses:` named a tag, third-party
  ones included, in jobs holding `packages: write` and `id-token: write`; a
  rewritten tag (the tj-actions class of attack) could sign and publish an
  image under `ghcr.io/remnaray/*:1`. The permissions sat at workflow level,
  so the release's GitHub Release job could sign images and the nightly
  `pnpm install` (lifecycle scripts of dependencies) ran with
  `issues: write` and `security-events: write`. Repair: every action is
  pinned to the commit its current tag names, with the tag as the comment
  (the form Renovate's `helpers:pinGitHubActionDigests` updates; commits
  resolved with `gh api repos/<action>/commits/<tag>` on 2026-09-28, no tag
  changed); every workflow grants only `contents: read`; the signing jobs
  (`release` images, `rebuild`) get `packages`/`id-token`/`attestations`,
  the release's tags job `packages: write`, the GitHub Release job
  `contents: write`, `images.yml` `packages: write`, the nightly Trivy job
  `security-events: write` and the ZAP job `issues: write` (its report
  issue); the audit job has read only. Evidence: `tooling.test.mjs` «every
  action is pinned to a commit and every write permission belongs to a
  job» red (`ci.yml: actions/checkout@v7`) → green; the older workflow
  tests read the pinned form; actionlint reports only the four SC2016
  notes it reported before. Checks: `pnpm test` 68/69 (the known
  docs-link test), lint, format, typecheck, i18n-check (2312). Not verified
  until the workflows run on GitHub. VPS action: none.

- **R117 Done (local) — Renovate switched off every update of pnpm, Prisma,
  grammY and ioredis and asked for none of the updates 24.6 names.** Cause:
  `renovate.json` put the five 24.6 exceptions in `ignoreDeps`, which
  disables patches and security PRs too (and left the «never automerge
  Prisma/ioredis» rule with nothing to match), where 24.6 holds back only
  `pnpm 12`, `prisma 8`, `grammy 2`, `ioredis 6` and `nginx 1.31`; there was
  no `github-actions` group and no digest PRs for `postgres`/`valkey`.
  Repair: `allowedVersions` rules (`pnpm <12`, `prisma`/`@prisma/* <8`,
  `grammy <2`, `ioredis <6`, docker `nginx <1.31`) replace `ignoreDeps`;
  `helpers:pinGitHubActionDigests` and a `github-actions` group keep the
  R116 pins current; `pinDigests` for docker `postgres` and
  `valkey/valkey`. `docs/upgrade.md` says Renovate pins those two by
  digest. Contracts checked (Context7, docs.renovatebot.com):
  `allowedVersions` takes a range and may not share a rule with
  `matchUpdateTypes`; docker tags take a `<` bound (Renovate's own
  `workarounds` preset); the `github-actions` manager updates a SHA with a
  version comment. `renovate-config-validator --strict` (latest Renovate,
  2026-09-28) accepts the file as repository config. Evidence:
  `tooling.test.mjs` «Renovate holds back only the majors section 24.6
  names» red (`ignoreDeps` present) → green. Checks: `pnpm test` 69/70
  (the known docs-link test), lint, format, typecheck, i18n-check (2312).
  Expected after the push: Renovate's onboarding opens a pin-digests PR for
  `postgres`/`valkey`. VPS action: none.

- **P-4 Done (local) — restoring a dump older than the schema broke the
  database.** Cause: `restore.sh` ran `pg_restore --clean --if-exists` into
  the live database (the 20.5 command). A dump older than the schema — the
  20.6 rollback, or a daily dump restored after an upgrade — cannot drop a
  table a newer one references (0010: `support_tickets.user_id → users`):
  `users` kept its new rows, `_prisma_migrations` went back, the new tables
  stayed, and `set -e` stopped the script with the stack down; the next
  `migrate` failed on `CREATE TABLE`. Repair: the dump goes into a fresh
  `<POSTGRES_DB>_restore` database with `--single-transaction
--exit-on-error`; only when that succeeded is the current database
  dropped (`WITH (FORCE)`, the stack is down) and the fresh one renamed in
  its place, all as the container's own user and database names through
  psql variables. A failed restore leaves the current database untouched
  and says so. Recorded deviation from the 20.5 command text (same sequence
  and outcome, a different `pg_restore` target); `docs/backup.md` says why.
  Evidence: `m5.backup` «P-4: restore.sh puts back a dump older than the
  current schema» (a named data volume, a newer table with an FK to an
  older one) red (`cannot drop table public.users because other objects
depend on it`, exit 1) → green (only the dump's rows and tables, no
  leftover database; a dump cut in half fails and leaves both rows); «26.4
  R3» still green; shellcheck clean. Checks: `pnpm test` 69/70 (the known
  docs-link test), lint, format, typecheck, i18n-check (2312). VPS action:
  none.

- **R59 Done (local) — the documented rollback started the newest version
  and re-applied the irreversible migration.** Cause: (1) `scripts/rr`
  exported every `RR_VERSION`/`RR_REGISTRY`/… of `.env` over the
  environment — the reverse of compose's precedence — so `RR_VERSION=1.2.2
./scripts/rr up` with `RR_VERSION=1` in `.env` started `:1`; (2)
  `restore.sh` ended every restore with `up -d` on the version `.env`
  names, so after a pre-migrate dump the new `migrate` applied the same
  `reversible: no` migration again at once; (3) the dump was named
  `pre-migrate-${RR_VERSION}` — the target version, the same file on every
  upgrade of the `1` channel. Repair: `rr` exports a `.env` value only when
  the environment does not already have that variable; `restore.sh` stops
  after a `pre-migrate-*` dump with PostgreSQL alone and says to set
  `RR_VERSION` in `.env` and run `rr up` (a daily dump still starts the
  stack, as 20.5); `migrate` names the dump after the last applied
  migration, the schema the upgrade leaves (`migrate` runs from the new
  image and cannot know the old image's version — the review's other
  option). `docs/upgrade.md` follows 20.6: `.env` first, then the
  pre-migrate restore, then `rr up`; `docs/backup.md` names the file.
  Overwriting the dump and the fail-open headers stay with R91. Evidence:
  `rr.test.mjs` «an RR_VERSION or RR_REGISTRY given in the environment
  wins over .env» red (`1` from `.env`) → green; «restore.sh leaves the
  stack stopped after a pre-migrate dump» red (`up -d`) → green (a daily
  dump still starts it); `m5.premigrate-backup` red
  (`pre-migrate-9.9.9.dump`) → green (`pre-migrate-0013_….dump`); unit
  test for the name; shellcheck clean. Checks: `pnpm test` 71/72 (the
  known docs-link test), API 435, lint, format, typecheck, i18n-check
  (2312). VPS action: none (a rollback on the stand follows the new
  `docs/upgrade.md`).

- **R60 Done (local) — an upgrade with an irreversible migration failed
  when `./backups` belonged to root.** Cause: `migrate` runs as `node`
  (uid 1000) and wrote the pre-migrate dump into `./backups`, which a clone
  made as root (`sudo git clone`, the usual VPS) leaves `root:root 0755`:
  `pg_dump` got `Permission denied`, `migrate` exited 1 and `api`, `bot`,
  `worker` and `web` never started. Repair: the `backup` service (root)
  creates `backups/pre-migrate` owned by uid 1000, mode 700, when it starts
  and reports healthy only then; `migrate` writes there
  (`RR_BACKUP_DIR=/backups/pre-migrate`) and waits for `backup` to be
  healthy with `required: false` (compose ≥ 2.20: a start without a
  deployment profile skips it). The host directory keeps its owner. Docs
  name the new path. Contract checked: `depends_on.required` (Docker
  compose reference, Context7). Evidence: `m5.backup` «R60: migrate can
  write its pre-migrate dump into a root-owned ./backups» (the deployment's
  compose file, `./backups` chowned to root, `up --wait backup`, a write as
  uid 1000 into `migrate`'s directory) red (no dependency; a uid-1000 write
  into the root-owned `/backups` is `Permission denied`) → green. Checks:
  `pnpm test` 71/72 (the known docs-link test), worker 41, lint, format,
  typecheck, i18n-check (2312). VPS action: none needed after the deploy
  (`ls -ld /opt/test/backups/pre-migrate` shows uid 1000).

- **R91 Done (local) — the pre-migrate dump failed open, read the wrong
  database and could clobber a good dump.** Cause: `isIrreversible` looked
  for `-- reversible: no` anywhere and took everything else as reversible,
  so 0002–0004 (`-- reversible: <text>`) and 0005 (no header) — and any
  later slip — skipped the dump; `pg_dump` got `POSTGRES_HOST/USER/DB`
  only, ignoring `POSTGRES_PORT` and an explicit `DATABASE_URL` that the
  migration itself uses, so it dumped another database or failed and
  stopped `migrate`; it wrote straight to the final name, so a failed dump
  left a truncated file there (with R59's old naming, over the previous
  good one). Repair: only a first header line `-- reversible: yes` skips
  the dump — `no`, any other text or no header takes it (8.4 forbids
  editing the applied 0002–0005, so their headers stay and would count as
  irreversible; every migration after 0005 is checked to say yes or no);
  `pg_dump` connects through libpq variables built from the resolved
  database URL (host, port, user, database, `sslmode`; the password never
  in argv); the dump is written to `.partial`, renamed on success and
  removed on failure; the name carries the time
  (`pre-migrate-<migration>-<yyyymmdd-HHMMSS>.dump`), so a second attempt
  at an upgrade never replaces the first attempt's dump. Docs follow.
  Evidence: `migrate.test.ts` — the header cases (a later `-- reversible:
no` line, free text, none, `yesterday`), the header check over the real
  migrations, the stamped name and the libpq mapping (encoded password,
  `sslmode`, IPv6) red → green; `m5.premigrate-backup` with the database
  on a port other than 5432 and no `DATABASE_URL` red (`connection to
server at "127.0.0.1", port 5432 failed`) → green (the dump holds the
  marker table; a `pg_dump` failing half-way leaves no new file). Checks:
  API 438, `pnpm test` 71/72 (the known docs-link test), lint, format,
  typecheck, i18n-check (2312). VPS action: none.

- **R110 Done (local) — database dumps and file archives were readable by
  every user of the host.** Cause: the `backup` container runs as root with
  umask 022, so `pg_dump --file` and `tar -czf` wrote `0644` files into the
  bind-mounted `./backups`: password hashes, TOTP secrets and setting
  ciphertexts to any local user (and to the worker's read-only mount).
  Repair: `backup-entrypoint.sh` runs with `umask 077`; each dump and
  archive is handed to the owner of `backups/` and made `0600` (the operator
  who cloned the repository can still restore without root; the weekly hard
  link shares the inode); the directory is `0711`, so the worker (uid 1000)
  still reaches `.last-status`, now written `0644` explicitly, without
  listing anything. `docs/backup.md` says so. Evidence: `m5.backup` AC-202
  (dump `0600`, owned by the directory's owner, directory `0711`, status
  `0644`) and 26.4 R3 (archive `0600`) red (`the dump is readable by
others`) → green. Checks: `pnpm test` 71/72 (the known docs-link test),
  lint, format, typecheck, i18n-check (2312), shellcheck (warnings) clean.
  VPS action: `chmod 600 /opt/test/backups/*.dump
/opt/test/backups/*.tar.gz` for the files written before the deploy.

- **R111 Done (local) — the S3 keys were on a command line every host user
  could read.** Cause: `upload()` ran `mcli alias set rr <endpoint>
<access> <secret>`; container processes are visible in the host's `ps`,
  so the keys of the backup bucket leaked for the life of that process.
  Repair: the alias comes from `MC_HOST_rr=<scheme>://<access>:<secret>@<host>`
  in `mcli`'s own environment (readable only by its user and root); an
  endpoint without a scheme is taken as `https://`. Contract checked: mc
  `cmd/config.go` `parseEnvURLStr` (Context7: the `MC_HOST_<alias>` forms,
  keys taken raw from the userinfo, split on the last `@`), and by hand
  against SeaweedFS with the image's `mcli` 2025-08-13 (a secret with `/`
  and `+` works, a wrong one is refused). Evidence: `m5.backup` «R111: the
  S3 copy never puts the keys on a command line» (SeaweedFS S3 with a real
  signature check; a wrapper records every `mcli` command line) red
  (`--quiet alias set rr http://s3:8333 rrkey rr/Secret+x9`) → green (the
  dump is in the bucket, no key in any command line). A secret containing
  `:` would be read as a session token by `mcli` (its `hostKeyTokens`
  form); S3 secrets do not use it. Checks: `pnpm test` 71/72 (the known
  docs-link test), lint, format, typecheck, i18n-check (2312), shellcheck
  clean. VPS action: none (S3 is not configured on the stand).

- **R112 Done (local) — a failed S3 copy or files archive still reported
  `ok`, S3 got only the dump, and weekly dumps outlived their archive.**
  Cause: `once` ran `tar … 2>/dev/null || true` and `upload "$dump" || log`,
  then `status ok`, so `maintenance.backup-check` saw `ok` while the
  off-site copy did not exist; only the dump was uploaded, never
  `files-*.tar.gz`; the archive was pruned after 14 days while weekly
  dumps live 8 weeks, so `restore.sh` found no files for them. `upload`
  also ended with `log`, so a failing `mcli cp` returned 0. Repair: a
  failed archive (removed, `files-failed`) or upload (`upload-failed`) is
  written to `.last-status` as the state — any state but `ok` already
  raises `backup.failed` with it as the detail — and `once` exits
  non-zero; the dump stays either way. The archive is uploaded with the
  dump; Sundays hard-link `files-weekly-<stamp>.tar.gz`, pruned with the 8
  weeklies; `restore.sh` takes it for a weekly dump (the daily one for a
  weekly dump taken before this change). `docs/backup.md` says so.
  Evidence: `m5.backup` «R112: the files archive travels with the dump,
  and a failed copy is reported» (SeaweedFS S3; a `date` wrapper makes the
  run a Sunday) red (`files-weekly-… missing`) → green (both files in the
  bucket; with S3 stopped the run fails and the state is `upload-failed`;
  12 weekly archives rotate to 8); `rr.test.mjs` — a weekly dump restores
  its weekly archive, red on the old `restore.sh` → green; AC-202, 26.4 R3
  and R111 still green. Checks: `pnpm test` 71/72 (the known docs-link
  test), lint, format, typecheck, i18n-check (2312), shellcheck clean.
  VPS action: none.

**Exact next:** package 3, R58 + P-20 — host/CIDR validation in the
settings schema and on import; the proxy rendered into a temporary directory
and switched only after `nginx -t`/`caddy validate`, with a last-known-good.
M5 stays NOT VERIFIED; TASK-M5-004 is unchanged.

## VPS acceptance run — 2026-09-26

Current milestone remains M5 (NOT VERIFIED); TASK-M5-004 remains the sole
milestone task. The owner redeployed the test VPS from scratch
(`test.raccoonito.org`, `/opt/test`, profile `nginx`, `RR_TLS_MODE=acme`,
images `ghcr.io/vaqybin/*:dev` from `images.yml` run 36241561466 at
`f34a095`) and walked the stand by hand. Nothing below is repaired yet. The
owner's rule for this pass: record everything, fix afterwards, one
Conventional Commit per repair, security/money first.

**Worked on the stand:** `./scripts/rr up` → HTTPS ready (ACME); step 7
checks; setup wizard (with `https://` in the panel URL); YooKassa purchase
and top-up; balance top-up via YooKassa and plan purchase from the balance
(after workaround W2); trial; existing Remnawave user matched by Telegram
ID (no duplicate), tag TRIAL → MONTH after purchase; promocode preview
amounts; console reconcile button (answers `{checked:0,…}` — correct with no
panel users yet).

**Manual changes on the stand (not in code):**

- W1 `UPDATE plans SET description='{"ru":"","en":""}' WHERE description='{}'`
  (made `/account/plans` load — confirms F5).
- W2 `UPDATE payment_providers SET enabled=false WHERE code='balance'`
  (made top-up use YooKassa — confirms F6).
- `brand.support_forward_chat_id` set to a forum supergroup id.
- Fake payments from F1 are still in the stand's data: six top-ups
  (100+100+300+500+1000+100 = 2100 ₽) and one 299 ₽ purchase at
  2026-09-26 13:09:47 UTC, all with `payment_events.headers->>'source'='poll'`
  from provider `balance`. Owner leans to redeploying after the fixes.

**Owner decisions recorded:**

- Support: per-user forum topics in the operator chat — **wanted** (beyond
  FR-124; see F14).
- Rate limits: to be **discussed as a whole** before changing (F17); the
  owner has hit 429s before.
- Bot «Профиль» contents: the full profile (owner, 2026-09-26; F9 done).
- Provider forms: separate fields instead of JSON, in the wizard and the
  console (F12).

### Findings, in repair order

**P0 — money / security**

- **F1 Done — free payment through provider `balance` + recheck.** Cause:
  a balance invoice whose settlement failed with `INSUFFICIENT_FUNDS` stayed
  `pending` (row and debit were separate transactions); the same request
  again under its `Idempotency-Key` handed that invoice back, and «Проверить»
  (`MeService.checkInvoice`) or the console recheck called
  `BalanceProvider.fetchStatus`, which answers `paid`. A top-up could also be
  "paid" from the balance, and `createInvoice` did not check AC-061.
  Repair: `PaymentsRepository.createBalanceInvoice` writes the row and the
  debit in one transaction (refused → no row); `recheck` returns the invoice
  unchanged for providers without `statusPolling` (balance, Stars);
  `requireOffered` refuses a balance top-up and any provider that is not
  enabled with `lastHealthcheckOk=true` (`409 PROVIDER_UNAVAILABLE`; `mock`
  exempt as in `providerConfig`). `BalanceProvider.fetchStatus` still answers
  `paid`: section 11.3.7 prescribes it, and it is true once no pending
  balance invoice can exist. Other `fetchStatus` implementations audited:
  YooKassa, Robokassa, Lava, Platega and CryptoBot query the provider; Stars
  answer `pending`. Evidence: E2E `account.spec.ts` «leaves no invoice to
  check…» red on the old code (retry → 201 pending), green now; unit tests
  (recheck without polling, four unavailable-provider cases, balance top-up)
  red → green; `m2.payment` integration: refused balance purchase leaves no
  row, a leftover pending balance invoice is not polled, 5 parallel balance
  purchases → 1 paid, 4 `INSUFFICIENT_FUNDS`, no stray rows. Full E2E 33
  passed / 1 skipped (Telegram widget, pre-existing), API unit 292, M2/M4
  payment integration 6/6, lint/typecheck clean. Stand: the seven fake
  payments remain until the redeploy; existing pending balance invoices now
  expire instead of being paid.
- **F25 Done — a promocode on a balance payment was never applied.**
  `MeService.createInvoice` linked the reserved redemption to the invoice
  after `PaymentsService.createInvoice` returned, but a balance invoice is
  settled inside that call, so `applyReservedPromocode` found nothing: the
  redemption stayed `reserved` for good (no `used_count`, no `promo.applied`,
  never released by expiry). The redemption is now linked (`invoice_id`,
  `applied_value_minor`) in the transaction that creates the invoice — before
  `settleBalance` for the balance — and a reservation that names no invoice
  afterwards (a concurrent request with the same key created the invoice) is
  released instead of being linked to that invoice as a second redemption.
  Invariants: one redemption per invoice; `used_count` moves once at
  settlement; the balance debit is the discounted amount. Evidence:
  `m4.rewards` integration (balance purchase with 10 % → redemption
  `applied`, `applied_value_minor` 2990, `used_count` 1, balance −26910) red
  → green; M2/M4 payment integration 6/6; API 313; E2E 37 passed.
- **F26 Done — Lava, Platega and CryptoBot healthchecks always answered ok.**
  Each now makes an authenticated read-only call (contracts read 2026-09-26):
  CryptoBot `GET getMe` with `Crypto-Pay-API-Token` (help.send.tg Crypto Pay
  API, "use this method to test your app's authentication token"), Platega
  `GET /balance/all` with `X-MerchantId`/`X-Secret` (docs.platega.io: 401 on
  wrong credentials), Lava `POST /business/invoice/get-available-tariffs`
  `{shopId}` signed HMAC-SHA256 in `Signature` (developer.lava.ru OpenAPI,
  success `status_check: true`; `profile/balance` needs a `profileId` the
  configuration does not have). AC-061 therefore no longer offers these
  providers with wrong keys. Evidence: `builtin-providers.test.ts` (endpoint,
  credentials, failure) red → green; payments tests 71.
  **P1 — broken core flows**

- **F2 Done — bot errors were invisible (FR-127).** Cause (verified in the
  installed grammY 1.46.0 `out/bot.js`): `bot.catch` runs only from
  `handleUpdates` (`bot.start()`/runner); `bot.handleUpdate`, which
  `BotIngress.processMessage` calls for every stream entry, rethrows a
  `BotError`, and the ingress swallowed it with an empty `catch` — no log, no
  reply, and the entry stayed in the PEL, so `XAUTOCLAIM` re-ran the handler
  every 60 s. Repair: the ingress passes a `BotError` to `bot.errorHandler`
  and `XACK`s the update (a non-`BotError` still stays in the PEL);
  `botErrorHandler` logs the incident id the customer sees, update type,
  callback data and the cause (Telegram code/method, API status/code, or the
  error name/message/stack); stream read failures are logged. Evidence:
  `ingress.test.ts` red → green, `errors.test.ts` handler cases; bot
  lint/typecheck/tests green; `docs/troubleshooting.md` explains the search.
- **F3 Done — bot called `getPaymentMethods()` without the Telegram id.**
  `GET /api/internal/v1/me/payment-methods` resolves the customer from
  `x-acting-user` and answered 403, which (with F2) silently broke the plan
  card, renewal and top-up. `ApiClient.getPaymentMethods(telegramId)` now
  sends it from all three callers. Audit: every other `/me/*` call that the
  API resolves a user for already passes it; `plans` and `topup-config` need
  none. Evidence: `api-client.test.ts` red → green; bot lint/typecheck/tests.
- **F4 Done — bot «Клиенты» sent a `happ://` URL button.** Bot API 10.3
  (core.telegram.org, 2026-08-24): `InlineKeyboardButton.url` is an "HTTP or
  tg:// URL", so the button was refused and the screen failed. The spec's
  `sub:clients` row ("one URL button per client, deep link with a caption")
  cannot be met with a custom scheme directly; each button now opens
  `https://<domain>/<locale>/open/<clientId>#<subscription URL>`, a page
  that hands the link to the client's configured `deepLinkTemplate` (at
  once, plus an «Открыть <client>» button, copy, store links). The link is in
  the fragment, so it never reaches the server or proxy logs; the page opens
  only a configured template (never `javascript:`/`data:`/`vbscript:`/
  `file:`/`blob:`) and only with an http(s) link, so it is no redirector;
  unknown client → 404; `noindex`. One button per configured client with a
  template (the Happ hard-code is gone). Evidence: bot
  `subscription.test.ts`, web `open-client.test.tsx`, E2E `site.spec.ts`
  (34 passed, 1 skipped as before).
- **F5 Done — a plan without a description broke `/account/plans`.** Section
  8 gives `plans.description` `DEFAULT '{}'` and 9.4 `description{}`, while
  the site's contract reads `{ru,en}`. The API now serialises `name` and
  `description` of every plan view (`PlansRepository` views for the public
  and admin lists, `MeService.publicPlan` for subscriptions and invoices)
  as `{ru,en}` (`planTexts`: a missing name locale falls back to the other,
  a missing description is `''`), and a plan created without a description
  stores `{ru:'',en:''}`. No migration: the read path covers existing rows.
  The console's description fields belong to F28. Evidence:
  `plans.repository.test.ts` red → green; API 293 tests, lint, typecheck.
- **F6 Done — a second `balance` payment method.** The wizard listed the
  built-in balance as a configurable provider, and enabling it wrote a
  `payment_providers` row that `/me/payment-methods` returned as a second,
  `redirect` method; the site's top-up picked it and paid the top-up from the
  balance itself. Repair: the wizard neither lists, checks nor saves a
  provider of kind `balance` (404); `/me/payment-methods` and the console
  list skip a `balance` row a stand already has (no migration needed); the
  site's top-up offers a provider choice (radio, non-balance, available
  only), and the bot asks for the provider after the amount (preset or
  typed) when more than one is offered and goes straight on with one. With
  F1, a balance top-up is refused by the API anyway. Evidence: API
  me/providers/setup tests, web `account-pages.test.tsx` (red → green), bot
  `balance.test.ts`; API 296, web 49, bot 37 tests; E2E 34 passed, 1 skipped.
- **F7 Done — `inviteeBonus: null` broke `/account/referrals`.** Section 15
  defines `referral.invitee_bonus` as `{type: none|days|balance, value}`;
  the API sent `Number(object)` → `NaN` → `null`, and the domain contract
  expected a number (the API unit fixture stored `'0'`, hiding it).
  `program.inviteeBonus` is now that object in the API and in
  `referralsSchema`. The page also compared `mode === 'fixed'`, a value the
  setting never has, so `fixed_first` was described as a percentage; it now
  states the terms per `percent_first|percent_all|fixed_first` and the
  invitee's bonus. Evidence: API contract test (`referralsSchema.parse`)
  red → green; web terms tests; API 297, web 51, domain 12 tests.
- **F8 Done — validation errors answered 500.** The API had no exception
  filter: a `schema.parse` in a service threw a `ZodError` that Nest answered
  `{statusCode:500}`; Nest exceptions (`ForbiddenException('FORBIDDEN')` …)
  had no section 9.3 envelope, which the site reads as `INTERNAL_ERROR`; no
  error carried `requestId`, no 5xx an `incidentId`. `ApiExceptionFilter`
  (global `APP_FILTER`) now answers every error with the envelope: Zod →
  400 `VALIDATION_ERROR` with `details[{path,message}]`; an envelope a
  handler built is kept; a bare Nest exception gets its code (the message
  when it is a code, else by status); anything else is 500 `INTERNAL_ERROR`
  with a ULID `incidentId` logged with the error, never its message;
  `requestId` = the proxy's `X-Request-Id` (token-checked) or Fastify's id,
  also echoed as a header. Provider webhook answers are untouched (the
  controller sends them itself). Evidence: E2E «answers an invalid field with
  400 VALIDATION_ERROR» red (500) → green, filter unit tests; API 302 tests;
  E2E 35 passed, 1 skipped. `docs/troubleshooting.md` explains the ids.
- **F9 Done — bot «Профиль» did nothing.** It routed to `showHome` and
  re-rendered the same message. Per the owner's decision it now shows the
  Telegram id, language, balance, referral code, receipt email and the
  subscription status and term, with «Открыть кабинет», «Язык» and «Email для
  чеков» (the `emailAsk` dialog). Evidence: bot `profile.test.ts`; bot 55.
- **F10 Done — hard-coded brand and trial.** The bot's welcome said
  «RemnaRay» and the trial confirmation always «3 дня, 10 GB». The bot
  configuration (`/api/internal/v1/bot/config`) now carries `brandName` and
  `trial {days, trafficGb}`; the home screen and the trial confirmation use
  them (0 GB → ∞). `ApiClient.getConfig` keeps the answer 30 s (it assembles
  every locale's commands), and `main.ts` reads it afresh on each
  reconfigure. A top-up's payer-visible description is `brand.name`, no
  longer «RemnaRay». Kept deliberately: `x-requested-with: RemnaRay` (a
  protocol constant), the Stars title fallbacks (unreachable once the
  description is the brand or plan), and the console TOTP issuer «RemnaRay»
  (the spec names none; it labels the console, not the shop). Evidence: bot
  home/api-client tests, API bot-config and payment-description tests red →
  green; API 303, bot 39 tests.
- **F11 Done — landing «Войти» showed no login widget.** The legacy Telegram
  Login Widget draws its iframe where its `<script>` is; `next/script`
  appended the script to `<body>`, so the button appeared at the very bottom,
  outside `#login`. `LoginWidget` now creates the script inside `#login` (and
  removes it and its iframe on unmount); the frame-title observer watches
  the block. `docs/setup.md` explains `/setdomain`. The E2E harness never
  passed the seeded bot token to the specs, so the widget-callback test was
  always skipped; it runs now. Evidence: web accessibility test (script
  inside `#login`) red → green; E2E landing asserts it; E2E 36 passed, 0
  skipped. Contract: core.telegram.org/widgets/login-legacy (2026-09-26) —
  `/setdomain`, HMAC-SHA256 with SHA256(bot token), no sunset notice.
- **F12 Done — payment providers took raw JSON and could not be edited.**
  `providerFields(configSchema)` (`z.toJSONSchema`, input side) describes each
  provider's fields (type, required, secret, default, format); the wizard's
  state and `GET /api/admin/v1/providers` carry them, and one shared form
  (`apps/web/app/_components/provider-fields.tsx`, labels/hints in
  `setup.json` and `admin.json`) replaces the JSON box in step 7 and gives the
  console «Настроить» (enabled, customer-facing name, fields), ↑/↓ reorder and
  «Проверить». The API checks a configuration against the schema on check and
  save (a refused field is 400 `VALIDATION_ERROR` with its path) and stores it
  parsed, with defaults; in the console the fields sent replace the stored
  ones and an empty secret keeps its stored value (`mergeProviderConfig`).
  Evidence: API provider-fields/setup/providers tests red → green, web form
  helper tests, E2E wizard (ЮKassa form, «Далее» disabled until complete) and
  console (configure → saved, check ok); API 309, web 54, E2E 37 passed.
- **F13 Done — bot referral screen.** The screen showed only the site link
  and two counts. It now follows the section 12 `ref` row: the bot link
  `t.me/<bot>?start=ref_<code>` (`botLink`), invited, paid and earned
  (FR-151), the programme's terms per mode and the invitee's bonus;
  `ref:share` is `switch_inline_query` with «Присоединяйся к <brand>: <link>»
  (Bot API: it asks for a chat and inserts `@bot <text>`, no inline mode
  needed), and `ref:list` shows the last ten invited (masked names, date,
  status, reward). The English link preview: section 13.1 picks the locale
  from `rr_lang`, then `Accept-Language`, then `ru`, so a preview fetched with
  an English `Accept-Language` is English by design — no change. Evidence: bot
  `referrals.test.ts` (red → green), 41 bot tests.
- **F14 Done — support (FR-124).** Without an operators' chat the API
  answered 204 and the bot said «передано»; nothing relayed an operator's
  answer; a failed forward was silent; the API called `api.telegram.org`
  directly, ignoring `RR_TELEGRAM_API_URL`. Now: without the chat, «Поддержка»
  shows `support_contact` (the `supportMessage` dialog only exists with the
  chat, section 12) and the API refuses `409 SUPPORT_UNAVAILABLE`; a failed
  forward is `502` and the customer is told. `SupportService`: in a forum
  supergroup (owner's decision) each customer gets a topic (`createForumTopic`,
  recreated if deleted); without the `can_manage_topics` right it falls back to
  the general chat and alerts `support.topics`; in a plain group the message
  id is kept 30 days for replies. The bot's `supportRelay` (before sessions and
  dialogs) sends an operator's message in a topic, or a reply to a forwarded
  message, to the customer in their language, and answers «Не доставлено» when
  the customer blocked the bot. Contracts (Bot API 10.3, 2026-09-26):
  `createForumTopic` needs admin + `can_manage_topics`; `sendMessage`
  `message_thread_id`; `Message.is_topic_message`/`message_thread_id`/
  `reply_to_message`; features#privacy-mode: bot admins receive all messages,
  privacy-mode bots receive replies to their messages. Mapping in Valkey
  `rr:support:*`. `docs/support.md`. Evidence: API `support.service.test.ts`,
  bot `support.test.ts`/`screens/support.test.ts`; API 313, bot 47 tests.
  Not verified with a real Telegram group yet (stand walk).
- **F15 Done — bot `/help` was a stub.** Section 12 gives `/help` "client
  instructions + FAQ (locale keys)". It now shows the connection steps and the
  FAQ from the landing page's own keys (`landing.steps`, `landing.faq`, read
  raw from the catalog since they are JSON arrays, not ICU), so one edit in
  «Локали» changes the site and the bot, and the clients with their platforms
  from `settings.clients.items` (now in the bot configuration), then a pointer
  to «Поддержка». Evidence: bot `help.test.ts` red → green, API bot-config
  test; bot 48 tests.
- **F16 Done — bot balance history showed raw ISO UTC timestamps.** The
  `balance` screen (section 12: balance, last five transactions) now lists
  «27.09.2026, 01:30 · пополнение · 100 ₽»: dates in `locale.timezone`
  (now in the bot configuration; an unknown zone falls back to UTC) and the
  customer's language, the operation type from `bot.screen.balance.type.*`.
  Every other date the bot shows (subscription end, invoice deadline,
  referral list) uses the same zone. Evidence: bot `balance.test.ts` (UTC
  20:30 → 01:30 next day in Yekaterinburg) red → green; bot 49, API bot tests.
- **F17 Done — the console hit 429 on page switches.** Every console page
  reads `GET /api/admin/v1/auth/me`, which the section 21.3 template limits
  with sign-in's 5 r/m; `rr_admin` (30 r/m) was also below one busy page.
  Owner decision (2026-09-26): nginx keys a new `rr_signin` zone (5 r/m, burst 10) by `$request_method` so it counts POSTs only, on `/api/v1/auth/` (with
  `rr_api`) and `/api/admin/v1/auth/` (with `rr_admin`); `rr_admin` is 120 r/m
  with burst 120; `rr_auth` stays for the setup wizard; Caddy renders the same
  (`rr_signin` with `match { method POST }` — caddy-ratelimit README at the
  pinned commit — and `rr_admin` 240 events/1 m). Deviation from 21.3 recorded
  in `ratelimits.inc` and `docs/proxy.md`. Evidence: proxy-render tests red →
  green; `m5.proxy` integration (`nginx -t`, `caddy validate` on the built
  image) green.
- **F27 Done — the bot `sub` screen lacked the section 12 content and buttons.**
  `sub` now shows FR-041's plan, end date and days left, traffic used of the
  limit, devices n of m (from the panel; «—» when it cannot be read) and the
  panel status, with `sub:clients`, `sub:qr`, `sub:devices`, `renew`,
  `plan:change` (when allowed), `sub:revoke` (when allowed) and back;
  `sub:revoke:confirm` has its own warning. `sub:clients` offers
  `sub:guide:<platform>` for the platforms of the configured clients
  (`bot.guide.<platform>`, editable in «Локали»). `sub:devices` lists the HWID
  devices with `dev:rm:<hwid8>` when `user_can_remove_devices` (FR-026).
  `plan:change` lists the other plans with the EX-06 quote, `plan:change:<slug>`
  confirms price, credit and amount due, and pays through
  `plan:change:go:<slug>:<provider>` (a `plan_change` invoice). Payment buttons
  (plan card and plan change) put the balance first only when it covers the
  amount (section 12 `plan:<slug>`); before, the plan card offered the balance
  whenever top-ups were enabled. Evidence: bot subscription/plan-change tests;
  bot 53 tests; every bot message compiles as ICU.

- **F28 Done — console plan editor fell short of FR-145, and plans could grant
  nothing.** The panel receives `plan.squads` as `activeInternalSquads`
  (`remnawave.service.ts`), so a plan without squads takes every squad away
  from its buyers; the console always sent `squads: []`, the wizard selected
  none by default, and section 8's `CHECK cardinality(squads) > 0` did not
  exist. Now: the API refuses a plan (create or patch) without squads;
  migration 0008 adds the CHECK `NOT VALID` (enforced on new/changed rows,
  an upgrade never fails; `docs/upgrade.md` tells the owner to fix older
  plans); the wizard preselects every squad the panel returned and cannot go
  on without one; the console form creates and edits every FR-145 field
  (names, descriptions, days, traffic + reset strategy, devices, price,
  public/active, squads from `GET /api/admin/v1/panel/squads`) and marks a
  plan «Нет сквадов». Fixtures and `seed-dev` use the mock panel's squad; the
  seeded E2E shop now talks to the panel mock. **Stand check needed:** if the
  stand's MONTH plan was created without squads, the owner's purchase took his
  panel user's squads away — look at the user in the panel. Evidence: plans
  service test red → green, migration test, 25/25 integration, web 54, API
  317, E2E 37 (console creates with a squad and edits).

- **F29 Done — the site login moved to Telegram's OIDC (owner decision
  2026-09-26).** Contract read 2026-09-26 from core.telegram.org/widgets/login,
  the library `oauth.telegram.org/js/telegram-login.js?6` and the live
  discovery/JWKS: popup via `Telegram.Login.auth({client_id, nonce, lang})`,
  `redirect_uri` = the page, which must be an Allowed URL (BotFather mini app →
  Login Widget); callback `{id_token, user}` | `{error}`; `id_token` RS256
  (`oidc-1`) or ES256 (`oidc-es256-1`), `iss https://oauth.telegram.org`, `aud`
  = the bot id. API: `TelegramOidcVerifier` (JWKS cached 1 h, `node:crypto`),
  `GET /api/v1/auth/telegram/nonce` (signed 10-minute nonce + HttpOnly cookie
  `rr_oidc_nonce`, Path `/api/v1/auth`), `POST /api/v1/auth/telegram/oidc`
  (cookie nonce must match the token's, one use via Valkey `SET NX`, same
  throttle as the widget route, referral cookie honoured); the section 13.3
  HMAC route stays. Site: an own button that opens the popup inside the click
  with a prefetched nonce; CSP `script-src`/`connect-src` add
  `https://oauth.telegram.org`. `[verify]`: the Telegram id is the `id` claim
  (profile scope; in the documented example, not in `claims_supported`) —
  confirm on the first live login. Evidence: verifier tests (11), service
  tests, web widget/CSP tests, E2E sign-in with a locally published JWKS
  (38 passed). Stand: in the BotFather mini app → Login Widget press **Switch
  to OpenID Connect Login** (the stand's bot is still on the legacy
  `/setdomain` widget — owner screenshot 2026-09-26), then add Redirect URIs
  `https://<domain>/ru` and `https://<domain>/en` (exact match; the library's
  `redirect_uri` is `location.origin + location.pathname`), the Trusted Origin
  `https://<domain>` (no trailing slash) and
  compare the shown Client ID with the bot token's id; `docs/setup.md` says so.

**P2 — usability**

- **F18 Done — worker jobs failed before setup.** Every scheduled job got
  `503 SETUP_NOT_COMPLETED` while the wizard ran and was recorded as failed
  (61 on the stand), with a warning every 30 s. The worker now recognises that
  answer (`setupPending`) and completes such a job as skipped
  (`skipWhileSetup` around every queue's processor); any other failure still
  fails. A daily check skipped this way is not recorded, so it is asked again
  within `CHECK_RETRY_MS` after setup. Evidence: `setup-pending.test.ts`;
  worker 28 tests; `m1.worker-cron` integration.
- **F19 Done — «Последняя сверка с панелью» showed the last user write.** It
  was `max(panel_users.synced_at)`, so a reconciliation over no users (or one
  with no drift) never showed. `RemnawaveService.reconcile` now records its
  time and outcome in Valkey (`rr:panel:reconcile:last`); `/admin/system`
  shows it with «Проверено N, расхождений M» and the dashboard's attention
  block shows its time. Evidence: `reconcile-record.test.ts`; API and web
  tests.
- **F20 Done — `./scripts/rr up` did not pull.** A leftover `app:dev` image
  started with the new `compose.yaml`. `up` now pulls the active profile's
  images first when `RR_VERSION` is not a release tag (the images workflow's
  `dev` is rebuilt under the same name) or when given `--pull`; a release tag
  is not pulled on its own, because `rr build` tags a source checkout's images
  with it and a pull would replace the local build. `docs/upgrade.md` now uses
  `rr up --pull`; `install.md` explains the `dev` case. Argument parsing takes
  `--pull` and `--wait-timeout` in any order. Evidence: `rr.test.mjs` (dev →
  pull before up; default and `1.2.3` → none; `--pull` → pull) red → green.
- **F21 Done — the wizard's panel URL needed `https://`.** `panelUrlSchema`
  takes an address typed without a scheme as `https://…` (the scheme a panel
  behind TLS answers on), keeps an explicit `http://`/`https://`, refuses
  anything else; the wizard's step and the console's panel settings use it,
  and the field has a hint. Evidence: `setup.schemas.test.ts` red → green.
- **F22 Done — the time zone was a free text field.** `settings.locale.timezone`
  accepted any string (only the wizard checked it), and an unknown zone breaks
  every date the bot and the site format. `ianaTimeZone` (known to `Intl`) now
  guards the setting and the wizard alike; the wizard and the console offer
  the browser's IANA zones as suggestions (`<datalist>`), with a hint. The
  spec does not mandate a picker, so a typed zone still works if valid.
  Evidence: settings service test (unknown zone refused, valid accepted) red
  → green; web 54; E2E 37.
- **F23 Done — the promocode «Применить» sat in every plan card.** One
  «Применить» now stands next to the field; it previews the code for every
  plan at once (section 15.5 preview is per plan), and each card shows its
  discounted price or why the code does not apply to it; a code refused by
  every plan is also a toast. Evidence: E2E «applies a promo code with one
  button next to the field» (a seeded `E2E10`) red on the old page → green;
  E2E 38.
- **F24 Done — answers that break a page's contract.** F5 and F7 were 200
  answers the site's Zod schema refused: the domain client threw a `ZodError`,
  the page showed «Не удалось загрузить» and «Код инцидента: » with nothing
  after it. The client now turns such an answer into
  `ApiError('CONTRACT_MISMATCH')` with the response's `X-Request-Id`, and logs
  the failing field paths to the browser console; `errors.contract_mismatch`
  asks to reload and gives the request code. The 5xx `incidentId` of the
  section 9.3 envelope (F8) now reaches the message too (it was always
  empty), in the account and the console. Class check: an API contract test
  parses every `/me` read the site makes (`/me`, subscription, payment
  methods, top-up config, transactions, referrals, referral list) with its
  domain schema from a user with nothing yet; plans are covered by the F5
  repository test. Evidence: domain client test and web page test red →
  green; API 320, web, E2E 38.

### Review of the repairs (2026-09-26)

An independent read-only review of the money, secret and trust-boundary
commits (F1, F4, F6, F8, F12, F14, F25, F26, F28) found no critical or high
defect; five findings were confirmed and repaired, one commit each:

- F4 follow-up (`b15f467`): `/open` launched the client by itself with any
  http(s) link in the fragment — a crafted shop URL could import someone
  else's servers. Now tap-only, https-only, and it shows the server's host.
- F28 follow-up (`2454135`): a `NOT VALID` check is still checked on every
  update, so a legacy plan without squads could not be deleted, deactivated
  or reordered and stayed on sale. Migration 0009 takes such plans off sale
  (slugs printed by `migrate`) and allows empty squads only on inactive or
  deleted plans; activating one without squads is a 400 field error.
  Deliberate deviation from section 8's plain `CHECK cardinality(squads) > 0`,
  for upgrades only: a plan on sale always has squads.
- F14 follow-up (`1f9c549`): relayed answers arrived with HTML entities; now
  sent as HTML.
- F25 follow-up (`04a85a6`): a failure after the invoice was created released
  a reservation the invoice already named; now only an unlinked one is
  released (integration test with a failing outbox insert, red → green).
- F8 follow-up (`ea05722`): validation refusals are logged with request id,
  route and field paths (never values).

Checks after the repairs: format, lint, typecheck, 30 turbo test tasks, root
tests, 25/25 integration, E2E 38 passed.

### Second walk (2026-09-26 evening, after the redeploy)

The owner redeployed with the repairs and walked the stand again. Findings,
recorded before repair; owner decisions of 2026-09-26 are quoted with each.

- **F34 Done (P0, auth) — the site's OIDC login answered `AUTH_INVALID_SIGNATURE`.**
  Evidence: the owner's `id_token` (header and payload only): `kid oidc-1`
  RS256, `aud "8619282969"` (the Client ID BotFather shows), `iss`, `nonce`
  as issued, `exp − iat = 30 s`, and `"id": "7556126867"` — a **string**. The
  `[verify]` item of F29 is answered: Telegram sends `id` as a string of
  digits, not the number of its documentation example; the verifier required
  a number. Also: every refused check answers the same code and nothing is
  logged, so the cause needed the token. Repair: accept a decimal string or
  a safe integer; log which check refused (no token). Done: `telegramId()` in
  `telegram-oidc.ts` takes a number or 1–16 digits within a safe integer;
  `AuthFailure.reason` names the check (signature, iss, aud, nonce, id, key
  id, cookie nonce, reuse) and `AuthService` logs `Telegram OIDC sign-in
refused: <code> (<reason>)`; the answer is unchanged. Evidence: verifier
  tests red on the old code (10 failed) → green, service test asserts the
  log lines, E2E OIDC sign-in with a live-shaped token (string `id`, 30 s)
  passed.
- **F30 Done (P1) — bot «Проверить оплату» on an unpaid invoice → «Произошла
  ошибка».** Bot log `incidentId zB7PFMjZ`: `description: 'api_error'` for
  `POST /api/internal/v1/me/invoices/<id>/check`; status and code awaited
  from the owner. A repeated press would also hit Telegram's «message is not
  modified» in `show()`. Cause (found in the code): the worker's
  `payments.poll-pending` every 30 s runs `PaymentsService.pollPending`,
  which called `recheck` and so took FR-064's one-check-per-10-s allowance
  of every pending invoice; a press in those 10 s got `PaymentError
RATE_LIMITED`, which `MeService.checkInvoice` did not map, so the API
  answered 500 (a provider that did not answer did the same). Done: the
  background poll no longer counts against the limit; the check answers 429
  `RATE_LIMITED` or 409 `PROVIDER_UNAVAILABLE` (logged with the provider's
  error), the console «Перепроверить» too; the bot writes onto the invoice
  when it was checked, that checks are one per 10 s, or that the payment
  system did not answer, and `show()` treats «message is not modified» as
  done. Evidence: API tests red on the old code (3) → green; bot screen
  tests.
- **F31 Done (P1, owner decision) — dashboard revenue counted a top-up and the
  balance purchase paid from it (300 + 299 = 599 ₽).** FR-142 literally sums
  `purchase + topup − refund`, which counts money spent from the balance
  twice. Owner decision (variant Б): revenue, payments and the average check
  count money received from providers — top-ups and purchases whose provider
  is not `balance`; refunds to the balance are **not** subtracted (the money
  stays with the shop as the users' balance, shown as the liability).
  Top providers leave out `balance`. Deliberate deviation from FR-142.
  Done: one `RECEIVED` condition in `dashboard.service.ts` for revenue,
  payments, the average, the daily series and top providers;
  `docs/admin.md` records the deviation. Evidence: `m4.admin` integration
  with a balance purchase and a refund in the fixture — old SQL 129 700,
  expected 109 800 → green.
- **F32 Done (P2) — console transactions:** «Вернуть на баланс» is offered on a
  `topup` row, which the API refuses (refunds are purchases only since
  `0d11ff7`); types show raw codes and a balance purchase is not named as
  such. Repair: the button on purchases only; localized type and «с
  баланса». Done: `admin/payments/labels.ts` (type, status and «С баланса»
  labels; `refundableMinor` — purchases only, the amount left), a provider
  column on transactions, the refund dialog opens at the amount left.
  Evidence: label unit tests, console render test red on the old page →
  green, web 58.
- **F33 Done (P2, owner request) — the landing's «Войти» scrolls to the block at
  the bottom of the page.** Repair: «Войти» opens a modal with the Telegram
  sign-in. Done: `[locale]/login-dialog.tsx` — «Войти» in the hero and in the
  closing block opens «Вход в личный кабинет» with «Войти через Telegram»
  (the nonce is asked for on opening); `/?login=1`, where the account sends a
  visitor without a session, opens it by itself, which section 13.2 asks for
  and was missing; closing drops `login=1`. Evidence: dialog unit tests, E2E
  site and account specs 22 passed (sign-in through the dialog, the
  redirect opens it).
- **F35 (P1, owner decision) — support: a customer cannot answer an
  operator.** «Поддержка» waits for exactly one message, so every further
  message needs the button again. Owner decisions: an **optional separate
  support bot** — its token is an optional step of the setup wizard and a
  field in the console's settings. When it is set, «Поддержка» in the shop
  bot opens the support bot; every message there goes straight to the
  customer's forum topic, and the operators' answers in the topic come from
  the support bot. Without it, support stays in the shop bot, but the
  conversation stays open (no second press). Text, photos, files and voice
  messages are copied both ways. Beyond FR-124.
  **F35a Done — support in the shop bot.** «Поддержка» opens a conversation
  (`POST /api/internal/v1/support/open`, Valkey `rr:support:open:<id>`, 24 h
  idle): every message nothing else takes (`support-inbox.ts`, the bot's
  last middleware) goes to the operators until «Завершить»
  (`support/close`); an operator's answer reopens it
  (`SupportService.route`), so the customer answers by writing. Messages are
  copied (`copyMessage`, Bot API 10.3 read 2026-09-26): a forum topic opens
  with a card (id, username, name, language), a plain group gets a card and
  the copy replying to it, both answerable. Operators' text answers keep
  «Ответ поддержки», media is copied, both with «Завершить». Deliberate
  deviation from section 12: the one-message `supportMessage` dialog (10 min)
  is replaced by this conversation (owner decision). Evidence: API support
  tests (copy, cards, open/close/answer), bot relay, inbox and screen tests;
  API 343, bot 68.
  **F35b Done — the optional support bot.** Settings `bot.support_token`
  (secret), `support_username`, `support_webhook_secret_path|token`;
  `configureSupportBot` checks the token with `getMe` and refuses the shop
  bot's (`SUPPORT_BOT_INVALID`/`SUPPORT_BOT_SAME`). The wizard's «Бот» step
  takes the support bot token and the operators' chat id (both optional; a
  «Проверить бот поддержки» button); the console has «Настройки» →
  «Поддержка» (`GET/PUT /api/admin/v1/bot/support`, token never shown). The
  bot process runs it beside the shop bot (`support-bot.ts`,
  `main.ts#configureSupport`) in `bot.mode`: its own webhook secret path and
  token under `/tg/webhook/`, stream `tg:support-updates`, group
  `support-bot`; a replaced or removed bot loses its webhook. With it, the
  shop bot's «Поддержка» links to it and its relay is silent; the support
  bot copies every customer message to the topic (`via: 'support'`) and the
  operators' answers back as they are; `SUPPORT_MOVED` covers a message sent
  through the other bot. Evidence: API webhook/config/support/setup/console
  tests, bot support-bot (`handleUpdate`), ingress channel, relay, screen
  and inbox tests, web console tab test. Review follow-up (independent
  read-only review of `f519900..5db3cf5`: no critical or high defect; two
  confirmed and repaired): a support bot that failed to start (revoked
  token) made the timer redo the shop bot's setup every 2 s, piling up
  runs — now only the support bot is retried, with a backoff up to 5 min,
  and the timer queues nothing while a run waits; turning the support bot
  off left its webhook secrets valid and its stream readable by the next
  bot — now clearing or changing the bot drops the secrets, each support bot
  has its own stream `tg:support-updates:<bot id>` and a replaced bot's
  stream is deleted.

- **F36 (owner request, 2026-09-27) — support tickets.** The third walk
  confirmed the separate support bot works (after adding it to the operators'
  group), the site sign-in (F34), the dashboard revenue (F31) and top-ups
  (F30). The owner asked for a ticket flow on top of F35: a numbered ticket per
  request, `🎫 Открыт тикет #N` and a full customer card in the topic, take /
  close / silent close, and chose (AskUserQuestion): any member of the
  operators' chat may take and close; messages kept in the database; in this
  iteration also rating and statistics, templates and internal notes, topic
  status with reminders and auto-close, actions from the card (only for
  console admins linked by `admins.telegram_id`, with the section 14.2 limits
  and the audit log), and a self-help FAQ. A web support chat is later (the
  stored tickets are its base). Beyond FR-124 and section 12; deliberate,
  recorded extension. Design (local, `docs/development/specs/` is not tracked):
  `docs/development/specs/2026-09-27-support-tickets-design.md`; plan:
  `docs/superpowers/plans/2026-09-27-support-tickets.md`. Stages, one commit
  each:
  1. **Done — tickets core.** Migration `0010_support_tickets`
     (`support_tickets` with the live-ticket partial unique index,
     `support_messages`, `support_topics`, `support_templates`, `support_faq`);
     new API module `modules/support` (`TicketsRepository`, `card-data.ts`,
     `ticket-card.ts`, `SupportService`, internal routes `support/forward`,
     `open`, `close`, `operator`, `callback`; `support/route` removed — the API
     relays answers itself). The bot is the transport: the relay hands the
     operators' messages and `st:*` buttons to the API and answers the button
     with its text; the support bot registers a first-time writer
     (`users/upsert`) and offers «Закрыть обращение». Anonymisation clears the
     customer's support messages. Evidence: API support unit tests (16) and
     card tests (4), bot relay/inbox/support-bot/screen tests, integration
     `m4.support` on PostgreSQL 18 (five concurrent messages → one ticket;
     numbering; conditional close; topics; the card's received money).
  2. **Done — notes and templates.** `//text` is a `note` message (never
     sent); `/t` lists `support_templates`, `/t <code>` answers in the
     customer's language (fallback: the shop's, then any) and counts as the
     answer (takes the ticket). Console API `api/admin/v1/support/templates`
     (`support.read` to list, `support.write` to edit, audited); RBAC gains
     `support.read` (admin, operator) and `support.write` (admin). Evidence:
     service tests (note, list, ru/en fallback, support-bot plain text, no
     ticket), console service tests (CRUD, duplicate code, bad input), RBAC
     test.
  3. **Done — rating and statistics.** A close (by an operator, or by the
     customer) asks for ★1–★5 (`rate:<ticket>:<n>`); `support/rate` takes the
     first rating of the customer's own closed ticket (conditional update)
     and posts it to the topic and the card. `GET /api/admin/v1/support/stats`
     (SQL over `support_tickets`): opened, closed, open now, first answer
     average/median, resolution, rating, per assignee. Evidence: service
     rating tests (open ticket, once, someone else's), bot rating tests,
     `m4.support` stats on PostgreSQL.
  4. **Done — topic status, reminders, auto-close.** The topic status
     (🟢/🟡/⚪ via `editForumTopic`) came with stage 1. Settings group
     `support` (`remind_after_minutes` 15, `autoclose_hours` 48; 0 = off;
     editable in «Настройки»). Worker cron `maintenance.support-sweep` every
     minute → `POST /api/internal/v1/support/sweep`: one reminder per untaken
     ticket in the operators' chat with a `t.me/c/…` link (conditional
     `reminded_at`), and the auto-close of a ticket where the operators spoke
     last and the customer stayed silent (`closed_by=auto`, the customer
     asked for a rating). Evidence: service sweep tests, worker cron and
     routing tests, `m4.support` sweep SQL on PostgreSQL.
  5. **Done — actions from the card.** Buttons `st:ext7|ext30|reset|link` on a
     live ticket's card and `/extend <days> [reason]`, `/credit <amount>
[reason]` in the topic. `SupportActions` requires an active console
     admin with that `admins.telegram_id`, checks the section 14.2 matrix
     (`users.mutate`, `users.read`, `users.balance.credit`) and calls
     `AdminUsersService.extend|resetTraffic|adjustBalance` (the operator's
     daily limit, `SELECT … FOR UPDATE` on the account, integer kopecks), then
     writes the console's audit row (`support #N`, `telegram:support`).
     Idempotency: a button per operator/ticket/action once per 10 s, a
     command once per Telegram message (Valkey `SET NX`). Evidence: actions
     unit tests (not an admin, audit row, limit → refusal, missing
     subscription/panel), service tests (double tap, redelivered /credit,
     link to the customer, alert), `parseAction` tests, `m4.support` on
     PostgreSQL (credit within the limit → balance, adjustment and audit
     rows; over the limit and a non-admin → nothing).
  6. **Done — self-help FAQ.** `support_faq` edited in the console
     (`api/admin/v1/support/faq`, `support.write`, audited); internal
     `GET support/faq?locale`, `support/faq/:id`, `support/subscription-link`.
     The shop bot's «Поддержка» shows the questions and «Написать оператору»
     (`support:write` opens the conversation; with no questions it opens at
     once, as in F35); the support bot's `/start` shows the questions, «Моя
     ссылка подписки» and «Написать оператору». Answers are HTML-escaped
     plain text. Evidence: API faq/link tests, console FAQ tests, shop screen
     and support-bot tests.
  7. **Done — console section.** `/admin/support` (nav, `support.read`):
     «Тикеты» (filters: not closed/new/in work/closed/all, search `#N`,
     Telegram id, `@username`, `?userId=` from the user page; the history
     below the list), «Статистика» (period, totals, per operator),
     «Шаблоны» and «FAQ» (editors only with `support.write`). API
     `GET api/admin/v1/support/tickets`, `tickets/:id`. Evidence: web page
     tests (list, stats, read-only vs editable), `m4.support` list filters,
     cursor and history on PostgreSQL.
     Wrap-up: changesets (`c48d22f`). Independent read-only review of
     `c947a44..c48d22f` — no critical or high defect; the trust boundaries
     (operators' chat check, customer-owned rating/close, admin-only card
     actions, `support.write`) and money paths (`adjustBalance`, limits,
     kopecks, command idempotency) hold. Repaired, one commit each: the card
     over Telegram's 4096 characters with a long admin note (`60ffd57`); a
     take or first answer reopening a ticket closed meanwhile (`dcec288`); the
     link button's 500 for a customer who blocked the bot (`0cb3afb`); card
     actions de-duplicated per ticket and action for a minute, not per
     operator for 10 s (`548f6a8`); `/credit 1 000 …` refused (`a8811b7`);
     anonymous-admin answers passed on (`f5b5462`); strict UUIDs in buttons and
     FAQ ids (`dfbb223`); popups as plain text (`8b5b7a9`). Checks: format,
     lint, typecheck (21), turbo test (30), root 55, `test:m4` 7/7 (with
     `m4.support`), E2E 38 passed. Known, not F36: `changeset status` fails
     on dev because 35 existing changesets mix private apps with public
     packages (changesets v3 refuses); CI does not run it.

### Next

1. P0, P1 except F9/F17, and P2 — done (F1–F8, F10–F16, F18–F28).
2. F9, F17, F29 — done. Owner decisions of 2026-09-26: F9 — the full profile (Telegram id,
   language, balance, subscription status and term, referral code, receipt
   email; «Открыть кабинет», «Язык», «Email для чеков»). F17 — separate sign-in
   from the console: 5 r/m only on the sign-in and TOTP `POST`s, `auth/me` in
   the console zone, the console zone raised to about 120 r/m (burst 120),
   the rest as section 21.3; the deviation is recorded. F29 — move the site
   login to Telegram's OIDC now. Order: F9, F17, F29.
3. Redeploy and second walk — done (2026-09-26 evening); its findings
   F30–F35 are repaired (F34 `7fb605e`, F31 `a463046`, F32 `748415d`, F33
   `8030a06`, F30 `ba5b014`, F35a `fc600e1`, F35b `03da758`), plus the wizard's
   sign-in hint (`168db68`) and the batch's changesets (`5db3cf5`). Checks:
   format, lint, typecheck, 30 turbo test tasks, root 55, build, integration
   25/25, E2E 38 passed.
4. Next: push, rebuild the `:dev` images, `git pull` and `./scripts/rr up` on
   the stand, then `./scripts/rr proxy:reload` (the F17 limits); in BotFather
   the Trusted Origin without a trailing slash; re-check on the stand: the
   site sign-in (F34 — the first live login after the fix), «Проверить
   оплату» (F30), the dashboard (F31), support in the shop bot and, if wanted,
   a support bot (F35: its token in «Настройки» → «Поддержка», the support
   bot an administrator of the operators' forum with «Управление темами»).
   Then the M5-004 gates.
5. F36 walk on the stand (2026-09-27): the owner found that an operator's
   message in a closed ticket's topic opened a new ticket and decided
   (AskUserQuestion): such a message is not sent, the bot says so, and
   `/reopen` opens the last ticket again under its number (taken by the
   operator, rating cleared); an operator never opens a ticket. Done:
   `SupportService.answer` refuses without a live ticket
   (`bot.support.op.closedNotSent`), `TicketsRepository.reopen`
   (conditional on `closed`, the live-ticket index refuses a second live
   one). Evidence: service test (not sent, /reopen, answer goes, second
   /reopen), `m4.support` reopen on PostgreSQL.
6. Done on the stand (third walk, 2026-09-27): sign-in, «Проверить оплату»,
   the dashboard and the separate support bot. F36 (support tickets) is
   implemented and reviewed (`2097aef`…`8b5b7a9`). Next: push, rebuild the
   `:dev` images, `git pull` and `./scripts/rr up` on the stand (migration
   0010 runs on start), then the owner walks the tickets: the support bot in
   the forum, card buttons, notes, `/t`, rating, reminders, card actions
   (with the owner's Telegram ID set in «Администраторы»), FAQ and the
   console's «Поддержка». Then the M5-004 gates.

F17 inventory (for the discussion): nginx zones per IP — `rr_general` 20 r/s
(burst 50, site pages), `rr_api` 10 r/s (burst 30, `/api/`), `rr_auth` 5 r/m
(burst 10 on `/api/v1/auth/` and `/api/admin/v1/auth/`, 20 on `/api/setup/`,
30 on `/setup`), `rr_admin` 30 r/m (burst 60 on `/api/admin/`, 100 on
`/admin`), `rr_webhooks` 30 r/s; `limit_conn` 50. These are exactly the
section 21.3 template. API throttler (section 9.1): 60/min per IP without a
session, 300/min per user with one, 10/min per IP on `POST /api/v1/auth/*`,
600/min per webhook provider. The 429s the owner hit: every console page loads
`GET /api/admin/v1/auth/me`, which the template puts in `rr_auth` (5 r/m) —
section 9.1 limits only `POST` login, so the template and 9.1 disagree; and
`rr_admin` 30 r/m is below what one console page makes (several calls per
screen). The Caddy profile renders the same zones with `caddy-ratelimit`
(sliding windows sized `rate × window + burst`: auth 15/1 m, admin 90/1 m, api
130/10 s, general 250/10 s, webhooks 360/10 s, `proxy-render.ts`).

## Code review repair queue — 2026-09-24

Current milestone remains M5 (NOT VERIFIED); the sole milestone task remains
TASK-M5-004. A read-only review of the `dev` tree on 2026-09-24 found defects
in already committed M1/M2 work that outweigh the remaining M5-004 gates. They
are repaired one per commit, in this order, as follow-ups to the completed
tasks; no new TASK or milestone is started.

1. **Done — mock payment provider in production** (section 22.4). The API
   registered `mock` unconditionally, `providerConfig` skipped the enabled
   check for it and its webhook secret defaults to the public `mock-secret`,
   so any signed-in customer could create an invoice with `provider:"mock"`
   and post a signed `paid` webhook with any amount. The registry is now built
   by `createPaymentProviderRegistry()`, which registers `mock` only for
   `RR_PAYMENTS_MOCK=true`; `init-env.sh` and `.env.example` write `false`,
   the E2E stand sets `true` explicitly, and the proxy-smoke stand already did.
   Regression: `payments.registry.test.ts` (absent for unset/`false`/`1`,
   present only for `true`). **VPS action:** its `.env` was created by the
   old `init-env.sh` and carries `RR_PAYMENTS_MOCK=true`; set it to `false`
   before deploying the new image.
   Verified locally: API 162 tests, `pnpm -r test`, `pnpm test` (43),
   `pnpm lint`, `pnpm typecheck`, `pnpm typecheck:e2e`, `pnpm format`,
   `pnpm build`, `pnpm i18n-check`, `pnpm test:m2` (1/1), `pnpm test:m4`
   (4/4), and `pnpm test:e2e` with the documented `LD_LIBRARY_PATH` browser
   libraries: 27 passed, 1 skipped, 1 failed (below). Proxy smoke was not
   rerun; its stand configuration is unchanged.
2. **Done — unauthenticated Telegram Stars webhook** (sections 9.7, 11.3.6).
   `StarsProvider.verifyWebhook` returned ok for any body, so anyone could
   POST a `successful_payment` to `/webhooks/stars` and mark a Stars invoice
   paid. `receiveWebhook` now refuses every provider whose
   `capabilities.webhooks` is false with `WEBHOOK_NOT_SUPPORTED` before the
   body is parsed or an event stored; Stars is set to `webhooks: false` and no
   longer parses HTTP bodies. Platega and balance already produced no event
   and behave the same. Regression: `payments.service.test.ts` (nothing stored,
   applied or queued for a forged Stars update; Platega/balance refused);
   the old test asserting HTTP parsing was replaced.
   Verified locally: API 164 tests, `pnpm -r test`, `pnpm test` (43), lint,
   typecheck, format, build, i18n, `pnpm test:m2` (1/1), `pnpm test:m4` (4/4),
   `pnpm test:e2e` 27 passed / 1 skipped / 1 failed (the pre-existing locale
   failure below).
   **Found while repairing:** the section 9.5 Stars path does not exist at
   all — no `stars/precheckout`, `stars/successful-payment` or
   `stars/create-link` endpoints, no bot handlers for `pre_checkout_query`,
   `successful_payment` or `/start inv_<id>`. TASK-M2-008's acceptance was
   therefore never met, and a Stars payment taken by Telegram cannot be
   applied. Pricing also diverges from 11.3.6 (`starAmount`/`amountMinor/100`
   instead of `price_overrides.XTR ?? ceil(price × starsPerRub)`, payload is
   the idempotency key instead of `inv_<invoiceId>`). Keep Stars disabled
   until item 2a lands.

   - **2a. Done — Telegram Stars payment path** (sections 9.5, 11.3.6, 11.4;
     completes TASK-M2-008's acceptance). Contract verified on 2026-09-25
     against Bot API 10.3 (`createInvoiceLink`, `sendInvoice`,
     `answerPreCheckoutQuery`, `PreCheckoutQuery`, `SuccessfulPayment`: title
     1–32, description 1–255, payload 1–128 bytes, empty `provider_token`,
     one price for XTR, ten-second pre-checkout deadline) and the installed
     grammY 1.46 signatures; Context7 had no grammY payments documentation.
     - API: `StarsService` and `POST /api/internal/v1/stars/{create-link,
precheckout,successful-payment}`. Precheckout approves only a pending,
       unexpired invoice of the payer in XTR at exactly `provider_amount`
       (409 `INVOICE_NOT_FOUND|INVOICE_NOT_PENDING|INVOICE_EXPIRED|
AMOUNT_MISMATCH`); the precheckout body adds `totalAmount`/`currency`
       to the section 9.5 shape because the amount check needs them.
       Successful payment stores the event under `telegram_payment_charge_id`
       and applies it inline; a redelivery re-applies (no-op once processed)
       and a failure propagates. No outbox job is added: the bot stream is
       the retry, which avoids two appliers racing on one event.
     - Provider: payload `inv_<invoices.id>` (the id is taken from
       PostgreSQL `uuidv7()` before the provider call), price
       `price_overrides.XTR` scaled by any discount, else
       `ceil(amount × starsPerRub / 100)`, min 1; exact `fx_rate`; config is
       `{starsPerRub}` and the token comes from `bot.token` (ADR-012) in
       payments, console healthcheck and the setup wizard; healthcheck calls
       `getMe`. Invoice TTL now reads `invoice.ttl_minutes` /
       `ttl_minutes_crypto` (60 for CryptoBot and Stars).
     - Bot: handlers for `pre_checkout_query` (localized refusal),
       `message:successful_payment` (throws on failure so the update stays
       pending) and `/start inv_<id>` (`sendInvoice` with a start parameter
       so a forwarded copy cannot be paid by someone else); registered before
       conversations and exempt from the per-user rate limit; the Pay button
       uses `starsInvoiceLink`; top-ups now show the invoice screen.
       `ApiClient` reads `{error:{code}}` envelopes (which also makes the
       existing `REVOKE_RATE_LIMITED` check reachable).
     - Site: the Stars button opens `t.me/<bot>?start=inv_<id>` (FR-134).
     - `telegram-mock` answered nothing for `sendInvoice` and never reached
       its `createInvoiceLink` branch (unbraced `return`); fixed and tested.
     - **Critical fix found on the way:** `PaymentsService.providerConfig`
       `JSON.parse`d `config_enc`, which the console and the setup wizard
       store as the `v1:…` string, so every provider configured there threw
       on invoice creation and webhooks. Now read as `{ enc }`; regression in
       `payments.service.test.ts` and the Stars integration test.
     - Independent diff review → `applyEvent` now locks the event row and
       re-checks `processed_at` inside the transaction, so concurrent
       deliveries of one event apply once without an error (reproduced first
       with three concurrent deliveries on an `underpaid` invoice).
     - Verified locally: API 189, bot 24, web 30, telegram-mock 5,
       `pnpm -r test`, `pnpm test` (43), lint, typecheck, typecheck:e2e,
       format, build, i18n (1496), OpenAPI regenerated (3 routes),
       `pnpm test:m2` 2/2 including the new `m2.stars.integration.test.mjs`
       (duplicate → one transaction, EX-02 → balance, amount/owner refusals,
       concurrent redelivery), `pnpm test:m4` 4/4, `pnpm test:e2e` 27 passed /
       1 skipped / 1 failed (the pre-existing locale failure). Not verified:
       a real Telegram Stars payment (TASK-M6 manual acceptance, 26.4 B9).
     - **Owner decisions, 2026-09-25 (the spec is silent; implemented):**
       (a) a second, distinct Stars charge for an invoice already `paid` or
       `underpaid` is credited to the balance as its own top-up (no
       `invoice_id`, which is unique) with the new `payment.duplicate` alert.
       Limited to Stars on purpose: other providers report one payment under
       several ids (webhook and poll), so for them a further `paid` event on a
       settled invoice stays an EX-03 duplicate — which previously even hit
       the unique constraint on `underpaid` invoices. (b) a `paid` event on a
       `canceled` invoice (all providers) is handled like EX-02: balance, no
       activation, new `payment.after_cancel` alert. Both alert types extend
       the section 16.5 list; locale keys exist in `ru` and `en`. Regressions
       in `m2.payment.integration.test.mjs` (canceled, EX-03 repeat) and
       `m2.stars.integration.test.mjs` (second charge, redelivered).
     - **Recorded debts:** the bot stream retries a permanently failing
       update every 60 s forever with no delivery limit or alert (ingress,
       all update kinds); a cold session can make the pre-checkout answer
       approach the ten-second deadline (upsert + API call); a
       `successful_payment` naming no known invoice is kept as
       `INVOICE_NOT_FOUND` without an alert.
   - **2b. Done 2026-09-25** — pre-existing E2E locale regression from
     `0c79ae7`. Root cause: next-intl 4 writes `rr_lang` only when the locale
     differs from `Accept-Language` (verified in the next-intl 4.0 notes via
     Context7), and `/auth/tg` skipped the header, going from the cookie
     straight to the default `ru`. The route now follows the section 13.1
     order `rr_lang` → `Accept-Language` (quality-ordered) → default, with
     regressions in `apps/web/test/auth-tg-route.test.ts`. Verified: lint,
     typecheck, typecheck:e2e, format, web 35, `pnpm test:e2e` 28 passed /
     1 skipped / 0 failed. The customer entry-flow repair of 2026-09-23 is
     now verified in the browser.

3. **Done 2026-09-25 — CryptoBot invoice amount divided by 100 twice**
   (section 11.3.5). `amount()` already returns roubles, so a 299 ₽ invoice
   was created as 2.99 ₽; it is now sent as the decimal string `"299.00"`.
   Contract: Crypto Pay `createInvoice.amount` is a String "in float" of the
   fiat currency (help.send.tg Crypto Pay API via Context7; matches the
   11.3.5 example `amount: "299"`). Regression in
   `builtin-providers.test.ts`. Verified: lint, typecheck, build, API 190,
   `pnpm test:m2` 2/2. No real CryptoBot invoice was created.
   - **3a. Recorded, not repaired — rest of the adapter vs 11.3.5:** the
     config has `token`/`baseUrl` instead of `apiToken`, `testnet`,
     `acceptedAssets`; `accepted_assets` and `paid_btn_name/url` are not sent;
     the link is read from `pay_url` while 11.3.5 names `bot_invoice_url`
     (the current Invoice field list is NOT VERIFIED: the official help page
     is script-rendered and Context7 has only the request side); `payload`
     carries the idempotency key, not the invoice id; `paid_amount`/
     `paid_asset` are not written to `providerAmount`/`fx_rate`;
     `healthcheck` answers ok without calling the API; the webhook `eventId`
     is `invoice_id` where 11.3.5 says `update_id` (which the vendor calls
     non-unique). Poll event ids are item 6.
4. **Done 2026-09-25 — `maintenance.subscriptions-expire` and recurring
   `panel.reconcile-all` were never queued** (section 7.3, FR-024, 10.5), so
   subscriptions never left `active` and the panel was reconciled only once,
   when the wizard finished. The worker now queues both at start and every
   minute from `cronJobs()` (`apps/worker/src/queues/schedule.ts`): expiry
   under `maintenance:subscriptions-expire:<yyyymmddHHMM>`, reconciliation
   under `reconcile:<yyyymmddHHMM>` of the quarter-hour slot start, with
   finished jobs kept 24 h (7 days if failed) so the id dedupes a slot across
   ticks, restarts and replicas (BullMQ ignores an existing id only while the
   job exists — docs.bullmq.io "Job Ids", via Context7). Regressions:
   `schedule.test.ts` and the new `test/m1.worker-cron.integration.test.mjs`
   (real Valkey, fake internal API: both endpoints called once, a restarted
   worker does not reconcile again in the slot; fails on the previous
   worker). Verified: lint, typecheck, `pnpm test` 43, `pnpm -r test`,
   `pnpm test:m1` 2/2.
   - **Found, not repaired:** FR-024 also names the `subscription.expired`
     event, which is one of the outgoing webhooks of section 9.8; outgoing
     webhooks (`settings.webhooks.outgoing[]`, signing, retries,
     `rr_outgoing_webhook_failures_total`) are not implemented at all. Added
     to item 9. The other interval jobs (`payments.poll-pending`,
     `payments.expire`, `notify.scan-expiring`) are keyed by millisecond
     stamps and kept for ever; their job options belong to item 5.
5. **Done 2026-09-25 — `panel.sync-user` dropped every later sync of a user,
   and no job was retried** (section 7.3). The shared `panel:<userId>` was the
   BullMQ job id, and the finished first sync, kept by `removeOnComplete`,
   made BullMQ ignore every renewal, ban and unban after it; admin ban/unban
   used their own `panel:ban:`/`panel:unban:` ids with the same flaw. All
   producers now write `jobId = sync:<userId>`, and the relay's
   `jobOptions()` (`packages/queues`) publishes such a job under its outbox
   row id with BullMQ deduplication `{ id: sync-<userId>, keepLastIfActive }`
   — the "replace" of 7.3: a waiting sync covers a new request (it reads the
   state when it runs), and one requested while a sync runs runs once more
   after it (docs.bullmq.io Deduplication via Context7; the option is in the
   installed 6.3.7 typings). Retries per 7.3: `panel.sync-user` 10 ×
   exponential from 5 s (longest wait 1280 s, inside the 1 h cap),
   `payments.apply-event` 5 × exponential from 2 s, `notify.send` 3 × 10 s,
   `broadcast.chunk` 3; jobs the table gives one attempt, and the unlisted
   `notify.alert` (a retry would repeat the alert to administrators already
   reached), keep one. Regressions: `packages/queues` unit tests and
   `test/m1.integration.test.mjs` on real Valkey (renewal after a finished
   sync runs; two requests during an active sync give exactly one more run
   with the latest data; a failed attempt is retried) — it times out on the
   previous relay with only the first sync run. Verified: lint, typecheck,
   format, `pnpm -r test`, `pnpm test:m1` 2/2, `test:m2` 2/2, `test:m4` 4/4.
   - **Found, not repaired (added to item 9):** the worker routes every
     `panel` job other than `panel.sync-user` to reconciliation, so
     `panel.reset-traffic` and `panel.delete-user`, queued by the admin
     console, are never performed and have no internal endpoint; the `panel`
     worker runs at concurrency 1 where 7.3 says 2.
6. Poll-only payments are never applied (fixed `poll:<id>` event id consumed
   by the first pending poll); Lava `hookUrl` is wrong; Robokassa diverges
   from 11.3.4.
   - **6a. Done 2026-09-25 — status polling.** CryptoBot and Lava keyed the
     polled event `poll:<id>` whatever the status, so the first `pending`
     poll took the id and the later `paid` answer was stored as its
     duplicate and never applied; they now key `poll:<id>:<status>` like
     YooKassa and Platega. Found in the same path: `recheck` stored only
     `paidAmountMinorRub`, never the rouble `paidAmount` the providers
     report, so `applyEvent` took any polled payment as paid in full and
     EX-12 could not fire; webhook and poll now share `paidInRoubles()`.
     Regressions: `builtin-providers.test.ts` (pending and paid answers get
     different ids for every polling provider), `payments.service.test.ts`
     (a poll stores the rouble amount), and `m2.payment.integration.test.mjs`
     (CryptoBot pending → paid by poll gives one purchase; a short poll gives
     `underpaid`; the invoice stayed `pending` on the previous build).
     Verified: lint, typecheck, format, API 195, `test:m2` 2/2, `test:m4` 4/4.
     Robokassa's poll still answers `pending` without asking (6c).
   - **6b. Done 2026-09-25 — Lava `hookUrl` and the return URLs.** Lava was
     told `hookUrl = <returnUrl>/webhooks/lava`, i.e.
     `https://<domain>/pay/success/webhooks/lava`, which does not exist, so
     no Lava webhook ever arrived. Found with it: every provider sent the
     payer back to `/pay/success` or `/pay/fail`, which the site reads as an
     invoice named `success` (FR-134 has only `/pay/[invoiceId]`; 11.3.4
     says the return is `/pay/<id>`). `CreateInvoiceParams` now carries
     `webhookUrl = https://<domain>/webhooks/<provider>` (section 9.7), and
     `returnUrl`/`failUrl` are `/pay/<id>` of the pre-allocated invoice id.
     These are the shop's own URLs; the rest of the Lava contract (11.3.3
     `[verify]` fields, the `Authorization` vs `Signature` header, the
     `additionalKey`) is untouched and still NOT VERIFIED. Regressions in
     `builtin-providers.test.ts` and `payments.service.test.ts`. Verified:
     lint, typecheck, format, API 197, `test:m2` 2/2.
   - **6c. Done 2026-09-25 — Robokassa brought to 11.3.4.** Contract checked
     against docs.robokassa.ru via Context7 (pay-interface,
     notifications-and-redirects, fiscalization, xml-interfaces). Before:
     `InvId` was the idempotency key (not an integer), the ResultURL
     signature included `MerchantLogin` (so every real notification failed),
     no `Shp_inv`, the receipt was signed unencoded, `OK<InvId>` came from a
     field of the shared provider instance (two concurrent notifications
     could swap answers), the poll never asked, the health check never
     looked, and there was no test mode. Now: `InvId = numeric_id`,
     `Shp_inv = <invoice id>`, `MD5(MerchantLogin:OutSum:InvId[:Receipt]:
Password#1:Shp_inv=…)` with the URL-encoded receipt signed and sent,
     ResultURL `MD5(OutSum:InvId:Password#2:Shp_*)` (case-insensitive) at
     `/webhooks/robokassa/result` (section 9.7; `/webhooks/robokassa` still
     works), `ackResponse(event)` answers from the notification itself,
     `OpStateExt` polling (`State.Code 100` = paid; the `[verify]` of 11.3.4
     is confirmed; skipped in test mode, which OpStateExt does not serve),
     config per 11.3.4 (`isTest`, `testPassword1/2`, `sno`, `tax`), and a
     health check that the login and passwords are present.
     **Decision:** 11.2 calls the provider before the invoice row exists,
     while 11.3.4 wants `numeric_id` (declared `GENERATED ALWAYS`) in the
     link. The API now takes `numeric_id` from the column's own identity
     sequence together with the pre-allocated uuid, and migration
     `0006_invoice_numeric_id_by_default` switches the column to
     `GENERATED BY DEFAULT` so the value can be inserted; values still come
     from the one sequence. Regressions: `builtin-providers.test.ts`
     (8 Robokassa cases) and `m2.payment.integration.test.mjs` (real
     database: `InvId = numeric_id`, signed ResultURL pays once, both
     notifications answered `OK<InvId>`; fails on the previous code).
     Verified: lint, typecheck, format, OpenAPI regenerated, API 204,
     `pnpm test` 43, `test:m1` 2/2, `test:m2` 2/2, `test:m4` 4/4. No real
     Robokassa payment was made.
     **Not repaired:** 11.3.4 wants SuccessURL/FailURL to land on
     `/pay/<id>`, but Robokassa takes them from the store settings with
     `InvId`/`Shp_inv` appended, and there is no route that turns those into
     `/pay/<id>`; `settings.fiscal.mode` uses `none|receipt|manual` where
     FR-062/section 18 say `none|provider_receipt` (all of api, setup and
     web; added to item 9).
7. **Done (7a–7h)** — Refund/balance defects: refunds accepted for top-ups, balance plan change
   adds time twice, `settleBalance` ignores held rewards, `expire()` keeps
   promo reservations, global `Idempotency-Key`, unauthenticated events take
   the dedup key, a failing inline apply loses the event.
   - **7a. Done 2026-09-25 — refunds of non-purchases, and AC-066.**
     `refund()` took any transaction: a top-up never reached revenue, so
     "refunding" one paid the same money into the balance a second time out
     of revenue. FR-066/EX-05 and the 11.7 posting table make a refund
     `revenue → user` with `parent_id` = the purchase; anything but a
     `purchase` is now refused (`REFUND_NOT_PURCHASE`). Exceeding the
     remaining amount threw a plain `Error` (HTTP 500) where AC-066 wants
     409; the console now answers `CONFLICT` 409 with `details.reason`
     (`REFUND_EXCEEDS_REMAINING` / `REFUND_NOT_PURCHASE`; section 9.3 has no
     refund-specific code), and an unknown transaction 404. Regressions:
     `m2.payment.integration.test.mjs` (top-up refund refused with balances
     unchanged; AC-066 100 then 200 of 299 → second refused,
     `refunded_minor = 10000`) and `admin-payments.service.test.ts`.
     Verified: lint, format, API 206, `test:m2` 2/2, `test:m4` 4/4 on three
     runs (one earlier `test:m4` run reported one failure that its log did
     not keep and that did not recur; recorded as a possible flake).
   - **7b. Done 2026-09-25 — a plan change paid from the balance added the
     time twice.** The invoice price already subtracts the EX-06 credit for
     the unused time, and a provider-paid plan change starts the new plan
     now; `settleBalance` called `activateSubscription(..., false)` for every
     kind, so a balance-paid plan change also kept the old expiry and added
     the new period on top (30 days left + 60-day plan → 91 days). It now
     passes `kind === 'plan_change'`. Regression in
     `m2.payment.integration.test.mjs` (60 days, 91 on the previous code).
     Verified: lint, typecheck, format, API 206, `test:m2` 2/2, `test:m4` 4/4.
   - **7c. Done 2026-09-25 — paying from the balance spent held rewards.**
     Section 15.2 makes the available balance `balance_minor − SUM(held
rewards)`; `LedgerRepository.available` honoured it, `settleBalance`
     compared the raw balance, so a referrer could spend a reward that a
     refund of its source would reverse later. The held sum is now read
     after the account rows are locked and subtracted. The refusal also was a
     plain `Error`, which `MeService` does not map (HTTP 500); it is now
     `PaymentError('INSUFFICIENT_FUNDS')`, answered 409. Regression in
     `m4.rewards.integration.test.mjs` (a 50.00 plan against 59.80 all held →
     refused, nothing moves; bought on the previous code). Verified: lint,
     typecheck, format, API 206, `test:m2` 2/2, `test:m4` 4/4.
     **Not repaired (item 9):** the account pages and `canPayFromBalance`
     still show the whole balance rather than the available part with the
     held amount "в обработке" (section 15.2).
   - **7d. Done 2026-09-25 — an expired invoice kept its promocode
     reservation.** `expire()` only changed the status, so a `max_uses`
     slot reserved by an abandoned invoice stayed reserved and every later
     buyer got `PROMO_EXHAUSTED` (section 11.4 releases it on expiry). Expiry
     is now one transaction: `UPDATE … RETURNING` the expired invoices and
     `onInvoiceReleased` for each. Regression in
     `m4.rewards.integration.test.mjs` (reserve → expire → released → another
     buyer takes the slot; stayed `reserved` on the previous code). Verified:
     lint, typecheck, format, API 206, `test:m2` 2/2, `test:m4` 4/4.
   - **7e. Done 2026-09-25 — `Idempotency-Key` was global.** Section 9.2
     scopes the key to the user (`rr:idem:<userId>:<key>`) and 9.3 answers a
     key reused with another body `IDEMPOTENCY_KEY_REUSED` 422, but
     `createInvoice` returned whatever invoice carried the key: another
     user's (with its payment link), or the first invoice for a different
     plan, provider or top-up amount. A replay is now returned only for the
     same user and the same request (`PaymentsService.replay`, also applied
     when a concurrent insert wins the unique key) and refused 422
     otherwise; `MeService` checks the replay before reserving a promocode,
     so replaying a promo purchase no longer takes a second slot.
     Regressions: `payments.service.test.ts` (6 cases) and
     `m4.rewards.integration.test.mjs` (replay → same invoice, one
     redemption; another user → 422; fails on the previous code). Verified:
     lint, typecheck, format, API 212, bot 24, web 35, `test:m2` 2/2,
     `test:m4` 4/4. **Still missing:** the Valkey response store with
     `Idempotent-Replay: true` for the money-creating POSTs of 9.2 (the
     trial among them); added to item 9.
   - **7f. Done 2026-09-25 — an unverified webhook took the event's
     deduplication key.** The 9.7 pseudo-code inserts the event under
     `external_id` before acting on `signature_ok`, and `external_id` is
     whatever the body claims; a forged body naming the id of the genuine
     notification made that notification a duplicate that was never
     applied. **Decision:** a failed verification is still stored for audit
     (AC-063c, `signature_ok=false`) but under
     `unverified:<sha256(body)>`, so it can neither block nor be mistaken for
     the real event (11.6: duplicate provider events are side-effect free,
     and only authenticated ones are events). Regression in
     `m2.payment.integration.test.mjs` (forged pending under `real-event`,
     then the signed paid event → invoice paid; stayed `pending` before).
     Verified: lint, typecheck, format, API 212, `test:m2` 2/2, `test:m4` 4/4.
   - **7g. Done 2026-09-25 — a failing inline apply lost the event.**
     `receiveWebhook` applied a new event inline and only then queued
     `payments.apply-event`; a failure answered 500 without a queued job, and
     the provider's redelivery was a duplicate that nothing applied. `recheck`
     likewise applied only new poll events. The job is now queued first and a
     failed inline apply is logged and left to it (5 attempts, item 5); a
     redelivered event still unprocessed is applied, and its failure goes
     back to the provider for another delivery; `recheck` always applies
     (`applyEvent` ignores processed events). Regressions in
     `payments.service.test.ts`. Verified: lint, typecheck, format, API 214,
     `test:m2` 2/2, `test:m4` 4/4.
   - **7h. Done 2026-09-25 — cancel could overwrite a paid invoice.**
     `MeService.cancelInvoice` read `pending` and then updated without a
     condition, so a payment applied in between left a paid invoice (with
     its transaction and subscription) marked `canceled`. The cancel is now
     one transaction: `UPDATE … WHERE status = 'pending'` (PostgreSQL
     re-checks the condition after the row lock `applyEvent` holds), the
     promocode release only when it changed a row, and 409
     `INVOICE_NOT_PENDING` otherwise. A payment that arrives after a
     successful cancel still goes to the balance (owner decision of
     2026-09-25). Regression in `me.service.test.ts`. Verified: lint,
     typecheck, typecheck:e2e, format, API 215, `test:m2` 2/2, `test:m4` 4/4,
     `pnpm test:e2e` 28 passed / 1 skipped.
   - **Item 7 closed** (7a–7h, 2026-09-25).
8. **Done (8a–8c)** — `/api/internal/*` is proxied from the internet (both profiles), SVG upload
   filter is bypassable, webhooks share the 60/min anonymous bucket.
   - **8a. Done 2026-09-25 — `/api/internal/*` reached the API from the
     internet.** Both profiles routed it with the rest of `/api/*`, and the
     external `edge` too, so every bot/worker endpoint (including
     `auth/issue-token`, which mints a session for any `telegramId`) was
     guarded by `X-Internal-Token` alone. The proxies now answer it
     themselves with 404 (`INTERNAL_API_BLOCK`, a Caddy `handle`, and
     `edge.conf`); only the 22.7 smoke stand routes it
     (`RR_ECHO_HEADERS=true`, now also on `proxy-config` in
     `compose.smoke.yaml`) for step 5 and the browser suite. Found with it:
     the Caddy profile's `/api/docs` denial was a bare `respond`, which Caddy
     orders after `handle`, so `handle /api/*` forwarded it (no harm today:
     the API serves no `/api/docs`); it is a `handle` now (Caddy directive
     order checked via Context7, caddyserver.com). Regressions:
     `proxy-render.test.ts` and a new `m5.proxy.integration.test.mjs` case
     that runs both real proxies against a stub upstream (404 without
     forwarding; forwarded in stand mode; `/api/docs` not forwarded) and
     fails on the previous templates. Verified: lint, typecheck, format,
     API 220, `pnpm test` 43, `pnpm test:m5` 5/5. The full proxy smoke
     (`deploy/ci/proxy-smoke.sh`) was not rerun.
   - **8b. Done 2026-09-25 — the SVG filter was bypassable.** Theme SVGs are
     served by `web` from the shop's origin with no CSP (the page policy's
     matcher skips `/themes`), so script in an SVG opened directly ran next
     to the console. The upload filter `/<script\b|\son[a-z]+\s*=/` missed
     `<svg/onload=…>`, `<s:script>`, `javascript:` links (plain,
     entity-encoded or split by whitespace), animated `href`s,
     `foreignObject`, HTML `data:` URLs and non-UTF-8 files, and SVGs inside
     an uploaded theme archive were not checked at all. Now: the asset route
     answers `Content-Security-Policy: default-src 'none'; img-src data:;
style-src 'unsafe-inline'; sandbox` and `nosniff`, which makes any theme
     SVG inert whatever it contains; `assertInertSvg` (UTF-8 only, character
     references decoded, whitespace dropped) closes those bypasses and runs
     on every SVG of an archive too. Regressions: `theme.service.test.ts`
     (10 cases; the shipped `manta` theme still uploads) and
     `apps/web/test/theme-asset-route.test.ts`. Verified: lint, typecheck,
     format, API 230, web 37, `pnpm test:e2e` 28 passed / 1 skipped.
   - **8c. Done 2026-09-25 — webhooks shared the anonymous bucket.** Section
     9.1 limits webhooks to 600 a minute per provider; the throttler counted
     them as anonymous requests, 60 a minute per IP in the visitors' bucket,
     so a burst of notifications from a provider's few addresses was refused
     with 429 and spent the visitors' allowance. `/webhooks/<provider>…` and
     `/tg/webhook/…` (provider `telegram`) now have their own bucket
     `webhook:<provider>` of 600 a minute. **Trade-off kept from the
     specification:** a bucket per provider can be spent by forged requests
     to that path; the proxy still limits each IP to 30r/s, and polling
     backs up every provider but Stars and Robokassa test mode. Regressions
     in `auth.throttler.test.ts`. Verified: lint, typecheck, format, API 235,
     `test:m2` 2/2.
   - **Item 8 closed** (8a–8c, 2026-09-25).

9. Remaining debts, repaired in the order below.
   - **9a. Done 2026-09-25 — outgoing webhooks of section 9.8 were not
     implemented** (found under item 4). Each of the six events is written
     as a `webhooks.dispatch` outbox row in the transaction that causes it
     (`emitWebhook`, `apps/api/src/modules/webhooks/outgoing.ts`):
     `user.created` (user upsert), `subscription.activated` (purchase, balance
     purchase, trial, `subscriptions.activate`, plan change, invitee bonus,
     console and bot extensions), `subscription.expired` (expiry, now a
     conditional update so a renewal applied meanwhile is neither expired
     nor reported), `payment.succeeded` (every provider or balance payment
     for an invoice, top-ups and EX-02 credits included, and the second Stars
     charge), `payment.refunded`, `referral.rewarded`. The recipients sit in
     the encrypted `webhooks.outgoing`, so `webhooks.dispatch` reads them when
     it runs and writes one `webhooks.deliver` per enabled, subscribed
     recipient (job id `webhook:<eventId>:<sha256(url)[0:16]>`); a delivery
     re-reads the recipient, signs the unchanged body, POSTs with a 10 s
     timeout and no redirects, and answers 502 on anything but 2xx.
     **Decision:** section 7.3 lists no queue for 9.8; they run on a new
     `webhooks` queue (worker concurrency 5) so a slow recipient cannot hold
     up the customers' `notify` jobs. Retries: `attempts: 6` with a custom
     backoff `outgoing-webhook` of 1 min, 5 min, 30 min, 2 h, 12 h (BullMQ
     6.3.7 passes the attempts made, the failed one included —
     `Backoffs.calculate(…, this.attemptsMade + 1, …)` in `job.js`; custom
     strategies per docs.bullmq.io "Retrying failing jobs", via Context7).
     `X-RemnaRay-Delivery` is the event ULID. Settings: at most five
     recipients, events limited to the six; the console's settings page
     edits the group as JSON. New metric `rr_outgoing_webhook_failures_total`.
     Regressions: `webhooks.service.test.ts` (real local recipient: signature
     and headers, 500/404/302/refused fail and count, removed/disabled/
     unsubscribed skip, fan-out), `packages/queues` (queue, options, delays),
     the admin settings render test, and `test/m4.webhooks.integration.test.mjs`
     (real PostgreSQL and Valkey: five events from real flows, the worker
     fans out, the first attempt fails, the retry waits 60 000 ms, the second
     attempt is delivered with the same signed body); `m1.integration`
     asserts the four subscription events. Verified: lint, typecheck,
     format, `pnpm -r test` (API 246, web 38), `pnpm test` 43, `test:m1`
     2/2, `test:m2` 2/2, `test:m4` 5/5. **Not verified:** a delivery to a
     real external receiver; E2E not rerun (no customer path changed).
     **Found, not repaired:** the settings page is not the section 14 tab
     set ("Вебхуки" among them); the recipients are edited as one JSON value.
     A failed `m1.integration` leaves a Valkey client reconnecting for ever,
     so the run hangs instead of ending (repaired under 9d).

   - **9b. Done 2026-09-25 — `panel.reset-traffic` and `panel.delete-user`
     were never performed** (found under item 5). The console queued them
     (FR-141 "reset traffic"; section 19.5 anonymization), but the worker's
     `panelCall` sent every panel job other than `panel.sync-user` to
     `/remnawave/reconcile`: the panel's traffic was never reset (only the
     local copy was zeroed) and an anonymized user kept their panel user.
     Now `RemnawaveService.resetTraffic` calls
     `POST /api/users/{userId}/actions/reset-traffic` and stores the answer,
     and `deleteUser` calls `DELETE /api/users/{userId}`, takes a 404 as
     deleted and drops the `panel_users` row (a user never provisioned has
     nothing to reset or delete). Both routes and the numeric id are the
     ADR-010 findings for panel v3.4.4. Internal routes
     `/api/internal/v1/remnawave/{reset-traffic,delete-user}`; the worker
     routes the four panel job names explicitly and fails an unknown one.
     Retries: those of `panel.sync-user` (EX-10; section 7.3 lists neither).
     Regressions: `remnawave.service.test.ts` (the module's first tests; a
     stub panel over HTTP: the path, 404 as deleted, a failing panel keeps
     the mapping for the retry), `panel-call.test.ts`, `packages/queues`.
     Verified: lint, typecheck, format, `pnpm -r test` (API 253, worker 13),
     `pnpm test` 43, `test:m1` 2/2. **Not verified:** against a live panel.
     **Found, not repaired:** the section 10 rules that reset traffic on a
     same-plan renewal (`panel.sync-user` with `reason='renew'` calls
     `resetTraffic` before `update`) and on a downgrade below the used traffic
     (FR-023) are not implemented; every paid sync is `reason: 'paid'`.

   - **9c. Done 2026-09-25 — no traffic reset on renewal or downgrade**
     (found under 9b). Section 10.4 resets the panel traffic when the same
     plan is renewed and FR-023 when a plan change sets a limit below the
     traffic used; neither happened. The specification carries this as
     `reason='renew'` on `panel.sync-user`, but syncs of one user are
     deduplicated in `keepLastIfActive` mode, which ignores a sync added
     while another waits and keeps only the latest data while one runs
     (docs.bullmq.io "Deduplication", via Context7), so the reason could be
     lost. **Decision:** `activateSubscription` (every paid activation,
     provider or balance) writes a `panel.reset-traffic` of its own in the
     payment transaction, ahead of the callers' sync: `{userId}` when the
     latest subscription, live or not (FR-022 renews in `grace` and
     `expired`), had the same plan; `{userId, ifUsedAboveBytes: <new limit>}`
     on a plan change to a limited plan, which the job resets only if the
     panel reports more used when it runs. A first purchase or another plan
     resets nothing. The console's set-plan is left to the panel sync
     coverage item: it queues no sync at all yet.
     Regressions: `test/m2.traffic-reset.integration.test.mjs` (real
     PostgreSQL; fails without the change) and the conditional cases in
     `remnawave.service.test.ts`. Verified: lint, typecheck, format,
     `pnpm -r test` (API 255), `pnpm test` 43, `test:m2` 3/3, `test:m4` 5/5.
     **Not verified:** against a live panel, including whether its reset of
     a `LIMITED` user makes it `ACTIVE` again.

   - **9d. Done 2026-09-25 — a trial never reached the panel.** Found while
     auditing panel sync coverage: `subscriptions.trial` created the
     subscription `active` and queued no `panel.sync-user`, and
     reconciliation only visits users that already have a `panel_users` row,
     so a trial user got no panel user and no link (only the console's ban
     and unban ever queued a sync). FR-010 and EX-01: the trial is now
     created `provisioning` with `panel.sync-user {reason:'trial'}` in the
     same transaction; the sync that reaches the panel makes it `active`
     (conditional on `provisioning`, so two syncs activate once) and, in that
     transaction, emits `subscription.activated` (moved from the trial's
     creation, as the 10.3 pseudo-code has it) and queues the customer's
     `sub.activated` with the link. `provisioning → provisioning_failed` was
     implemented nowhere, although the dashboard counts it. **Decision on
     EX-01 against 10.3:** a sync's ten retries end within about 85 minutes,
     but EX-01 fails a subscription only after 24 h, so every
     reconciliation (15 min) queues another sync for a subscription still
     `provisioning` and, after 24 h, sets `provisioning_failed` with the
     `provisioning.failed` alert (its text already existed). The bot shows
     "activating, the link follows" meanwhile (new `bot.screen.sub.provisioning`);
     the account page already rendered `provisioning`.
     Regressions: `test/m1.trial-provisioning.integration.test.mjs` (real
     PostgreSQL and the panel mock: provisioning and the queued sync, the
     panel user created with the trial's expiry, one activation with its event
     and message, a panel down leaves it provisioning and reconciliation
     re-queues it, `provisioning_failed` and the alert after 24 h; fails on
     the old code) and `apps/bot/src/screens/subscription.test.ts`.
     `m1.integration` now expects the trial provisioning and drains its sync
     before the item 5 replace checks, and closes Valkey and the relay in
     `finally`: a failing run now ends (checked with a forced failure,
     exit 1) instead of hanging. Verified: lint, typecheck, format,
     i18n-check, `pnpm -r test` (API 255, bot 26), `pnpm test` 43, `test:m1`
     3/3, `test:m2` 3/3, `test:m4` 5/5. **Not verified:** a live panel; E2E
     not rerun (no browser flow takes a trial).

   - **9e. Done 2026-09-25 — console, bot and bonus changes never reached
     the panel.** Section 10.6 makes the store the source of truth for
     expiry, limits and enabled state, but the console's extension, set-plan
     and bulk extension, the bot's `/admin_extend` and the invitee's bonus
     days queued no `panel.sync-user`; reconciliation catches expiry and
     limit drift at the next quarter hour at best, and a set-plan never got
     the FR-023 reset. A ban queued a sync, but `syncUser` does nothing
     without a live subscription, so the panel user stayed enabled (FR-141
     requires `disable`); and ban/unban wrote the user, the subscriptions
     and the sync in three statements. Now each of those writes
     `panel.sync-user` in its own transaction (`queuePanelSync`,
     `apps/api/src/modules/remnawave/panel-jobs.ts`); set-plan queues the
     conditional FR-023 reset ahead of it; ban and unban are one
     transaction each; and a sync for a banned user, or one whose latest
     subscription is revoked, disables the panel user. **Found while
     testing:** the SDK sent `content-type: application/json` on the
     body-less action routes (reset-traffic, enable, disable); the Fastify
     panel mock refuses that with 400, which no test had exercised. It is
     sent only with a body now. Whether the live panel refuses it too was
     not checked; either way the header was wrong.
     Regressions: `test/m4.panel-sync.integration.test.mjs` (real PostgreSQL
     and the panel mock: extension, set-plan with the reset of 2 GB used
     against 1 GB, ban → `DISABLED`, unban, bulk extension → `ACTIVE`, each
     synced into the mock; the invitee bonus creating and then extending a
     subscription; fails on the old code), the bot controller test and the
     SDK header test (fails on the old SDK). Verified: lint, typecheck,
     format, `pnpm -r test` (API 255, SDK 8), `pnpm test` 43, `test:m1` 3/3,
     `test:m2` 3/3, `test:m4` 6/6, `pnpm test:e2e` 28 passed / 1 skipped.
     **Not verified:** a live panel.

   - **9f. Done 2026-09-25 — the panel tag was always `TRIAL`.** Section
     10.3 tags the panel user with `sub.plan?.slug ?? 'trial'`; the service
     sent `TRIAL` on create and nothing on update, so a paid user kept the
     trial tag. The panel accepts `/^[A-Z0-9_]+$/`, at most 16, nullable
     (remnawave/backend `libs/contract/commands/users/create-user.command.ts`
     and `update-user.command.ts`, read 2026-09-25), and a slug is
     `[a-z0-9][a-z0-9_-]{0,63}`, so the literal slug would be refused with 400. `panelTag` upper-cases it, maps `-` to `_` and cuts to 16; both
     create and update send it. The panel mock now refuses a tag the panel
     refuses. Regressions: `panelTag` cases in `remnawave.service.test.ts`,
     the mock's tag test, and `m4.panel-sync` (trial `TRIAL`, `m4-small`
     `M4_SMALL`; fails on the old code). Verified: lint, typecheck, format,
     `pnpm -r test` (API 257), `pnpm test` 43, `test:m1` 3/3, `test:m2` 3/3,
     `test:m4` 6/6, `pnpm test:e2e` 28 passed / 1 skipped. **Not verified:**
     a live panel.

   - **9g. Done 2026-09-25 — a resumed broadcast sent nothing.** `resume`
     called `start`, which kept `started_at` on a paused broadcast, so the
     new chunks were `broadcast:<id>:<index>:<startedAt>` — the ids of the
     first run's chunks, which BullMQ keeps after they complete and while it
     does ignores a job added under them. AC-161's pause/resume passed only
     because `m4.broadcast` read the outbox, not the queue. Also: a chunk
     stopped by a pause returned before adding what it had sent to the
     counters; `start`/`resume` accepted any status, so a canceled
     broadcast could be restarted and message its remaining recipients; and
     pause/cancel changed any status. Now every run names its chunks
     `broadcast:<id>:<run>:<index>` with a fresh run stamp, written in one
     transaction with the conditional status change; `start` is for `draft`
     and `scheduled`, `resume` (its own method) for `paused`, `pause` for
     `running`, `cancel` for anything unfinished, each 409 otherwise; a
     stopped chunk counts what it sent; the console disables start and
     cancel for `done`, `canceled` and `failed`. Regressions in
     `m4.broadcast.integration.test.mjs` (the resume's job id differs from the
     first run's — fails on the old code; the 409s; 52 recipients paused at
     the tenth message stop at the 50-message check with `sent_count` 50).
     Verified: lint, typecheck, format, `pnpm -r test` (API 257, web 38),
     `pnpm test` 43, `test:m4` 6/6, `pnpm test:e2e` 28 passed / 1 skipped.
     **Found, not repaired:** section 16.x answers a Telegram 429 with
     `sleep(retry_after)`; `sendChunk` waits one second and marks the
     recipient `failed`.

   - **9h. Done 2026-09-25 — a Telegram 429 failed the recipient.**
     Section 16.x answers a 429 with `sleep(retry_after)`; `sendChunk` slept
     one second and marked the recipient `failed`. It now waits the Bot API's
     `parameters.retry_after` seconds (`ResponseParameters.retry_after`,
     core.telegram.org/bots/api via Context7; 1 s when absent) and sends the
     same message again. **Decision:** at most five waits per recipient, then
     `failed`, so a chat that keeps answering 429 cannot hold its chunk for
     ever (the specification sets no bound). Regression in
     `m4.broadcast.integration.test.mjs`: one 429 with `retry_after: 1` then
     delivered once after ≥ 1 s; an always-429 chat tried six times and
     `failed` (fails on the old code). Verified: lint, typecheck, format,
     `pnpm -r test` (API 257), `pnpm test` 43, `test:m4` 6/6.
   - **9i. Done 2026-09-25 — worker concurrency differed from section 7.3,
     and panel writes had no per-user lock.** The workers ran `payments` 1,
     `notify` 1 (no recorded reason) and `panel` 1 where 7.3 says 4, 5 and 2. Two panel jobs at once need the section 10.3 lock
     `rr:lock:panel:<userId>` (PX 30 s), which did not exist. Now every
     panel write — `syncUser`, `resetTraffic`, `deleteUser` — takes it with
     a token and releases it only if still the holder (Lua compare-and-del);
     a write that finds it held throws `PANEL_BUSY` and its job is retried on
     its backoff, and reconciliation skips such a user. `CONCURRENCY` in the
     worker is the 7.3 table (`webhooks` 5, not in the table). Payments stay
     safe under 4 (invoice and event rows are locked), notifications under 5
     (`notification_log` is unique). Regressions: two concurrent syncs of
     one user in `m1.trial-provisioning` on a real Valkey (one `PANEL_BUSY`,
     lock released; both went through before), lock cases in
     `remnawave.service.test.ts`, and the table in `panel-call.test.ts`.
     `m4.panel-sync` runs on a real Valkey too. Verified: lint, typecheck,
     format, `pnpm -r test` (API 259, worker 14), `pnpm test` 43, `test:m1`
     3/3, `test:m2` 3/3, `test:m4` 6/6, `pnpm test:e2e` 28 passed / 1 skipped.

   - **9j. Done 2026-09-25 — `settings.fiscal.mode` used its own
     vocabulary.** FR-062 and section 18 define `none | provider_receipt`;
     the settings, the wizard's schema and client, and the payment service
     used `none | receipt | manual`. Now `provider_receipt` throughout.
     Migration `0007_fiscal_mode_provider_receipt` maps stored values —
     `receipt` → `provider_receipt`, `manual` → `none` (the specification
     has no manual mode, and "no receipt through the provider" is `none`) —
     in `settings` and in the wizard's saved payments step; without it the
     new schema would refuse `receipt` and the settings would fall back to
     `none`, switching receipts off silently. Regressions:
     `test/m1.fiscal-mode-migration.integration.test.mjs` (real PostgreSQL:
     the old value refused, mapped in both places, accepted, rerun
     harmless) and two receipt cases in `payments.service.test.ts` (Robokassa
     link carries `Receipt` only for `provider_receipt`; fails on the old
     comparison). Verified: lint, typecheck, typecheck:e2e, format,
     `pnpm -r test` (API 261; recorded as 259 in its commit), `pnpm test` 43,
     `test:m1` 4/4, `test:m2` 3/3, `pnpm test:e2e` 28 passed / 1 skipped.
     **VPS action:** none; the migration runs with the image.

   - **9k. Done 2026-09-25 — Robokassa returned payers nowhere useful.**
     11.3.4 sends the payer back to `/pay/<id>`, but Robokassa uses the
     SuccessURL and FailURL of the store's technical settings, the same for
     every payment, and appends `OutSum`, `InvId`, `SignatureValue`,
     `Culture` and `Shp_*` by GET or POST (docs.robokassa.ru "notifications
     and redirects", read 2026-09-25). **Decision:** the per-payment
     `SuccessUrl2`/`FailUrl2` would change the signed string to
     `MerchantLogin:OutSum:InvId:Receipt:StepByStep:ResultUrl2:SuccessUrl2:…`,
     whose handling of the empty parts the page does not settle and no real
     payment can check here; instead both settings are
     `https://<domain>/pay/robokassa`, a web route that answers 303 to
     `/<Culture or default>/pay/<Shp_inv>`, only for a UUID (anything else goes
     to `/<locale>/account`). It is a redirect, not a source of payment, so it
     checks no signature; the page reads the status from the API. The locale
     middleware skips the path. Regressions:
     `apps/web/test/robokassa-return-route.test.ts` (GET, POST, locale,
     refused values, the matcher — fails without its exclusion) and an E2E
     case through the stand's proxy. Verified: lint, typecheck,
     typecheck:e2e, format, `pnpm -r test` (web 43), `pnpm test` 43,
     `pnpm test:e2e` 29 passed / 1 skipped.
     **VPS action:** in Robokassa's technical settings set SuccessURL and
     FailURL to `https://<domain>/pay/robokassa`.

   - **9l. Done 2026-09-25 — the customer saw held rewards as spendable.**
     Section 15.2 shows held referral rewards "в обработке" and makes the
     available balance `balance_minor − SUM(held rewards)`; since 7c a
     balance payment honours it, but `/me`, the payment methods and the
     plan-change quote showed and compared the whole balance, so a balance
     payment was offered and then refused with `INSUFFICIENT_FUNDS`. Now
     `UserMe.balance` and the balance payment method are the available
     amount, the new `UserMe.balanceHeld` carries the held sum (OpenAPI
     regenerated), `canPayFromBalance` compares the available amount, and
     the account's balance page and the bot's balance screen add a pending
     line when something is held. Regressions: `m4.rewards` (real
     PostgreSQL: all 59.80 held → balance 0, held 59.80, balance method 0;
     fails on the old code), `me.service.test.ts`, the balance page test and
     `apps/bot/src/screens/balance.test.ts`. Verified: lint, typecheck,
     typecheck:e2e, format, i18n-check, `pnpm -r test` (API 262, web 45, bot
     28), `pnpm test` 43, `test:m4` 6/6, `pnpm test:e2e` 29 passed /
     1 skipped.

   - **9m. Done 2026-09-25 — no `Idempotent-Replay` response store.**
     Section 9.1 keeps the response of a money-, invoice- or
     subscription-creating POST in Valkey 24 h under `rr:idem:<userId>:<key>`
     and answers a repeat with it and `Idempotent-Replay: true`; 9.4 makes
     the key required on `POST /me/invoices`, which instead generated a
     random one when it was missing (a retry without it is a second
     invoice). `IdempotencyInterceptor` (`apps/api/src/common`) now does
     this for `POST /me/invoices` (required), `/me/trial` and
     `/me/promocodes/redeem`, on the web and the bot's internal routes: the
     key must be a UUID (400 `VALIDATION_ERROR`), a pending claim is taken
     with `SET NX EX`, the same request replays the kept body, another
     request with the key is 422 `IDEMPOTENCY_KEY_REUSED`, a second one while
     the first runs is 409 `CONFLICT`. **Decision:** only a successful
     response is kept; a failed one releases the key so a retry after a
     panel or provider error is performed, and the services keep their own
     guards (`invoices.idempotency_key`, `trial_used_at`). Regressions:
     `idempotency.interceptor.test.ts` (9 cases) and an E2E case against the
     stand's API and Valkey (same id with the header, 422, 400). Verified:
     lint, typecheck, typecheck:e2e, format, `pnpm -r test` (API 269),
     `pnpm test` 43, `test:m4` 6/6, `pnpm test:e2e` 30 passed / 1 skipped.
     **Found, not repaired then:** section 9.1 covers every money-creating
     POST, the console's among them (balance, refund, extensions); those
     return `Audited` values the audit interceptor unwraps and the console
     sends no key, so they were not covered. Repaired as 9ag.

   - **9n. Done 2026-09-25 — the weekly rebuild scanned with a Trivy
     action tag that does not exist.** `rebuild.yml` used
     `aquasecurity/trivy-action@0.28.0`; the action's tags are `v`-prefixed
     (`gh api repos/aquasecurity/trivy-action/git/ref/tags/0.28.0` → 404,
     `v0.36.0` → `a9c7b0f`), so the rebuild failed at its scan and never
     published the refreshed images. The nightly was corrected to
     `v0.36.0` on 2026-09-23; the rebuild now uses it too. Regression in
     `test/tooling.test.mjs` (one Trivy tag across the workflows, the one
     that exists; fails on the old file). Verified: `pnpm test` 44. **Not
     verified:** a GitHub run of `rebuild.yml`. (Its commit calls the rebuild
     monthly; it is weekly, `0 4 * * 1`, section 24.6.)
   - **9o. Done 2026-09-25 — the worker never saw the backup status.**
     `maintenance.backup-check` reads `.last-status` from `RR_BACKUP_DIR`
     (`/backups`), which the `backup` service writes to `./backups`, but the
     worker mounted only the common `themes`, `locales` and `uploads`; every
     daily check found no file, reported the backup `missing` on
     `/admin/system` and raised the backup alert. The worker now mounts
     `./backups:/backups:ro`, repeating the common mounts because a merge key
     does not merge lists (resolved with `docker compose config`: worker
     themes, locales, uploads, backups read-only; api unchanged). The status
     file is written under the default umask (0644), readable by the image's
     `node` user. Regression in `test/tooling.test.mjs` (fails on the old
     compose file). Verified: `pnpm test` 45, lint. **VPS action:** none
     beyond pulling the new `compose.yaml`; **not verified** on the VPS.

   - **9p. Done 2026-09-25 — the restore failed with a custom database user
     and never restored the files.** `restore.sh` expanded `POSTGRES_USER`
     and `POSTGRES_DB` in the operator's shell, which never reads `.env`, so a
     non-default user restored as `remnaray` and failed; the
     `files-<stamp>.tar.gz` the backup takes of `themes/` and `uploads/`
     (section 20.5) was never restored. **Found while testing:** on an empty
     data volume (26.4 R3 removes it) the image initialises with a
     socket-only server that answers `pg_isready` and then restarts, so the
     restore raced it ("the database system is shutting down"). Now the
     readiness check and `pg_restore` run with the container's own
     `$POSTGRES_USER`/`$POSTGRES_DB`, readiness is asked over TCP, and a
     matching files archive is extracted by a one-off `backup` container
     into `./themes` and the `uploads` volume (`docker compose run -v
uploads:…` resolves to the project volume — checked on a scratch
     project). Regression: a second test in `m5.backup.integration.test.mjs`
     runs `restore.sh` itself on a compose project with user `shop_owner`,
     database `shopdb` and no data volume: a real backup, then a row, a theme
     and an upload changed, then the restore brings all three back; it fails
     on the old script. Verified: `test:m5` 6/6, `pnpm test` 45, lint,
     format. **Not verified:** on the VPS.

   - **9q TLS and backup checks after setup.** The worker queued
     `maintenance.tls-check` and `maintenance.backup-check` at start and then
     every 24 h, with no retry. Until the wizard finishes the API answers
     every internal call `503 SETUP_NOT_COMPLETED` (17.4), so on a fresh
     install both readings were refused and `/admin/system` had none for up
     to a day; a restarting API lost a day the same way. The worker now
     counts the day from the reading the API recorded and asks a refused one
     again every five minutes (`dailyCheckDue` in `schedule.ts`, checked on
     the minute tick). Regression: `daily-checks.test.ts` runs
     `WorkerService` with BullMQ and `fetch` stubbed and fake timers — a 503
     at start, again after five minutes, then nothing for a day; it fails on
     the old worker. Verified: worker lint, typecheck, 18 tests, build,
     `m1.worker-cron` integration. **Not verified:** on the VPS.

   - **9r proxy reload results refused by the API.** `proxy-reloader`
     posted each outcome once and never read the status. The wizard's domain
     step publishes `rr:proxy.reload` while the API answers every internal
     call `503 SETUP_NOT_COMPLETED` (17.4), so exactly the reload most likely
     to fail at install had its `audit_log` row and `proxy.config_invalid`
     alert dropped silently. `reload-report.ts` now keeps a refused or
     unreachable report (at most 50, the dropped count logged) and sends the
     waiting ones in order every 30 s and before each new one; a one-off
     `--reload` says on stderr when its result was not recorded.
     Regression: `reload-report.test.ts` (4) and `m5.proxy` — the stub API
     refuses the first report with 503, and after the next domain change
     both are recorded in order; it times out on the old reloader.
     Verified: API lint, typecheck, 273 tests, `test:m5` 6/6 (proxy 4,
     backup 2). **Not verified:** on the VPS.

   - **9s reload requested during a reload.** Confirmed first: the
     reloader returned on `if (running)`, so a `rr:proxy.reload` published
     while a reload ran was dropped. `render-proxy` writes the files and then
     publishes, and the running `nginx -t` may have read the previous ones,
     so the new configuration stayed unapplied until some later change. A
     request during a reload is now remembered and applied right after it;
     any number of them make one more. Regression:
     `m5.proxy-reloader.integration.test.mjs` runs the real reloader on
     Valkey against a stand-in Docker Engine on a unix socket that holds each
     exec: a second request during the first reload's `nginx -t` gets its own
     `nginx -t` and reload, and three during one reload get exactly one more.
     It times out on the old reloader; three green runs. Added to `test:m5`
     (now 7/7). Verified: API lint, typecheck, 273 tests, `pnpm test` 45.
     **Not verified:** on the VPS.

   - **9t floating tags moving backwards.** A manual `rebuild.yml` run for
     an older version re-pointed `X.Y` and `X` at it, and `release.yml` moved
     both for any final release — a security patch to the previous minor
     (24.5), say `1.1.6` after `1.2.3`, would have become what
     `RR_VERSION=1` pulls. `scripts/floating-tags.sh` now decides from the
     repository's `vX.Y.Z` tags (compared with `sort -V`): `X.Y` and `X`
     move only for the newest final release of their line, never for a
     candidate. `release.yml` feeds it to `metadata-action`'s `enable`;
     `rebuild.yml` runs it on the default branch (`fetch-depth: 0`, which
     `actions/checkout` documents as fetching all tags — Context7
     `/actions/checkout`) before it checks out the old release. Regression in
     `tooling.test.mjs`: the script on a scratch repository with
     `v1.1.5 v1.2.3 v1.2.10 v1.3.0-rc.1 v2.0.0`, and both workflows wired to
     it; the wiring test fails on the old workflows. Both workflows parse as
     YAML (checked with `yaml`, which caught a duplicated `with:` on the
     first try). Verified: `pnpm test` 47, lint, format. **Not verified:** a
     real run on GitHub; `actionlint` is not installed here.

   - **9u special characters in the PostgreSQL password.** Compose pasted
     `POSTGRES_PASSWORD` raw into `DATABASE_URL`, and `init-env.sh` wrote it
     unquoted: with `p@ss:w/rd#x$y"z%2F ?&=\ #end` the stack got
     `p@ss:w/rd#x"z%2F ?&=\` (compose expands `$y`, cuts at ` #`) inside a
     URL whose `@`, `/`, `#` break it. `@remnaray/db` now has
     `resolveDatabaseUrl()` — `DATABASE_URL` when set, else built from
     `POSTGRES_USER/PASSWORD/DB/HOST/PORT` with `encodeURIComponent` —
     used by `createPrismaClient()` and by `migrate` for the Prisma CLI;
     compose passes `DATABASE_URL: ${DATABASE_URL:-}`. `init-env.sh` writes
     the password single-quoted, refuses a `'`, keeps edge spaces
     (`IFS= read`), generates `openssl rand -hex 24` on an empty answer
     (19.1 says generated, 26.4 A1 says typed — both now
     hold), and no longer dies on `stty` without a terminal. Contracts:
     compose v5.5.1 reads single-quoted `.env` values literally for both
     `env_file` and interpolation and expands `$y`/cuts ` #` unquoted
     (checked on this host); `pg-connection-string` 2.14.0 decodes user
     and password with `decodeURIComponent` (its source); Prisma 7 requires
     percent-encoding (Context7 `/prisma/web`, connection URLs). Regression
     `test/m1.database-url.integration.test.mjs` (in `test:m1`, now 7/7):
     `init-env.sh` with that password → `docker compose config` of a
     deployment directory gives postgres and api the password unchanged and
     no assembled URL → PostgreSQL with that password accepts the Prisma
     client and `prisma migrate deploy`; plus the generated and refused
     cases. Red: with the old `compose.yaml` the URL assertion fails; the
     old pair mangles the password as above. Verified: `pnpm lint`,
     `pnpm typecheck`, `pnpm -r test` (API 273, web 45, bot 28, worker 18),
     `pnpm test` 47, `test:m5` 7/7. Found meanwhile (fixed as 9v): the pre-migrate
     `pg_dump` in `migrate.ts` runs without `PGPASSWORD`. **Not verified:**
     on the VPS; an existing `.env` with an unquoted password is read as
     before.

   - **9v pre-migrate dump without a password.** Found while fixing 9u:
     `migrate.ts` ran `pg_dump --host postgres …` with no `PGPASSWORD`. The
     `postgres` image asks network clients for one (`scram-sha-256`), so
     before any `reversible: no` migration the dump failed with
     `fe_sendauth: no password supplied`, `migrate` exited 1 and the stack
     did not start on that upgrade (section 20.4). `pg_dump` now gets
     `PGPASSWORD` from `POSTGRES_PASSWORD`, as `backup-entrypoint.sh` already
     did. Regression `test/m5.premigrate-backup.integration.test.mjs` (in
     `test:m5`, now 8/8): the real `migrate.js` against PostgreSQL 18 with
     every migration applied and one more `reversible: no` pending, with
     `pg_dump` on the PATH being the real one run in `postgres:18-alpine`
     with only the libpq variables `migrate` passes, reaching the server by
     its bridge address; it failed with exactly that error before and now
     writes `pre-migrate-<version>.dump`. Verified: `pnpm lint`,
     `pnpm typecheck`, API 273, `pnpm test` 47. **Not verified:** in the
     runtime image on the VPS.

   - **9w healthcheck start periods.** Section 20.3 gives the `api`
     healthcheck `start_period` 30 s and the 7.1 compose gives `web` 20 s;
     `compose.yaml` had neither, so failures while the API boots counted
     toward its six retries and a slow first start could mark it unhealthy,
     after which `up` refuses the bot, worker and web behind it. Added both;
     `docker compose config` resolves them. Regression in `tooling.test.mjs`
     (fails without them). Verified: `pnpm test` 48, lint.

   - **9x `maintenance.disk-check`.** Section 20.3 and FR-163 want `disk.low`
     when less than `admin.disk_alert_pct` (27.3, default 10)
     of the database volume is free; neither the job nor the setting
     existed. PostgreSQL reports its own size (`pg_database_size`) but not
     the filesystem's, so the worker mounts `pgdata:/pgdata:ro` and calls
     `statfs` — checked on this host as uid 1000 against a live
     `postgres:18-alpine` volume: the figures match `df -B1` (total
     `blocks×bsize`, free `bavail×bsize`) and the data directory stays
     `EACCES`. It posts `{available,totalBytes,freeBytes}` to
     `/api/internal/v1/system/disk-result`, which adds
     `pg_database_size`, keeps it at `rr:disk:status`, alerts below the
     setting (an unmounted volume is recorded, not alerted), and
     `/admin/system` shows "Free on the database volume". Cadence: start and
     hourly (20.3 names none; the retry-after-refusal of 9q applies,
     `checkDue` now takes the period). Tests: `disk-check.test.ts` (2),
     `disk-result.test.ts` (4), `schedule.test.ts` and `daily-checks.test.ts`
     (hourly), compose mount in `tooling.test.mjs`. Verified: `pnpm lint`,
     `pnpm typecheck`, i18n-check, build (OpenAPI unchanged), API 277,
     worker 22, web 45, `pnpm test` 48, `m1.worker-cron`, E2E 30 passed /
     1 skipped. **Not verified:** on the VPS.

   - **9y daily update check (24.6).** `/admin/system` was to say "version
     X.Y.Z is available" from a daily GitHub Releases check in the worker,
     off with `admin.check_updates`, with a "security" badge; nothing did,
     and the setting was unused. Also found: `RR_APP_VERSION` was never set
     and the runtime image has no `package.json`, so every deployment showed
     version `0.0.0`. Now: `app.Dockerfile` takes `ARG RR_APP_VERSION`
     (default `0.0.0-dev`) and `release.yml`/`rebuild.yml` pass the tag;
     `maintenance.update-check` (start and daily, retried after a refusal)
     first asks `/api/internal/v1/system/update-check` whether it may — off
     means GitHub is never contacted — then lists
     `repos/<RR_UPDATE_REPOSITORY or VAQYBIN/remnaray-astra>/releases`,
     keeps published final `vX.Y.Z` releases and posts them to
     `update-result`; the API picks the highest version (not GitHub's
     `latest`, which orders by `created_at` — a later patch to an older
     minor would win), compares it with the running one, and marks
     `security` when any release between them has a Security heading. That
     heading comes from `.github/release.yml`, which files `security`-
     labelled PRs (Renovate's vulnerability label) under its own category
     of the generated notes. `/admin/system` shows the update with a
     `danger` badge. Contracts (Context7 `/websites/github_en_rest`,
     `/github/docs`): list releases fields and `per_page` 100, `latest`
     ordering, 60 unauthenticated requests an hour per IP, `User-Agent`
     required (403 without), release-notes categories config. **Not
     verified:** the exact heading level GitHub gives a category (any level
     `Security` matches); a real call to GitHub; the image build with the
     argument. Tests: `update-check.test.ts` in worker (3) and API (6),
     `daily-checks.test.ts` (off → no GitHub call; on → list posted, daily),
     `tooling.test.mjs` (image argument, workflows, categories; fails on the
     old Dockerfile). Verified: lint, typecheck, i18n-check, build (OpenAPI
     unchanged), API 283, worker 26, web 45, bot 28, `pnpm test` 49,
     `m1.worker-cron`, E2E 30 passed / 1 skipped.

   - **9z cosign signatures.** Sections 22.x, 24.4 p. 3 and 26 want the
     images signed with `cosign`; the workflows only ran
     `actions/attest-build-provenance`, under a comment claiming `cosign
verify` would check it. `release.yml` and `rebuild.yml` now install
     `sigstore/cosign-installer@v4.1.2` (latest tag, checked through the
     GitHub API; v4 is what installs cosign 3) and run `cosign sign --yes
<image>@<digest>` keyless with the workflow's OIDC token, then `cosign
verify` against `github.com/<repo>/.github/workflows/<file>.yml@` and
     `token.actions.githubusercontent.com` (Context7 `/sigstore/docs`
     CI quickstart, `/sigstore/cosign` `sign` by digest). The provenance
     attestation stays, described as what it is. A rebuild signs after the
     Trivy gate, and since the signature covers one digest, each dated or
     floating tag it publishes must resolve to that digest or the job fails
     (`imagetools inspect --format '{{json .Manifest.Digest}}'`, checked on
     buildx 0.37.1). `docs/install.md` shows how to verify. Regression in
     `tooling.test.mjs` (fails on the old workflows); both workflows parse.
     **Not verified:** a real signing run on GitHub.

   - **9aa Grafana's default password.** The monitoring profile set
     `GF_SECURITY_ADMIN_PASSWORD: ${RR_GRAFANA_PASSWORD:-admin}`, so an owner
     who skipped the variable got `admin`/`admin`, reachable from every
     container on `rr_net` and through any proxy rule they add. A required
     `${…:?}` is not an option: checked on compose v5.5.1, it fails
     interpolation for every command even when the profile is off. Grafana's
     entrypoint is now wrapped (the image's is `/run.sh`, user 472): with the
     password empty or `admin` it prints what to set and exits 1; otherwise
     it `exec`s `/run.sh`. `init-env.sh` generates `RR_GRAFANA_PASSWORD`
     (`openssl rand -hex 16`). `docs/monitoring.md` says how to change it on
     an existing install (Grafana applies it only when it creates its
     database). Regression `test/m5.grafana.integration.test.mjs` (in
     `test:m5`) on the real `grafana/grafana:12.3.1`: refused without a
     password and with `admin`; with one, `admin:<it>` reaches `/api/user`
     and `admin:admin` does not. Red: on the old file Grafana started instead
     of refusing (the run had to be stopped by hand, so the test now bounds
     each call to 180 s). `m1.database-url` checks the generated password.
     Verified: `pnpm lint`, `pnpm test` 50, the two integration files.
     **Not verified:** on the VPS; an existing Grafana keeps its password.

   - **9ab nightly Trivy for `backup`.** `nightly.yml` scanned four images;
     `backup`, which every profile starts and which holds the database
     password, was never scanned. Added to the matrix (same Dockerfile and
     context as the release). Regression in `tooling.test.mjs` (fails
     without it). **Not verified:** a real nightly run.

   - **9ac `caddy-ratelimit` pinned; certbot and the Caddy base kept.**
     `xcaddy build --with github.com/mholt/caddy-ratelimit` named no version,
     so every build took the module's default branch of that day. The module
     has a single tag, `v0.1.0` (checked through the GitHub API); it is now
     pinned by `ARG CADDY_RATELIMIT_VERSION` to the head of 2026-09-25,
     commit `5625512f…` of 2026-06-12, which xcaddy passes to `go get`
     (Context7 `/caddyserver/xcaddy`). Built locally: `caddy build-info`
     reports `v0.1.1-0.20260612195517-5625512f24f6`, `rate_limit` is listed,
     and `m5.proxy` 4/4 runs the image. The commit's code was not reviewed.
     Kept as the specification has them, not changed: `certbot/certbot:latest`
     is what the 7.1 compose names, and the Caddy base `2.11.4` is the 2.x
     patch M0-003 verified for 6.1's `caddy:2-alpine` line (moving it is a
     Renovate/M0-003-style check, not this review). Regression in
     `tooling.test.mjs` (fails on the old Dockerfile).

   - **9ad a TLS-mode switch within one profile reaches the proxy.**
     Confirmed first: `docker compose config --hash` gives `proxy-config` a
     new hash for another `RR_TLS_MODE` and `proxy-nginx` the same one, and
     the renderer's first render publishes no reload. On a local stack
     (current `app`/`web`/`nginx` images) acme → custom with the old
     `./rr up` recreated `proxy-config`, kept `proxy-nginx` and never served
     HTTPS (`tlsv1 alert internal error`). `./rr up` now notes both
     containers before `up` and, when the renderer was recreated and the
     proxy kept, runs `render_proxy` (render, then `proxy-reloader --reload`)
     before the HTTPS check; `certbot` already did. Same stack with the fix:
     `manual: reloaded`, HTTPS ready with the `rr.test` certificate, proxy
     container unchanged; a second `./rr up` reloads nothing. Before the
     wizard the reload is not recorded in `audit_log` (503, printed). A plain
     `docker compose up` still needs `./rr proxy:reload` (`docs/tls.md`).
     Regression in `test/rr.test.mjs` (fails on the old script). shellcheck
     clean. **Not verified:** on the VPS.

   - **9ae `release.yml` starts only on `vX.Y.Z` and `vX.Y.Z-rc.N`.**
     Confirmed from the docker/metadata-action source (Context7): with
     `tags: ['v*']`, `v1.2` or `vfoo` is not semver, gets no image tag and the
     run fails; `v1.2.3-beta.1` or `v1.2.3-hotfix` was published under `rc`,
     which 24.4 p. 5 reserves for `-rc.N`; `v1.2.3+build` became a final
     GitHub Release, which `rebuild.yml` then takes as the latest and cannot
     turn into a Docker tag. The tag also reached a shell unchecked. The
     filter is now `v[0-9]+.[0-9]+.[0-9]+` and `...-rc.[0-9]+` (the syntax of
     GitHub's cheat sheet, whose own example is `v[12].[0-9]+.[0-9]+`), and
     "Read the tag" refuses anything but those forms without leading zeros,
     before any later step uses the version. Regression in
     `tooling.test.mjs` runs that step from the workflow on good and bad
     tags (fails on the old workflow); `docs.test.mjs` updated; actionlint
     1.7.12 clean. **Not verified:** a real tag push on GitHub.

   - **9af manual workflow inputs checked.** Confirmed: `images.yml` put the
     typed tag into `build-push-action` `tags:`, a comma- or
     newline-separated list (Context7 `/docker/build-push-action`), so `1`,
     `1.2.3` or `dev,…:1` published this unsigned, unscanned build over the
     release tags every `RR_VERSION=1` deployment pulls; the tag also went
     into the summary's shell quoted by hand. It must now be a Docker tag
     (`[\w][\w.-]{0,127}`, distribution/reference `regexp.go`) and not a
     release form (`X`, `X.Y`, `X.Y.Z`, `X.Y.Z-…`, `rc`), checked first; the
     shell reads it through `env`. `rebuild.yml` likewise put its typed
     version (or the latest release's) into a checkout ref, a shell and tags;
     "Check the version" now requires `X.Y.Z` or `X.Y.Z-rc.N` before any of
     them. Regression in `tooling.test.mjs` runs both steps from the
     workflows (fails on the old ones); `docs/install.md` names the refused
     tags. actionlint: `rebuild.yml` clean; `images.yml` keeps the four
     SC2016 infos of the summary's literal Markdown backticks, present before.
     **Not verified:** a real dispatch on GitHub.

   - **9ag the console's money POSTs under the section 9.1 store.**
     Reproduced first: an E2E request crediting a balance twice with one
     `Idempotency-Key` credited 2468 instead of 1234. Section 9.1 (spec line
     1076): every POST creating money, invoices or subscriptions accepts the
     key and a repeat returns the kept response with `Idempotent-Replay:
true`. `IdempotencyInterceptor` now serves `users/:id/extend`,
     `set-plan`, `balance`, `transactions/:id/refund` and
     `subscriptions/bulk-extend`, keyed `rr:idem:<adminId>:<key>`; it keeps
     the `Audited` body (what the client receives) while passing the
     `Audited` on to the audit interceptor, which records nothing for a
     replay. The key stays optional there (9.4 requires it only on
     `/me/invoices`). The console sends one key per opened dialog (extend,
     credit, refund, bulk extension), so confirming again after a lost
     answer is a replay. The services' own guards are unchanged (the refund
     remaining-amount check, the account `FOR UPDATE`); a failed request
     keeps nothing, as for the account API. OpenAPI lists the optional
     header on the five routes; `docs/admin.md`. Regressions: interceptor
     unit (administrator owner, `Audited` body), audit unit (replay not
     recorded), controller metadata (all five routes), E2E API (credited once,
     replayed body, one audit entry; red on the old API) and E2E UI (the
     first answer dropped after the API applied it, confirmed again:
     credited once; red on the old console with 2400). Verified: lint,
     typecheck, API 286, web 45, `pnpm test` 54, `pnpm test:e2e` 32 passed /
     1 skipped. **Known order:** the change commits before the audit entry
     is written (as before this repair), and the store keeps the response
     before that write; if the write fails the client sees an error and a
     retry with the key is replayed, not performed or audited again.

   The 2026-09-24 deployment review has no item left: the Trivy tag, the
   worker `/backups` mount and the restore script were repaired earlier in
   this list, the suspected ones as 9ad–9af, and the idempotency gap found
   under 9m as 9ag. Still open: the M5-004 gates recorded below.

**Pre-existing E2E failure, not caused by the repair above (fixed as 2b):**
`e2e/specs/account.spec.ts:84` "preserves the selected locale when the bot
opens the account" fails on clean HEAD `3770b17` too (bot entry lands on
`/ru/account` after visiting `/en`). It was added in `0c79ae7`, whose entry
recorded that browser E2E could not run on this host, so it never passed.
The customer entry-flow repair is therefore not fully verified.

## Customer account entry-flow regression repair — 2026-09-23

Current milestone remains M5 and the sole milestone task remains TASK-M5-004;
this is a regression/acceptance repair for the already completed TASK-M4-004
and TASK-M4-010. The earlier M4 verification had a gap: the internal account
exchange was implemented and tested through a direct `issue-token` helper, but
the real landing and bot user entry points were not fully covered.

- Root cause: the Telegram web callback created `rr_sid` and only called
  `router.refresh()`, the landing had no server-validated signed-in CTA, and
  the bot's existing `ApiClient.issueToken()` was unused by its screens. The
  `/auth/tg` route already forwarded the session cookie and selected locale
  from `rr_lang`, so the defect was at the entry points rather than in the
  account pages or token exchange.
- Web repair: successful widget authentication now navigates through the
  locale-aware router to `/<locale>/account`; failed responses stay on the
  landing and show a localized error. The landing validates `rr_sid` by
  forwarding the request cookie to `GET /api/v1/me`, then renders a localized
  account CTA only for a valid session.
- Bot repair: the main menu's localized «Открыть кабинет» callback gets the
  current configured web origin, calls the existing `issueToken(telegramId)`,
  and renders a Telegram URL button for `/auth/tg?token=<jwt>`. The API bot
  config exposes that origin through the existing domain settings contract.
- Regression coverage: the bot screen test proves the production account
  handler calls `issueToken` and produces the URL button; Playwright now covers
  the real landing callback to `/ru/account`, the signed-in landing CTA,
  locale preservation through `/auth/tg`, and retains the existing anonymous,
  account-page, purchase and logout tests.
- Passed locally: `pnpm --filter @remnaray/web test` (29), bot tests (13), API
  tests (160), `pnpm -r test`, `pnpm lint`, `pnpm typecheck`,
  `pnpm typecheck:e2e`, `pnpm format`, `pnpm i18n-check` (1492 messages),
  `pnpm build`, and the production build phase of `pnpm test:e2e`.
- Playwright browser execution is not verified on this host: `pnpm test:e2e`
  could not launch Chromium because `libnspr4.so` is missing; 18 browser
  tests failed at startup and 9 did not run, while 2 non-browser HTTP tests
  passed. No E2E pass claim is made from that run.
- Exact next task remains TASK-M5-004, after its existing Docker/VPS proxy and
  deployment gates are available. No new milestone was started.

## VPS administrator recovery — 2026-09-23

The owner confirmed the VPS login issue was a setup email typo; the password was
correct. The administrator listing exposed the exact stored email and restored
the login without changing credentials. The deployment now documents and ships
`./scripts/rr admin:list`, `admin:reset-password` and `admin:reset-totp` for
future SSH recovery. Password reset clears the failed-login counter and lock,
preserves TOTP, and writes an audit row without storing the password. TOTP reset
is explicit and causes first-login enrolment on the next password login.

## ZAP baseline hardening follow-up — 2026-09-23

Current milestone remains M5 and the sole task remains TASK-M5-004. This is a
security follow-up to the task's proxy and web acceptance; no new task or
milestone has started.

- GitHub nightly run [35856332631](https://github.com/VAQYBIN/RemnaRay/actions/runs/35856332631)
  passed all jobs. Its ZAP report created/updated issue
  [#2](https://github.com/VAQYBIN/RemnaRay/issues/2): no High alerts and
  `FAIL-NEW: 0`, with passive Medium/Low/Informational findings.
- The three actionable findings selected for repair were confirmed locally.
  nginx dropped server-level security headers from nested locations because
  `/_next/static/` and `/healthz` define their own `add_header` directives;
  Next.js emitted `X-Powered-By` by default; and next-intl's `rr_lang` cookie
  did not request `Secure`.
- The repair adds nginx `add_header_inherit merge`, sets
  `poweredByHeader: false`, and configures `rr_lang` with `secure: true`.
  Proxy smoke now checks HTML, JS, CSS, theme, 404 and `/healthz` responses,
  cached repeats, no `X-Powered-By`, and the secure locale cookie for both
  nginx and Caddy. A web config test and the browser E2E language-switch test
  cover the configuration and user flow.
- Local verification: web tests 28 passed; root tests 42 passed; web and E2E
  typechecks passed; lint and format passed; `pnpm build` passed; Compose
  config validation passed; `pnpm test:m5` passed all 4 tests; corrected nginx
  proxy smoke passed; corrected Caddy proxy smoke passed.
- The browser E2E runner itself was not executed on this host because the host
  lacks `libnspr4.so`; the same language flow is covered by the existing CI
  browser gate and the local proxy smoke checks the resulting cookie header.
- Remaining external action: push this repair commit, rerun nightly, inspect
  the updated ZAP issue, and close or keep it open based on the new report.
  CSP `form-action`, `style-src 'unsafe-inline'`, external Telegram SRI and
  COEP/COOP/CORP remain separate decisions because the specification and
  current Telegram/Next.js integration constrain them.

## TASK-M5-004 VPS evidence — 2026-09-23 (current authority)

Current milestone: M5. Sole task: TASK-M5-004, NOT VERIFIED overall.
These are owner-supplied VPS transcripts, not commands executed by this agent.
They supersede the absence of real-domain evidence in older entries.

- After updating VPS scripts with git pull, initial Certbot issuance succeeded
  for test.raccoonito.org, expires 2026-12-21; render and manual graceful reload
  succeeded, renewal service restarted and HTTPS readiness passed.
- HTTPS `/healthz` returned `ok` both on the VPS and another machine. The key
  target (stat -L) is root:root 600; no permission workaround was reported.
- All three legacy worker variables were removed from `.env`; up completed
  and worker health requests returned 200. Worker logs also show internal API
  503 responses for TLS/backup maintenance and payment polling. These responses
  are not a Valkey connection failure, but successful TLS-status reporting to
  `/admin/system` has NOT been demonstrated; the earlier setup explanation
  was an inference and requires verification after setup.
- nginx → caddy/acme → nginx/acme via down/up succeeded after changing `.env`;
  down removed the old proxy, up reached healthy and HTTPS ready, and each
  project-filtered running-container list contained only the selected proxy.
  No -v was used. Direct switching with up alone, stopped-container inventory
  and unrelated-project isolation still need dedicated regression evidence.
- Return to nginx/certbot reused the certificate and passed readiness.
  `certbot renew --dry-run --webroot -w /var/www/certbot` explicitly reported
  all simulated renewals succeeded; HTTPS remained `ok` afterwards.
  Background logs reporting not-yet-due/no-hooks belong to a separate normal
  renewal check. They do not invalidate the successful dry-run transcript.
- Acceptance instruction corrected after owner feedback: the shipped nginx
  template explicitly uses `/tmp/nginx.pid`, not `/var/run/nginx.pid`. The
  failed cat command is not a runtime nginx failure. Section 6 now uses the
  correct path and stops on errors, preventing two empty PID values from
  incorrectly passing the equality check.
- VPS deploy-hook/reload check PASSED (owner transcript, 2026-09-23):
  `renew --dry-run --run-deploy-hooks` with `sh /scripts/certbot.sh deploy`
  reported all simulated renewals succeeded. The reloader logged
  `certbot renewal: reloaded` at 03:36:09 UTC. Both PID readings were nonempty
  and equal to 1; HTTPS `/healthz` returned `ok` after the reload.
  This proves the renewal simulation and production hook/reload path, not
  an actual replacement of the production certificate or a continuous
  connection/no-dropped-request measurement.
- The supplied VPS sequence now confirms initial Certbot issuance, secure key
  permissions, worker startup without legacy variables, both down/up profile
  switches, HTTPS readiness and simulated renewal with graceful reload.
  No repeat of this renewal check is required. Exact next work within
  TASK-M5-004: rerun the final local app build, permission integration,
  lifecycle isolation/direct-switch tests and both proxy smokes once Docker
  is stable; then verify TLS-status reporting after setup and resolve the
  recorded internal API 503 observations. No new TASK is authorized.
- Follow-up VPS logs showed repeated worker `429` responses from internal
  payment polling. Root cause is now identified locally: the global Nest
  ThrottlerGuard counted `/api/internal/*` against the browser limit of 60/min.
  The repair uses Throttler's `skipIf` for authenticated internal routes and
  adds a regression test. Recheck the worker logs after the new app image is
  deployed; these `429`s are a related standard-worker acceptance defect.
- Local repair verification for this follow-up passed: API tests 159, worker
  tests 5, root tests 42, and the internal throttling regression. The rebuilt
  `remnaray/app:m5-004-final` image passed the final `pnpm test:m5` 4/4 run,
  nginx proxy-smoke and Caddy proxy-smoke. Publish this app image before the
  final VPS worker-log recheck.
- Additional VPS report: ordinary admin tab navigation still produced 429 and
  the shell redirected to login. Root cause was the documented 60/min public
  throttler applied to admin sessions, plus the web shell treating every
  `/api/admin/v1/auth/me` error as logout. Commit `5e0e621` initially exempted
  internal worker calls; the follow-up in the current working tree now grants
  authenticated admin/user sessions 300/min with account trackers and sends
  the shell to login only for 401. API 160, worker 5, web 27 and the new
  admin 429 behavior test pass. Publish the rebuilt app image and recheck VPS.
- Final local admin repair verification: API 160 tests, worker 5 tests, web 27
  tests, root 42/42, typechecks, lint and i18n checks pass. The app image
  `remnaray/app:m5-004-admin-final` builds successfully. Publish the matching
  image under the VPS tag before the final admin navigation check.
- GitHub Actions run `35852213860` for head `d47bfb3` was inspected directly:
  app, backup, nginx and caddy jobs passed; web failed on the admin-shell test
  component type mismatch. The test wrapper fix is local and now passes web
  typecheck/test plus `docker build -f deploy/docker/web.Dockerfile`.
- Nightly workflow audit: runs `35835926307`, `35703473946` and `35578299917`
  failed for three independent reasons: nonexistent `aquasecurity/trivy-action`
  tag `0.28.0`, two high transitive audit advisories, and ZAP issue creation
  returning 403 while the scan itself had zero FAIL alerts. Current repair
  updates Trivy to v0.36.0, grants the ZAP action its existing intended
  `issues: write` permission while retaining `fail_action: true`, and pins
  patched `deepmerge-ts`/`mysql2` overrides.
  Local audit and build checks pass; rerun nightly after publishing this
  commit.
- GitHub run `35855763968` was started for `ff83998` before the Trivy tag
  correction and must not be used as the final result. The upstream action tag
  is `v0.36.0`; the workflow now uses that exact tag.
- Repair commits: 3da1ff6 (initial issuance), 17d2ac9 (worker and initial
  lifecycle repair), b41e20b (initial HTTPS wait), 5bb007a (domain-specific
  certificate metadata, synchronous render/reload, project-aware cleanup and
  strict HTTPS readiness). No new runtime change in this evidence entry.
- Final local image/permission integration/proxy-smoke gates remain open as
  recorded below after Docker SIGBUS. CI/review and real `/admin/system` TLS
  reporting are not claimed. Do not begin another TASK or M6.

## TASK-M5-004 remediation — 2026-09-22 (current authority)

Current milestone: M5, NOT VERIFIED. Current and sole task: TASK-M5-004.
The previous local-verification claim is withdrawn following five confirmed VPS
defects. No other TASK or milestone may start in this session.

- Defect 1 repaired in `3da1ff6`: the Compose renewal-loop entrypoint swallowed certonly.
  `tls:issue` now overrides it with Certbot and supplies webroot, domain, email,
  named lineage and keep-until-expiring. Renewal remains a separate loop.
  Regression: `node --test test/rr.test.mjs` — 2/2 pass, including failure
  propagation and missing-email rejection. Repair commit: this commit
  (`fix(deploy): route initial TLS issuance directly to Certbot`).
- Defect 2 repaired in `17d2ac9`: `proxy-config` and
  `proxy-reloader` no longer mount Certbot's private-key volume. Certbot and
  nginx retain the only certificate mounts; a separate certificate-list marker
  volume drives bootstrap/full rendering. Marker and permission-boundary
  regression coverage passes.
- Defect 3 repaired in `17d2ac9`: the worker no longer
  checks `RR_WORKER_ENABLED` or reads `RR_VALKEY_HOST`/`RR_VALKEY_PORT`; it
  pings and reuses the documented `VALKEY_URL`, and the outbox relay is always
  scheduled. Worker tests: 3 files, 5 tests passed.
- Defect 4 repaired in `17d2ac9`: `up` removes only stale
  opposite-profile containers selected by the RemnaRay Compose project/service
  labels; `down` enables nginx, caddy, external and certbot together without
  removing named volumes. Lifecycle regression coverage passes.
- Defect 5 repaired in `17d2ac9` and `b41e20b`: `up` uses Compose
  `--wait --wait-timeout 300`, a profile generation marker healthcheck and
  timeout diagnostics; Certbot state sync is followed by another bounded wait.
  No arbitrary sleep was added. Readiness regression coverage passes with the
  wrapper simulation.
- Docker was restored and `pnpm test:m5` passed all three tests (M5-002, M5-003,
  M5-006), including nginx/Caddy validation and backup rotation. A later
  Docker Desktop/BuildKit bus error interrupted the follow-up smoke after the
  app image was rebuilt; proxy smoke must be rerun after the engine stabilizes.
  Real-domain acceptance remains NOT VERIFIED.
- Current repair verification: wrapper regression 8/8, proxy renderer 22/22,
  worker tests 5/5, root tests 42/42, workspace tests passed, workspace
  typechecks passed, `pnpm build`, `pnpm lint`, `pnpm format`, shell syntax and
  `git diff --check` passed. `pnpm test:m5` passed all three M5 integration
  tests before the final readiness/permission additions: nginx/Caddy validation
  and backup rotation. The final Docker rerun is currently blocked because
  Docker Desktop's CLI is intermittently returning SIGBUS and then
  `unknown flag: --profile`; the latest proxy smoke therefore cannot be claimed.
  A new Docker integration test covers root-only Certbot permissions and renderer
  metadata access. Those final container gates are blocked, not skipped. The
  exact VPS procedure is in `docs/tls.md`; it remains an external acceptance
  gate and has not been executed here. `pnpm typecheck:e2e`, `pnpm i18n-check`
  (1482 messages), both theme validations and the final clean-tree/diff audit
  also pass. Overall TASK-M5-004 remains **NOT VERIFIED** until the final
  Docker-backed local acceptance is rerun and the real-domain procedure is
  executed.

## Reconciliation — 2026-09-21

This is the current handoff state. Older entries below preserve the evidence
and decisions made during the previous agent's work; this section supersedes
their earlier "next task" and release statements.

### Current milestone and task

M5 — in progress; the milestone is **NOT VERIFIED**. Do not proceed to M6.
The immediate task is release and acceptance closure after repairing the
Remnawave v3.4.4 compatibility boundary.

### Verified state

- TASK-M5-003, TASK-M5-006, TASK-M5-007, TASK-M5-008 and TASK-M5-009 are
  verified by the evidence recorded below. TASK-M5-002 is locally verified,
  including the measured image-size gate in its later reconciliation entry.
- TASK-M5-004 is locally verified only. Its required real-domain ACME and
  Certbot checklist remains open; the checklist is in `docs/tls.md`.
- TASK-M5-001 and TASK-M5-005 have implementation and unit coverage. Fresh
  Playwright verification depends on the host Chromium library and is not
  claimed here as a current result.
- The panel contract repair is implemented in this handoff but is not yet
  accepted against the VPS. The SDK now uses numeric Remnawave `id`, the
  documented Telegram stream endpoint, numeric action/HWID routes, and the
  required revoke body, nested `userTraffic`, and UUID-string squad payloads.
  Migration `0005_panel_user_id` stores the mapping; `vlessUuid` remains the
  subscription snapshot. The live panel is v3.4.4.
- Setup step 3 now accepts an optional owner-provided panel webhook secret.
  The check preview and saved `panel.webhook_secret` use that exact value;
  leaving it blank keeps the existing generated-secret behavior. Both locale
  strings, schema tests and setup documentation are updated.

### CI, images and release

- Subsequent VPS evidence: all five `ghcr.io/vaqybin/<image>:dev` manifests
  resolve with `linux/amd64` images. GitHub images run
  [35562770867](https://github.com/VAQYBIN/RemnaRay/actions/runs/35562770867)
  succeeded for `6cfbc770c8badb33478d16ba503a39f4397b5c1e`, including all five
  images and the summary job. This supersedes the zero-runs observation below;
  arm64 and tagged-release acceptance remain unverified.
- New VPS deployment blocker: `docker compose --profile nginx up -d` resolves
  `ghcr.io/remnaray/*:dev` despite the reported `.env` containing
  `RR_REGISTRY=ghcr.io/vaqybin`. Classified as deployment/configuration;
  precise cause is pending effective-environment and Compose-file diagnostics.
  Current repository expressions support `RR_REGISTRY`; per-image overrides
  take precedence. Do not infer an authentication failure for the published
  `vaqybin` images from a denial for the different `remnaray` namespace.
- `pnpm install --frozen-lockfile` passed in this checkout.
- GitHub run `35535283089` for commit `c28ec08` passed quality, E2E,
  Lighthouse, proxy, all five Docker matrix builds and both proxy-smoke jobs.
  The default `main` branch also has a successful CI run.
- `.github/workflows/images.yml` is manual (`workflow_dispatch`) and has zero
  runs. `.github/workflows/ci.yml` builds with `push: false`; it never publishes
  images. No release tag exists and there are no published image runs to
  inspect. This is an operational/manual release blocker, not evidence of a
  failed Docker build. The workflow's triggers, permissions, GHCR login,
  Buildx, matrix, tags and cache are present and actionlint was previously
  reported clean. Do not claim GHCR publication until an authorized workflow
  run or release tag proves it.
- Local app-image reproduction on this host terminated inside Docker with
  `fatal error: unexpected signal during runtime execution` / `Bus error`
  while installing the 970-package workspace. CI successfully built the same
  preceding app and web image revisions; the host failure is an environment
  blocker. After the crash, even `docker compose version` returned `Bus error`;
  proxy and backup images still require a fresh local build after Docker
  Desktop is repaired, and the repaired app image still needs a CI run.

### Current verification run

`pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm -r typecheck`,
`pnpm lint`, `pnpm format`, `pnpm test` (34), `pnpm --filter
@remnaray/api test` (155), `pnpm --filter @remnaray/db test` (3),
`pnpm turbo run test --force` (30 tasks), `pnpm build`,
`pnpm typecheck:e2e`, `pnpm i18n-check`, both theme checks, Prisma validation,
the SDK/mock tests, and `git diff --check` passed after the repair. The Docker
Compose validation command was attempted but could not run because Docker
Desktop itself returned the bus error above.

### Manual acceptance

- The previous VPS run reached setup step 3 and verified the squad page shape,
  Tailwind source coverage, queue delivery, proxy profiles, monitoring and
  backup behavior as recorded below.
- The previous VPS could not complete a purchase against the panel because the
  SDK sent UUIDs to a v3.4.4 panel that requires numeric IDs. The repair is now
  ready for VPS acceptance, but the purchase, HWID, revoke and webhook paths
  still need to be exercised against that panel.
- The updated setup wizard itself still needs a browser check at
  `https://<domain>/setup`: enter the existing panel secret, confirm the
  generated `WEBHOOK_SECRET_HEADER` line matches it, finish setup, and verify
  a signed panel webhook is accepted.
- Remaining blockers are classified as: **implementation** — run live panel
  compatibility acceptance; **release** — run and inspect the manual images
  workflow or a tagged release; **environment/VPS** — public-domain TLS
  checklist and this host's Docker bus error; **manual validation** — M6
  acceptance and provider checks remain out of scope for this handoff.

### Exact next action

First obtain the VPS's filtered `docker compose config --environment`,
`config --images`, and image expressions in its Compose files, following
the registry troubleshooting instructions. Correct the selected image
namespace and verify it before retrying startup.

After image selection is corrected, verify migration `0005_panel_user_id`
and service health on the VPS, then exercise a purchase and panel user actions
against v3.4.4. Run the real-domain checklist in `docs/tls.md` and record its
output. The successful development-image publication does not close the
tagged-release acceptance gate.

## Historical progress

## First-panel findings — 2026-09-20

The owner reached step 3 of the setup wizard against a real Remnawave panel.
Four defects, two of them one root cause.

- **`squads.map is not a function`.** `GET /api/internal-squads` answers with a
  page — `{response:{total,internalSquads:[…]}}` — and the client read what was
  left after unwrapping the envelope as the list itself. `packages/remnawave-mock`
  answered `{response:[…]}`, imitating the client rather than the panel, so
  nothing could catch it. The same page shape applies to
  `GET /api/hwid/devices/{id}`; `DELETE /api/users/{id}` answers 204 with no
  body, which the client parsed unconditionally. All three are fixed, the mock
  now answers what the panel answers, and a non-JSON error body — an HTML page
  from a proxy in front of the panel — now reaches the caller as its message.
  Re-verified against the official v3.4.4 document, which has not drifted: same
  SHA-256, 162 paths. `docs/adr/ADR-010.md` carries the correction.
- **Cramped buttons, invisible errors and a "Далее" that wanted two clicks.**
  One cause: Tailwind's automatic source detection skips `node_modules`, and
  that is the only path from `apps/web` to `@remnaray/ui`. The stylesheet
  carried just the classes the application itself used — 16 KB where there
  should be 27 KB. Every class the kit alone owned was absent: `px-4 py-2` from
  every button, `disabled:opacity-50` (so a disabled button looked exactly like
  an enabled one, which is the two-click impression), and `fixed`, `z-100`,
  `max-w-sm` from the toast viewport, so errors were reported to a toast that
  was never on the screen. `@source '../../../packages/ui/src'` in
  `app/globals.css` fixes all of it; measured before and after in
  `.next/static/chunks/*.css`.

A fourth defect surfaced when the owner rebuilt the images with these fixes:
`docker build` of the app failed with TS1484 on a type-only import in the new
SDK test. Three packages — `db`, `remnawave-sdk` and `remnawave-mock` —
compiled their tests into `dist` where the other ten excluded them, so test
code shipped in the application image and the image build was the only gate
that type-checked it. All three now exclude tests, and
`test/tooling.test.mjs` holds every package build config to the rule. The
applications still compile their own tests into `dist` — they build from
`tsconfig.json` directly, so separating that needs a build config per app; it
is recorded here with the M5-002 image-size item rather than changed in the
same breath.

A fifth: the owner's server is 1 vCPU / 2 GB, and `./scripts/rr build` spent
more than twelve minutes inside the Next.js build before being abandoned.
Building on the target is not a route the smallest supported server can take,
and until a release exists there was no other. `.github/workflows/images.yml`
publishes the five images from Actions under a chosen tag without making a
release, and `RR_REGISTRY` — defaulting to `ghcr.io/remnaray`, which is what
compose always resolved — points a deployment at any namespace. Found while
writing it: GHCR refuses an uppercase namespace and `github.repository_owner`
carries the account's own spelling, so `release.yml` and `rebuild.yml` would
have pushed to a name they could not create for any owner whose login is not
all lowercase. `docker/metadata-action` lowercases; a raw `tags:` string does
not. Every workflow lowercases it now.

A sixth, the same class as the first: `pnpm lint` and `pnpm typecheck` read
generated types that a developer's checkout has and a runner's does not.
`apps/web/i18n/request.ts` calls `rootLocale()` from `next/root-params`, whose
declarations Next writes into `.next/types`; CI lints before it builds, so the
call resolved to `any`. `next typegen` produces them in two seconds without a
build and now runs in the root `postinstall` beside `prisma generate`.

That is twice a green working tree disagreed with CI for the same reason, so
`scripts/ci-local.sh` now runs the quality gate from the state a runner starts
in: it deletes `node_modules`, every `dist`, every `.turbo`, `apps/web/.next`
and the generated Prisma client, installs, and runs lint, format, both
typechecks, both test sets, the locale and theme checks and the build. It
passes on this tree; `CONTRIBUTING.md` points at it.

A seventh, and the same shape again: `@remnaray/queues` imports
`@remnaray/db`, whose `exports` point at `dist`, and turbo's `test` task
depended on `^test` — which builds nothing. CI ran `pnpm -r test` before the
build step, so the suite could not resolve the import and failed to load. The
task depends on `^build` now and the workspace tests run through turbo
everywhere.

`scripts/ci-local.sh` did reproduce this on its first run and it was reported
as passing anyway. The script was not at fault: `set -eu` in a real script
aborts correctly. The verification was a hand-written paraphrase of it typed
into a shell, where `set -e` inside a `{ … }` group did nothing, and the log
was then checked with a grep that did not match the failure. The script is the
thing to run; a retyped copy of it is not. Run for real on this tree it exits
0, with 263 workspace tests across 17 packages and 33 repository tests.

**Still open, and now the largest item in the project.** ADR-010 recorded on
2026-09-19 that the panel identifies users by a numeric `id` and carries no
`uuid`, that `/api/users/by-telegram-id/{telegramId}` does not exist, and that
every action route and the HWID body take that numeric id. It asked TASK-M2-001
to introduce the mapping. M2-001 was scoped to payments and did not. The
section 10.1 client is UUID-based throughout, so every user operation beyond
`users.create` and `users.getByUsername` will fail against a live v3.4.4 panel:
a purchase cannot provision. This needs its own task — it changes the
identifier the subscription rows persist, so it carries a migration.

## First-server findings — 2026-09-20

The owner took the repository to a VPS to run the TASK-M5-004 checklist and
could not start it. Three defects stood between a clone and a running
deployment; none of them is in M5's artifact lists, and all three are fixed.

- **A fresh checkout does not lint.** `@remnaray/db` exports its types from
  `src/generated/prisma`, which `prisma generate` writes and `.gitignore`
  excludes. Without it every type-aware rule that touches a Prisma call sees
  `any`, and the first CI run of the `dev` branch failed with **3173 errors**
  — `no-unsafe-member-access` on `.outboxJob`, `$queryRaw`, `$transaction` and
  the rest. `app.Dockerfile` already ran the generate step, so only the
  workflows and a developer's own clone were exposed. A root `postinstall`
  now generates the client on every install; reproduced by moving
  `packages/db/src/generated` aside, confirmed fixed by deleting all 22
  `node_modules` trees and reinstalling, and the `web` image still builds.
- **A release would publish images nobody pulls.** `release.yml` and
  `rebuild.yml` pushed `ghcr.io/<owner>/remnaray-<image>`; `compose.yaml`
  pulls `ghcr.io/remnaray/<image>` (section 7.1). Neither workflow built the
  `backup` image at all, though every profile starts it. Both now publish the
  five images under the names compose resolves to.
- **A source checkout has nothing to start.** `compose.yaml` carries no build
  contexts by design, so with no published release `./scripts/rr up` stops at
  `error from registry: denied` — which is what the owner hit.
  `./scripts/rr build` now builds `app`, `web`, `backup` and the proxy of the
  active profile under exactly the tags compose resolves to, so `up` pulls
  nothing afterwards. `docs/install.md` gained "Running from a source
  checkout" and `docs/troubleshooting.md` the symptom.

- **A clone cannot run the documented commands.** This repository carries
  `core.fileMode=false`, so the executable bit of every shipped script stayed
  out of the index: `./scripts/rr up` answers `Permission denied` on a fresh
  clone, CI's `proxy-smoke` step could not have launched its own script, and
  the crontab the `backup` image installs executes
  `/scripts/backup-entrypoint.sh` by path from a read-only mount that would
  have been mode 644. Six scripts are now `100755` in the index.
- **Neither backup wrapper ran.** `./scripts/rr backup` passed
  `/scripts/backup-entrypoint.sh once` to an image whose entrypoint is that
  script, so it arrived as the subcommand and the script printed its usage and
  exited 1 — confirmed against the built image. `./scripts/rr restore` ran
  `restore.sh` inside the `backup` container, and that script drives
  `docker compose` (it stops the stack, brings PostgreSQL up alone, restores,
  starts everything) so it has to run on the host. `backup` now passes `once`;
  `restore` calls the host script with `COMPOSE_FILE` and `RR_PROXY_PROFILE`.
  The section 26.4 item R drill was never runnable through the wrapper.

`test/tooling.test.mjs` covers all of it: the wrapper's tags are compared
against `compose.yaml` image by image, the workflows' names against the same,
and the `postinstall` against `@remnaray/db`'s generated export; the six
script modes are read out of the git index, because the working tree hides the
problem on this machine. The naming test and the mode test were each confirmed
to fail against the state they fix.

Note for whoever runs the M5-004 checklist: the branch under test is `dev`.
`main` is still at M0, where `compose.yaml` pins `:local` tags that exist
nowhere — a clone of the default branch cannot start.

## M5-009 verification — 2026-09-20

Verified on 2026-09-20. The acceptance is that the links in the README resolve
and that `release.yml` publishes images for a tag like `v0.9.0-rc.1`.

- `README.md` (English) and `README.ru.md` (Russian) carry the section 24.1
  sections — badges, what it is, quick start, requirements, the proxy profile
  table, the payment provider table, customisation without a fork, upgrading,
  the comparison with `remnawave-tg-shop`, the section 7.1 architecture
  diagram, contributing and the licence — and link to each other.
- `LICENSE` (MIT), `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md` (Contributor
  Covenant 2.1), `SECURITY.md`, `CHANGELOG.md`, `Makefile`, the three issue
  templates, `PULL_REQUEST_TEMPLATE.md` and `CODEOWNERS`.
- New pages: `docs/install.md`, `docs/upgrade.md`, `docs/api.md`,
  `docs/troubleshooting.md` (by symptom, as section 24.3 asks) and
  `docs/faq.md`.
- `.github/workflows/release.yml`, `rebuild.yml` and `nightly.yml`.

### M5-009 verification evidence

- `test/docs.test.mjs` walks every Markdown file the delivery ships and
  resolves every relative link: **0 broken**. It also asserts the section 24.2
  file set, a page per section 24.3 topic, the section 24.1 README sections and
  badges in both languages, and the release workflow's own shape.
- `actionlint` on all four workflows: clean.
- The tag behaviour is asserted statically, because a tag may not be pushed
  from here: `release.yml` triggers on `v*`, builds `app`, `web`, `nginx` and
  `caddy` for `linux/amd64` and `linux/arm64`, pushes with an SBOM and a
  provenance attestation, and tags `X.Y.Z` always while `X.Y` and `X` are
  enabled only when the version carries no pre-release suffix. `v0.9.0-rc.1`
  therefore publishes `0.9.0-rc.1` and `rc`, and does not move the tag an owner
  on `RR_VERSION=1` follows.
- `pnpm test` (27), `pnpm -r test` (api 155 and the rest), `pnpm lint`,
  `pnpm format`, `pnpm typecheck`, `pnpm -r typecheck`, full `pnpm build`, the
  `nginx`, `caddy` and `monitoring` compose profiles, and
  `deploy/ci/proxy-smoke.sh nginx` end to end.

### M5-009 decisions

- `compose.yaml` now resolves its images through `${RR_VERSION:-1}`, which
  section 24.4 requires and the delivery did not do: an owner who runs
  `docker compose pull` follows the major line instead of a `:local` tag that
  no registry serves. `RR_APP_IMAGE` and its siblings still override, which is
  what the smoke stand uses.
- `./scripts/rr` gained `backup`, `restore` and `theme:validate`, which section
  23.1 lists and section 26.4 R1–R3 uses, and a `help` that exits zero so the
  `Makefile` can alias it.
- The `rebuild.yml` of section 24.6 publishes the dated tag and moves `X.Y` and
  `X` only after trivy passes on the rebuilt image. A rebuild that made things
  worse must not become what `RR_VERSION=1` resolves to.
- `nightly.yml` runs `zap-baseline` against the section 22.7 smoke stand rather
  than a stack of its own: the stand is already a real deployment behind a real
  proxy, which is what a baseline scan should see.

### M5-009 gaps, recorded not closed

- **No screenshots.** Section 24.1 asks for the landing, the bot and the
  console. There are no image files in the repository and a README that linked
  to missing ones would fail its own acceptance, so the section is absent
  rather than broken. It needs a running deployment to produce.
- **Module READMEs**: section 23.3 wants one per `apps/api` module; 7 of 18
  have one. Not in this task's artifact list, so not written here.
- **ADRs**: `docs/adr/` holds ADR-010 alone, though the specification cites
  ADR-005, ADR-006 and ADR-014 among others. Also outside this task's list.

## Queue delivery repair — 2026-09-20

The defect recorded under "M5-008 finding" is fixed, and it turned out to be
two, either of which alone stopped every queued job:

1. **BullMQ refuses a custom job id containing a colon** — its own key
   separator — and refuses one that is all digits. Every identifier the
   application builds carried a colon: `evt:<id>`, `panel:<userId>`,
   `alert:payment.late:<id>`, `notify:<dedupKey>`, `maintenance:tls-check:<s>`
   and twenty more. `packages/queues` now exports `toJobId`, which translates
   the separator at the boundary with BullMQ and prefixes an all-digit id. The
   readable form stays in `outbox_jobs.job_id`, and the mapping is one-to-one,
   so deduplication is unchanged.
2. **The relay published under `rr:q` and the workers waited on `bull`.** They
   shared a queue name and nothing else: jobs were enqueued, nothing consumed
   them, and neither side reported anything. `QUEUE_PREFIX` is now one exported
   value that both use.

Verified on a stand and in the suite:

- Before: `docker logs worker` carried "Custom Id cannot contain :" every two
  seconds, `outbox_jobs` had five unpublished rows, and `rr:q:notify:wait`
  held jobs nothing was reading.
- After: zero such errors, all five outbox rows published, and the queues
  report `notify` 2 completed, `maintenance` 2 completed, `payments` 1
  completed. The `panel` failure that remains is `PANEL_UNAVAILABLE` against
  the stand's `https://panel.invalid`, which is the correct answer there.
- `test/m1.integration.test.mjs` now runs a real job through: the outbox writes
  `notify:sub.activated:<uuid>`, the relay publishes it, and a BullMQ worker
  on the shared prefix receives it as `notify-sub.activated-<uuid>`. Both
  defects fail this test.
- `pnpm test:m1` (1), `pnpm test:m2` (1), `pnpm test:m4` (4), `pnpm test:m5`
  (3), `pnpm test:e2e` (26), `pnpm test` (21), `pnpm -r test`, `pnpm lint`,
  `pnpm format`, `pnpm typecheck`, `pnpm -r typecheck` and `pnpm build`.

### Open: an intermittent test failure

`setup.service.test.ts > accepts the environment token once` failed twice
across six full `pnpm -r test` sweeps and never in isolation, under
`--no-isolate`, or on any re-run. The test performs an argon2 hash and an
argon2 verify, which is the slowest thing in the suite, so contention is the
obvious suspect — but that was not established, and nothing was changed on a
guess. Recorded here for whoever picks it up.

## M5-008 verification — 2026-09-20

Verified on 2026-09-20. All twelve section 9.9 metrics are present in
`/metrics` on a running deployment, which is the acceptance of the task.

- `packages/metrics` declares the twelve metrics in one registry, with the
  Node.js defaults beside them. Every process registers all of them, not only
  the ones it writes: a metric with no observations costs two lines of text,
  and a dashboard should find its series whichever target answered.
- `/metrics` is served by `api` (through the proxy, and only from the compose
  network — the proxy denies the rest and `api` checks the address again, which
  is the second check section 19.7 asks for), by `worker` on `:3003` and by
  `bot` on `:3002`. Neither of those ports is published.
- The setup gate lets `/metrics` through: a deployment being set up is exactly
  when an operator wants to watch it, and the address check already applies.
- Written where the thing happens: an interceptor for the HTTP counters,
  labelled with the route template Fastify matched rather than the path;
  `packages/remnawave-sdk` for the panel, once per operation rather than per
  retry; the payments repository for events, invoices and the one entry that
  moves money into `revenue`; `NotifyService` for every attempt, sent or
  skipped; the bot ingress for each update taken off the stream; the worker for
  queue depth, sampled every fifteen seconds; the TLS reading on both the
  worker that made the handshake and the API that Prometheus scrapes; and the
  ledger audit for a disagreement it found.
- nginx serves `stub_status` on `127.0.0.1:8081` inside its container (section
  20.2) for an exporter an owner may add. Caddy already answered Prometheus on
  its admin port.
- `deploy/monitoring/` is included by `compose.yaml` and starts nothing without
  `--profile monitoring`. Neither Prometheus nor Grafana publishes a port.
  Grafana is provisioned with the datasource and `remnaray.json`, and its
  bundled plugin download is turned off — a deployment that can reach a panel
  and nothing else has to come up anyway.

### M5-008 verification evidence

- On a running nginx stand: `GET /metrics` through the proxy from inside the
  compose network returned 200 with **12** `# TYPE rr_*` lines — every name of
  section 9.9 — and from outside 403, for both methods. `bot:3002/metrics` and
  `worker:3003/metrics` each carried the same twelve.
- Live series were observed, not only declarations:
  `rr_http_requests_total{route="/api/v1/public/i18n/:lang/:namespace"}`,
  `rr_http_requests_total{route="/webhooks/:provider",status="400"}` and, with
  the worker enabled, `rr_queue_jobs` for all five queues in five states.
- `docker compose --profile nginx --profile monitoring up -d`: Prometheus
  reported `api`, `bot`, `worker` and itself `up`; Grafana answered
  `/api/health` with `database: ok` and listed the provisioned dashboard
  `remnaray` and the datasource `remnaray-prometheus`. The `caddy` target reads
  `down` under the nginx profile, which is the intended reading.
- `deploy/ci/proxy-smoke.sh nginx` and `deploy/ci/proxy-smoke.sh caddy` both
  passed all ten checks with the new `inside GET /metrics 200` row.
- `pnpm test` (21), `pnpm -r test` (api 155, metrics 5, and the rest),
  `pnpm test:m1` (1), `pnpm test:m2` (1), `pnpm test:m4` (4), `pnpm test:m5`
  (3), `pnpm test:e2e` (26), `pnpm lint`, `pnpm format`, `pnpm typecheck`,
  `pnpm -r typecheck`, `pnpm typecheck:e2e` and full `pnpm build`.
- `pnpm lighthouse` was not repeated: `apps/web` is untouched by this task, and
  it passed after the last change to it (landing RU 100/96/100).

### M5-008 finding — the queues never enqueue anything

Running the worker against the stand surfaced a defect that predates this task
and is **not** repaired in it:

```
Error: Custom Id cannot contain :
  at Job.validateOptions (bullmq/dist/cjs/classes/job.js:912)
  at .../@remnaray/queues/dist/index.js:42
```

BullMQ 6 refuses a `jobId` containing a colon, and every identifier the
application builds uses one — `evt:<id>`, `panel:<userId>`,
`alert:payment.late:<id>`, `notify:<dedupKey>`, `maintenance:tls-check:<stamp>`
and the rest, 23 sites in all. Nothing reaches a queue: no panel sync, no
notification, no broadcast chunk, no maintenance job. It is invisible to the
current tests because `RR_WORKER_ENABLED` is not set in any of them, and the
outbox relay logs the rejection and carries on.

This is the next thing to repair, before TASK-M5-009.

### M5-008 observation

`setup.service.test.ts > accepts the environment token once` failed once under
a full parallel `pnpm -r test`. See "Open: an intermittent test failure" above,
which records what is known after further attempts.

## M5-007 verification — 2026-09-20

Verified on 2026-09-20. `deploy/ci/proxy-smoke.sh` passed all ten checks of
section 22.7 against **both** profiles on a real Compose stand.

- `deploy/ci/proxy-smoke.sh <nginx|caddy>` builds the stand from `compose.yaml`
  plus `deploy/ci/compose.smoke.yaml`, seeds the section 22.3 fixture, and runs
  the ten checks. `deploy/ci/expected-status.tsv` holds the section 21.5 path
  table, read by both profiles, so a divergence is a failed row rather than two
  scripts that disagree. `deploy/ci/gen-selfsigned.sh` issues the `custom`-mode
  certificate for the stand and for the domain step 9 adds.
- The stand adds a second network, `rr_edge`. Without it there is no vantage
  outside `RR_TRUSTED_PROXIES`: a request from the host is translated to the
  compose gateway, which is inside the allowed range, so the `/metrics → 403`
  of step 4 would have passed without proving anything.
- `apps/api/src/tools/seed-dev.ts` writes the section 22.3 fixture into a
  running deployment and prints what it seeded, which is how the stand gets an
  administrator to log in as. It refuses to seed over a finished installation.
- `POST /api/internal/v1/echo-headers` answers step 5. It exists only when
  `RR_ECHO_HEADERS=true`, which the stand sets and a deployment never does.
- CI gained a `proxy-smoke` matrix over both profiles, and the `docker` job now
  builds the `caddy` and `backup` images too, with a shared Buildx cache the
  smoke job loads from.
- Step 10 runs the browser path of E2E-01 — the landing, the account, a
  purchase through the mock provider and the administration sign-in — against
  the stand. AC-171 stays on the harness, which is the only place a shop whose
  wizard has not run exists, and the administration console suite stays there
  too: it drives `/api/admin` far faster than a person and would measure the
  30r/m limit of section 19.4 rather than anything about the proxy.

### What the smoke found

Every one of these stopped the stand or broke the section 21.5 invariant, and
none of them could be seen without running the deployment end to end.

| Defect                                                                                                                                                                   | Fix                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `postgres:18` refuses to start with a volume at `/var/lib/postgresql/data`                                                                                               | mount `pgdata:/var/lib/postgresql`, the path the image declares                                                                                                                                                                                               |
| `web` bound to the container id, so its health check never passed                                                                                                        | `ENV HOSTNAME=0.0.0.0` in `deploy/docker/web.Dockerfile`                                                                                                                                                                                                      |
| `proxy-config` could not write `proxy-conf`: Docker seeds a shared named volume from whichever image _creates_ its container first, and that is not the dependency order | `/proxy-conf` and `/uploads` are created in the app image owned by `node`, and both proxy images hand `/etc/nginx/conf.d` and `/etc/caddy` the same owner; their stock `default.conf` and `Caddyfile` are removed so a seeded volume cannot smuggle a site in |
| the proxy's fixed `172.28.0.10` is inside the automatic address pool, so the tenth service took it and the proxy could not start                                         | `ip_range` reserves it                                                                                                                                                                                                                                        |
| `proxy-config` started before `migrate` and crash-looped on a missing `settings` table                                                                                   | it now waits for `migrate`, like every other reader                                                                                                                                                                                                           |
| `proxy-reloader` could not reach the docker socket, so no reload ever happened                                                                                           | it runs as root; the socket is owned by a group whose id differs per host, and a container that may drive the Docker API is already as privileged as the host                                                                                                 |
| a webhook body naming no event reached Prisma with a null `type` and answered **500**                                                                                    | the service refuses an event with no type or invoice, and the mock provider returns `null` for such a payload (section 9.7)                                                                                                                                   |
| nginx answered a non-POST webhook with 403 (`limit_except`), Caddy with 405                                                                                              | nginx returns 405                                                                                                                                                                                                                                             |
| nginx queued the `/admin` burst instead of refusing it, so the console stalled for seconds a page while Caddy refused outright                                           | `nodelay`, like every other zone                                                                                                                                                                                                                              |
| Caddy's zones carried the nginx _rate_ without its _burst_, so a sign-in the nginx profile served was refused                                                            | the events are `rate × window + burst`                                                                                                                                                                                                                        |
| Caddy's `respond @matcher` is ordered after `handle`, so the catch-all answered first: a non-POST webhook became 307 and `/metrics` from outside became 404              | each refusal is a `handle`                                                                                                                                                                                                                                    |
| Caddy had no `/healthz` on `:80` and redirected with 308                                                                                                                 | an explicit `http://` site with the health check and a 301, and `auto_https disable_redirects`                                                                                                                                                                |
| `email` with an empty value made Caddy refuse the whole file in `custom` mode                                                                                            | the directive is emitted only when there is an address                                                                                                                                                                                                        |
| the Caddy redirect site had no TLS source and ran its `redir` onto the `tls` line                                                                                        | it takes the same certificate source, one directive per line                                                                                                                                                                                                  |

### M5-007 decisions

- Section 19.3's CSP was not implemented anywhere; step 3 of 22.7 checks for
  it, so `apps/web/lib/csp.ts` now builds exactly the policy the specification
  writes out and `apps/web/proxy.ts` sets it with a per-response nonce.
- That nonce forced a rendering change. Next.js stamps the nonce onto the
  inline scripts it emits only while it renders, so a prerendered page carries
  inline scripts the next request's nonce does not cover and the browser
  refuses them — the site rendered but never hydrated. The localized routes and
  the administration console are now `force-dynamic`. The data stays cached:
  `revalidate` on the API fetches is what section 13.2 relies on and what keeps
  the landing up when the API cannot answer, which is what 26.4 E5 checks.
  `pnpm lighthouse` after the change: landing RU 100/96/100, landing EN
  100/96/100, account accessibility 96 — all above the 13.2 thresholds.
- The specs no longer name the harness's own rows. `StackState` carries the
  brand, the plan's name and the user's username, and the stand supplies the
  same fields, so one suite reads two differently seeded shops.
- Step 9 and step 10 both sign an administrator in, and a TOTP code may be
  redeemed once per 30-second period. Both now record the period they spent in
  `e2e/.auth/totp-period`, so neither presents a code the other used.
- The stand refuses to start when a `.env` is already present, because it
  writes its own, and removes both when it finishes.

### M5-007 verification

- `deploy/ci/proxy-smoke.sh nginx` and `deploy/ci/proxy-smoke.sh caddy`: all
  ten checks passed on both, including the 15 browser tests of step 10. Run on
  a resolvable local domain, since the stand's domain has to be in the host's
  resolver for Playwright's request context; CI adds the line to `/etc/hosts`.
- `pnpm test:m5` (3), `pnpm test:m2` (1), `pnpm test:m1` (1), `pnpm test:m4`
  (4), `pnpm test` (16), `pnpm test:e2e` (26), `pnpm lighthouse`, `pnpm lint`,
  `pnpm format`, `pnpm typecheck`, `pnpm -r typecheck`, `pnpm typecheck:e2e`,
  `pnpm -r test` (api 151, web 24, bot 12, worker 4, and the rest), full
  `pnpm build`, `pnpm i18n-check`, both theme validations, and
  `docker compose config` for the `nginx`, `caddy`, `external`, `certbot` and
  smoke-overlay profiles.

### M5-007 image-size doubt — resolved on 2026-09-21

A reading of about 878 MB was recorded here against the M5-002 closure's
187,223,208 bytes, and the measurement was asked to be repeated. It was: a
clean `docker build -f deploy/docker/app.Dockerfile` gives
`docker image inspect --format '{{.Size}}'` = **188,499,066 bytes**, which is
the M5-002 figure plus everything added since. The 878 MB came from the
`DISK USAGE` column of `docker image ls`, which counts the uncompressed layers
as they sit in the store, not the image: the same row shows
`CONTENT SIZE 187MB`. The doubt is withdrawn and the section 26.1 budget of
250 MB holds.

## Latest blocker closure audit — 2026-09-20

| Task        | Status                            | Evidence                                                                                                                                                                                                                                        |
| ----------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TASK-M5-001 | **VERIFIED locally**              | `LD_LIBRARY_PATH=... pnpm test:e2e`: 26/26 Playwright tests passed, including AC-171 setup steps and the post-completion `/setup` 404.                                                                                                          |
| TASK-M5-002 | **VERIFIED locally**              | `pnpm test:m5` passed nginx, Caddy and AC-202 checks. App image `remnaray/app:m5-verify` measured `187,223,208` bytes and web image `remnaray/web:m5-verify` `80,296,758` bytes (`docker image inspect`), under 250 MB and 300 MB respectively. |
| TASK-M5-003 | **VERIFIED**                      | `pnpm test:m5`: Caddy validation passed for supported modes.                                                                                                                                                                                    |
| TASK-M5-004 | **LOCAL VERIFIED; EXTERNAL OPEN** | Local TLS mode rendering, certificate-backed nginx validation, Compose profiles and config validation passed. The required real-domain ACME and certbot issuance/renewal checklist has no public DNS/server in this environment.                |
| TASK-M5-005 | **VERIFIED locally**              | API trusted-proxy suite passed (142 tests); the 26-test browser gate also passed.                                                                                                                                                               |
| TASK-M5-006 | **VERIFIED**                      | `pnpm test:m5`: real PostgreSQL 18 AC-202 dump, restore and 14/8 retention passed.                                                                                                                                                              |
| TASK-M5-007 | **VERIFIED** (2026-09-20)         | `deploy/ci/proxy-smoke.sh` green on both profiles; see "M5-007 verification".                                                                                                                                                                   |
| TASK-M5-008 | **VERIFIED** (2026-09-20)         | All twelve section 9.9 metrics present in `/metrics` on a running stand; see "M5-008 verification".                                                                                                                                             |
| TASK-M5-009 | **VERIFIED** (2026-09-20)         | Every relative documentation link resolves; see "M5-009 verification".                                                                                                                                                                          |

### Closure repairs and environment evidence

- `deploy/docker/app.Dockerfile` now deploys one shared production dependency
  closure through `packages/runtime`, avoiding duplicate Prisma/Nest trees.
  The image dropped from `396,071,825` bytes to `187,223,208` bytes. Runtime
  smoke checks found API, tools and Prisma configuration entrypoints.
- Next static generation uses
  `experimental.staticGenerationMaxConcurrency: 1`, documented by current
  Next.js configuration guidance, to keep the web Docker build within the
  available 7.7 GiB Docker memory while preserving all generated routes.
- Playwright system packages could not be installed system-wide because this
  WSL user has no passwordless sudo. The supported Playwright command was
  attempted: `pnpm exec playwright install --with-deps chromium`. The needed
  Ubuntu packages were downloaded with `apt-get download` and extracted to
  `$HOME/.local/share/remnaray-browser-libs`; Chromium then launched and all
  E2E and Lighthouse checks passed with that `LD_LIBRARY_PATH`.
- `pnpm lighthouse` passed: landing RU `100/96/100`, landing EN `100/96/100`,
  account accessibility `96`.
- The first web Docker build ran for `271.36s` and failed during static
  generation after repeated 60-second page retries. This was a constrained
  Docker resource failure, not a repository input failure: the same host build
  passed in `44.95s`. With the concurrency cap, the Docker build completed in
  `844.50s`, generated all 38 static pages and exported the `80,296,758` byte
  image.

### Final executable M5 verification — 2026-09-20

- `pnpm test:m5` passed on retry: 3/3 tests, including nginx TLS modes and
  reload in 939 ms, Caddy modes, and AC-202 backup/restore with 14 daily and 8
  weekly retention files. The first run's Docker Hub authorization EOF was a
  transient external registry failure and did not recur.
- `LD_LIBRARY_PATH="$HOME/.local/share/remnaray-browser-libs/usr/lib/x86_64-linux-gnu" pnpm test:e2e`
  passed 26/26 Playwright tests.
- The same browser runtime with `pnpm lighthouse` passed: landing RU
  performance 99, accessibility 96, SEO 100; landing EN 99/96/100; account
  accessibility 96.
- `pnpm test`, `pnpm lint`, `pnpm typecheck`, `pnpm -r typecheck`,
  `pnpm typecheck:e2e`, `pnpm format`, `pnpm i18n-check`, both theme
  validations, and all four Compose profile config checks passed.

### Remaining M5 blockers

- TASK-M5-004 remains an **external/manual validation requirement**. A user
  must provide a public server and DNS-controlled real domain, then record the
  checklist in `docs/tls.md`: nginx ACME issuance, certbot bootstrap and
  renewal reload, Caddy ACME, Caddy/certbot rejection, and the `/admin/system`
  TLS reading.
- TASK-M5-007, TASK-M5-008 and TASK-M5-009 are **implementation defects in the
  milestone state**: they remain unstarted. They were outside this blocker
  closure scope and must be implemented in dependency order after the external
  TLS gate is addressed.

## Reconciliation authority — 2026-09-20

The repository is the source of truth. HEAD at entry was `d8610a8` and the
working tree was clean. The reconciliation added the theme upload repair and
the production dependency deployment change; those changes are pending commit
below. No M6 work was started.

The prior M4 acceptance claim was not reproduced: `pnpm lighthouse` completed
the host build but then failed with `ECONNREFUSED 127.0.0.1:39185` while its
temporary runtime was unavailable. Therefore M4-003 is historical evidence,
not a fresh VERIFIED result, and M5 is not safe to advance from this session.

| Task        | Repository result                   | Evidence                                                                                                                                                                                        |
| ----------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TASK-M5-001 | **IMPLEMENTED BUT NOT VERIFIED**    | Setup API/UI, PNG/SVG logo overrides, multipart registration, archive upload route and tests exist. `pnpm test:e2e` is blocked before tests by missing host library `libnspr4.so`.              |
| TASK-M5-002 | **INCOMPLETE**                      | `pnpm test:m5` passed nginx rendering and reload. The rebuilt app image is 396,071,825 bytes, above NFR-011's 250 MB cap; the web image build timed out during static generation inside Docker. |
| TASK-M5-003 | **VERIFIED**                        | `pnpm test:m5` passed the Caddy validation and supported-mode checks.                                                                                                                           |
| TASK-M5-004 | **BLOCKED BY EXTERNAL ENVIRONMENT** | Local mode/config checks pass, but section 25.6 requires both certificate paths against a real domain and public DNS. No such stand is available.                                               |
| TASK-M5-005 | **IMPLEMENTED BUT NOT VERIFIED**    | Trusted proxy unit coverage is included in the passing API suite; the broader E2E gate is blocked by the same missing Chromium host library.                                                    |
| TASK-M5-006 | **VERIFIED**                        | `pnpm test:m5` passed AC-202 dump, restore and 14/8 rotation against PostgreSQL 18.                                                                                                             |

### Repairs made during reconciliation

- Added `@fastify/multipart` and `yauzl` using their current documented APIs.
  The setup wizard now uploads a PNG/SVG logo when `RR_THEME_UPLOAD=true`,
  writes an atomic override under the persistent uploads volume, and resolves
  the override in API, web and bot asset paths. The admin
  `POST /api/admin/v1/themes/upload` archive route validates manifests,
  required assets, paths and archive limits.
- Added regression coverage for safe logo overrides and SVG script rejection.
- Changed the app Docker build to use production deployment closures instead
  of copying the full pnpm store. This reduced the measured image from the
  prior approximately 1.9 GB image, but it does not yet satisfy the 250 MB
  NFR-011 gate.

### Verification executed

Passed:

- `pnpm install --frozen-lockfile`
- `pnpm test` — 11 repository tests
- `pnpm -r test` — all workspace packages; API 142, web 22, bot 12, worker 4 and package suites
- `pnpm lint`
- `pnpm typecheck`; `pnpm -r typecheck`; `pnpm typecheck:e2e`
- `pnpm format`
- `pnpm i18n-check`; `pnpm theme-validate themes/manta`; `pnpm theme-validate themes/_admin`
- `pnpm build`
- `pnpm test:m5` — 3 tests passed, including nginx/Caddy proxy checks and AC-202 backup integration
- `docker compose config` for `nginx+certbot`, `caddy` and `external`, using a temporary copy of `.env.example`
- `docker build -f deploy/docker/app.Dockerfile`; tool import smoke passed; measured size failed NFR-011

Failed or externally blocked:

- `pnpm test:e2e` — 15 browser tests failed to launch because Chromium could not load `libnspr4.so`; 2 non-browser tests passed.
- `docker build -f deploy/docker/web.Dockerfile` — Next.js static generation exceeded the 60-second per-page limit in the constrained Docker environment after repeated retries. The host `pnpm build` passed.
- Real-domain M5-004 certificate checklist — blocked by absent public server/DNS/credentials.
- `pnpm lighthouse` — failed with `ECONNREFUSED 127.0.0.1:39185` after the build, so the M4 Lighthouse gate was not reproduced.

### Current Definition of Done

M5 is **NOT VERIFIED**. The CI and maintainer-review gates are not evidence in
this local checkout; the local browser gate, NFR-011 image cap, and real-domain
TLS gate remain open.

**MILESTONE M5: NOT VERIFIED**
**DO NOT PROCEED TO M6**

## M5 entry audit — 2026-09-20

- Read AGENTS.md, this handoff, the relevant implementation, and authoritative
  specification sections 9.1, 17.4, 25.6, 25.9 and ADR-009. The requested first
  task is TASK-M5-001, dependent on TASK-M4-009; its acceptance is AC-171 with
  the Playwright setup flow and a 404 after completion.
- Initial `git status --short` and `git diff` were empty. Inspected
  `git log --oneline -15`; HEAD was `7b99197`. No M5 implementation commits
  were present in that history.
- Confirmed and repaired the local M4 OpenAPI defect: `apps/api/openapi.json`
  previously declared
  `3.0.3`, has no schema components, and many request bodies only declare
  `type: object`. The API build script previously only ran `tsc -p tsconfig.json`;
  there was no OpenAPI generation step. `apps/api/openapi/generator.ts` now
  uses `OpenApiGeneratorV31` and the shared `packages/domain/src/contracts/`
  schemas, while the existing route map is preserved as
  `apps/api/openapi.routes.json`; the build regenerates `apps/api/openapi.json`.
  The generated document is 3.1.0 with eight shared schemas and 128 paths,
  and the root tooling test asserts the generation boundary. Context7 resolved
  `/asteasolutions/zod-to-openapi` and confirmed the registry and
  `OpenApiGeneratorV31` APIs; documentation access is available.
- The OpenAPI repair now satisfies section 9.1, ADR-009 and section 25.9 item
  5 for the shared contracts. Its route metadata remains a checked-in source
  map because the existing Nest controllers do not expose a complete runtime
  contract registry; future route additions must update that map and the
  shared Zod contract used by the generator.
- Confirmed the outstanding external M4-003 acceptance gate: Lighthouse
  performance >= 90, accessibility >= 90 and SEO >= 95 on the reference
  server (sections 13.5 and 25.5). No reference-server address/access or
  measurement report is supplied in the handoff or repository. The running
  Docker services are the local development PostgreSQL and Valkey containers;
  they are not evidence of a reference-server run. No Lighthouse check is
  configured in the current CI workflow.
- Local tools are available: Node 24.21.0, pnpm 11.26.0 and Docker 29.7.2.
  This is not a local runtime or Context7 outage. Existing task test results
  below remain historical results; application tests were rerun for the
  OpenAPI correction and the checks are recorded below.
- No M4 implementation is overwritten, no M5 task is claimed complete, and
  M6 remains unopened. Earlier statements that M4 was finished mean the
  implementation sequence was committed, not that all acceptance gates passed.

### Entry blocker and exact continuation — resolved

The entry blocker recorded above was the unverified Lighthouse measurement.
It was wrong to treat it as external: NFR-010 names CI as its verification
method, and the measurement needs the production artefacts, not a hosted
reference server. `pnpm lighthouse` now runs the audit against the same
Testcontainers stack the Playwright suite uses. See "M4-003 Lighthouse
verification"; continue at TASK-M5-001 and follow section 25.6 dependency
order through TASK-M5-009.

## Current handoff correction

- Committed implementation: `c56c5fc` (M4-001), `a52a91e` (M4-002),
  `e1cd614` (M4-003). These are implementation checkpoints, not verified
  milestone acceptance. Preserve their history; fix gaps in follow-up commits.
- M4-001 gaps are now closed (see "M4-001 reconciliation" below).
- M4-002 gaps are now closed (see "M4-002 reconciliation" below).
- M4-003 gaps are now closed, including the Lighthouse ≥ 90/90/95
  measurement; see "M4-003 Lighthouse verification".
- M4-004 is implemented and committed; the earlier uncommitted draft was
  replaced.
- OpenAPI is generated into `apps/api/openapi.json` as 3.1.0 from the shared
  Zod contracts during the API build. The route source map is
  `apps/api/openapi.routes.json`; the generator and verification are recorded
  in "OpenAPI repair verification".

## Completed tasks

- TASK-M0-001 — initialized the pnpm/Turborepo monorepo, TypeScript 7.0.2
  compiler setup, ESLint 10 flat config, Prettier, Husky, lint-staged,
  commitlint, Changesets, and empty application/package shells.

- TASK-M0-002 — pinned the section 6.1 JavaScript dependency matrix across
  the root, applications, and workspace packages; fixed `@types/node` at
  `~24.13.6`; added Renovate 24.6 policy groups, release-age windows,
  security bypasses, and major-version exceptions.
- TASK-M0-003 — verified the official `caddy:2-alpine` image at Caddy
  `v2.11.4` and added a two-stage custom image with `caddy-ratelimit`.
- TASK-M0-004 — verified Remnawave panel `v3.4.4` and its official OpenAPI
  document; recorded the section 10.1 compatibility matrix and required
  v3 identifier mapping in `docs/adr/ADR-010.md`.
- TASK-M0-005 — added the NestJS/Fastify API, grammY bot, BullMQ worker, and
  Next.js/Tailwind web shells with their required local health endpoints.
- TASK-M0-006 — added Zod environment validation, section 19.6 Pino redaction,
  and exact bigint minor-unit money helpers with package-level Vitest tests.
- TASK-M0-007 — added the Prisma 7.10 schema, SQL `0001_init` migration,
  immutable-table guards, transaction guard, and initial system seeds.
- TASK-M0-008 — added multi-stage app/web Dockerfiles, Compose runtime and
  development dependencies, safe environment initialization, and `./rr`.
- TASK-M0-009 — added GitHub Actions CI for Node 24/26 quality checks,
  package tests, Turbo build, and non-publishing app/web Docker builds.
- TASK-M1-001 — added the section 17.3 settings registry and Zod schemas,
  AES-256-GCM secret envelopes, transactional Prisma repository, Redis Pub/Sub
  cache invalidation, grouped admin settings API, schema endpoint, and safe
  export/import.
- TASK-M1-002 — added Telegram user upsert, v1 channel identity creation,
  cryptographically generated referral codes, referral attribution, payload
  parsing for `ref_`, `promo_`, and `plan_`, and the internal bot endpoint.
- TASK-M1-003 — added Telegram Login Widget verification, Valkey cookie
  sessions, HS256 bot JWT issue/exchange, cookie/bearer guards, CSRF checks,
  internal token guard, and Valkey-backed Nest throttling.

## Verification

TASK-M0-001 verified on 2026-09-19:

- `pnpm install --frozen-lockfile` passed with pnpm 11.26.0.
- `pnpm test` passed: 3 repository tooling checks.
- `pnpm lint` passed with ESLint 10.10.0.
- `pnpm typecheck` passed with TypeScript 7.0.2.
- `pnpm format` passed with Prettier 3.9.8.

The supported execution environment is available: Node.js 24.21.0, pnpm
11.26.0, Docker 29.7.2, and Docker Compose v5.5.0. The initial WSL2/Docker
blocker is resolved.

## Important decisions

- The root compiler remains TypeScript 7.0.2 as required by section 6.1.
- Current `typescript-eslint` 8.70.0 rejects TypeScript 7.0.2. The shared
  `@remnaray/eslint-config` package therefore runs its parser tooling with a
  local TypeScript 6.0.3 dependency, following RISK-001's tool-only fallback;
  application code still uses the root TypeScript 7 compiler.
- `@eslint/js` is pinned to its current ESLint 10 companion version 10.0.1;
  the specification's 10.10.0 pin applies to `eslint` itself.
- pnpm added `minimumReleaseAgeExclude` entries for the pinned Turborepo,
  Node types, and intl-messageformat packages while generating the lockfile;
  these are retained so frozen installs remain reproducible with pnpm 11.26.0.
- pnpm build scripts are explicitly allowlisted in `pnpm-workspace.yaml`;
  telemetry and unused optional builds are denied. The optional native
  `cpu-features` build can report a network failure without failing install.
- Renovate validation uses the official validator; the policy keeps major
  updates behind approval, delays ordinary updates, and allows patch
  automerge only for development dependencies outside sensitive packages.
- Caddy verification on 2026-09-19: official `caddy:2-alpine` reported
  `v2.11.4 h1:XKxkMTgNSizEvKG6QHue6cAsFOteU2qA61w2tKkCWi0=` at digest
  `sha256:de23def33b17fb5d1290b0f6c2add1d70780e52341896c00a4c8a2a2fe9d355e`.
  The custom build uses `caddy:2.11.4-builder-alpine` and embeds
  `github.com/mholt/caddy-ratelimit`.
- Remnawave verification on 2026-09-19: official release `v3.4.4`, backend
  image `ghcr.io/remnawave/backend:3.4.4`, OpenAPI SHA-256
  `bebc345543b82c66ee1f956333e65cddfb8aec46099bf4427de38fb43df69396`.
  The v3 contract uses numeric `userId` values and does not expose the
  specified Telegram lookup route; ADR-010 records each affected row.
- M0-005 uses CommonJS NestJS output as required by section 6.1. The API and
  worker are inert with external services unconfigured; the BullMQ worker is
  enabled only with `RR_WORKER_ENABLED=true`, while all health routes remain
  available for local smoke checks.
- M0-006 keeps environment validation free of secret values in error messages,
  masks email as `a***@domain`, redacts all section 19.6 secret categories,
  and performs money operations with `bigint` only.
- M0-007 keeps trigger-heavy PostgreSQL behavior in hand-reviewed SQL while
  Prisma owns the typed schema/client; generation works with a safe local URL
  fallback and deployment still requires the real `DATABASE_URL`.
- M0-008 uses `pnpm` frozen installs in both image builders, rootless Node
  runtime users, read-only Compose services with `/tmp` tmpfs, and a fixed
  `172.28.0.0/16` network.

## Definition of Done review

- Section 25.9: tooling acceptance checks, tests, documentation and Changeset
  are present. No application FR, locales, OpenAPI, migration or secret
  handling changed in this infrastructure task.
- Maintainer review and hosted CI/proxy-smoke remain external gates; CI and
  proxy applications are scheduled later in M0 and are not claimed as passed.
- TASK-M0-002 acceptance checks passed: frozen install, `pnpm ls --depth 0`,
  five tests, lint, typecheck, formatting, and Renovate config validation.
- TASK-M0-003 acceptance checks passed: Docker build, runtime `caddy version`,
  runtime `http.handlers.rate_limit` module check, six tests, lint, typecheck,
  and formatting.
- TASK-M0-004 acceptance checks passed: official release/OpenAPI retrieval,
  endpoint and schema comparison, ADR-010 coverage test, seven tests, lint,
  typecheck, and formatting.
- TASK-M0-005 acceptance checks passed: frozen install, eight tests, lint,
  typecheck, formatting, Turbo build, and local HTTP 200 smoke checks for
  API, bot, worker, and web health endpoints.
- TASK-M0-006 acceptance checks passed: config/logger/money Vitest suites
  (10 tests), root tests, lint, typecheck, and formatting.
- TASK-M0-007 acceptance checks passed: Prisma generation, migration static
  tests, clean PostgreSQL 18 `migrate deploy`, seed counts, immutable ledger
  trigger check, root tests, lint, typecheck, and formatting.
- TASK-M0-008 acceptance checks passed: app/web Docker builds, Compose config,
  built-image API/web health smoke checks, development PostgreSQL/Valkey plus
  three mock health checks, ten tests, lint, typecheck, and formatting.
- TASK-M0-009 acceptance checks passed: workflow coverage test, ten root tests,
  lint, typecheck, and formatting. Hosted GitHub Actions execution remains an
  external gate.
- TASK-M1-001 acceptance checks passed: six settings unit tests, Prisma runtime
  client build, API test, lint, typecheck, formatting, and full Turbo build.
  OpenAPI includes the settings routes; no migration was needed because M0-007
  already created the complete `settings` table.
- TASK-M1-002 acceptance checks passed: ten API unit tests, root tests, lint,
  typecheck, formatting, and full Turbo build. The existing M0-007 migration
  already contains unique `users.telegram_id`, `users.referral_code`, the
  Telegram identity uniqueness constraint, and referral attribution tables.
- TASK-M1-003 acceptance checks passed: thirteen API unit tests, root tests,
  lint, typecheck, formatting, and full Turbo build. The Telegram signature
  and expiry checks cover AC-132; no migration was needed because M0-007
  already created session-independent user and admin tables.
- TASK-M1-004 — added the transactional double-entry ledger, sorted account
  row locks with `FOR UPDATE`, held-reward-aware `available()`, insufficient
  funds protection, and ledger audit reconciliation.
- TASK-M1-005 — added validated plan CRUD, public plan list caching in Valkey,
  mutation invalidation, and `PLAN_HAS_SALES` protection for sold plans.
- TASK-M1-006 — added subscription lifecycle operations, one-time trial
  eligibility, purchase activation/renewal, plan-change quote/apply, grace and
  expiry transitions, and the internal expiry pass.
- TASK-M1-007 — added the typed undici Remnawave client, Fastify in-memory
  panel mock, panel sync/reconcile service, HMAC webhook boundary, and health
  endpoint.
- TASK-M1-008 — added the shared queue contract, transactional outbox writer,
  BullMQ relay with stable job IDs, and worker two-second cron skeleton.
- TASK-M1-009 — added the PostgreSQL 18 + Valkey 9.1 Testcontainers integration
  gate covering migrations, concurrent ledger debits, trial, activation,
  renewal, and expiry.

- TASK-M2-001 — added the PaymentProvider contract and registry, invoice and
  payment-event repositories, idempotent webhook application, invoice expiry,
  polling, Idempotency-Key handling, and the payments worker queue boundary.
- TASK-M2-002 — added the deterministic `payments-mock` provider and payment
  integration fixtures.
- TASK-M2-003 — added YooKassa creation, IP allowlisting, receipts, webhooks,
  and mandatory status re-fetching.
- TASK-M2-004 — added Robokassa ResultURL signatures, `OK<InvId>` responses,
  polling boundary, and fiscal receipt serialization.
- TASK-M2-005 — added Lava invoice creation, additional-key HMAC verification,
  and status polling.
- TASK-M2-006 — added Platega transaction creation and polling-only settlement.
- TASK-M2-007 — added Crypto Pay fiat-RUB invoices and
  `crypto-pay-api-signature` verification.
- TASK-M2-008 — added Telegram Stars invoice links, precheckout support, and
  successful-payment normalization.
- TASK-M2-009 — added balance topups and purchases, sorted account locking,
  late-payment balance credit, partial refunds, and plan-change quote logic.
- TASK-M2-010 — added `ReceiptData`, fiscal settings integration, and provider
  receipt serialization with fallback email support.

- TASK-M3-001 — added the grammY middleware chain, Valkey sessions and rate
  limiting, ICU catalog loading, internal `ApiClient`, Telegram Stream webhook
  ingress with consumer groups and `XAUTOCLAIM`, polling with runner, live
  transport reconfiguration, and localized command registration.

- TASK-M3-002 — added the state-aware home menu, trial and subscription
  screens, panel link reset with a 24-hour Valkey guard, QR PNG and client
  deep-link output, plan/payment screens, balance and preset top-ups,
  referrals, language, support, notifications, and email prompt routes.
- TASK-M4-001 — added the `packages/ui` shadcn-style primitives, Radix dialog,
  CVA variants, loading/empty/error states, runtime Tailwind CSS variables,
  Zod theme schema and contrast validation, `_admin` and `manta` themes, and
  the complete Manta asset set.
- TASK-M4-002 — added password + Argon2id/TOTP admin authentication, 12-hour
  `rr_asid` sessions with CSRF tokens, five-failure lockouts, shared RBAC
  permissions, and sanitized immutable audit interception.
- TASK-M4-003 — added localized public landing and legal pages, flat ru/en
  catalog loading, next-intl locale negotiation, SEO metadata, robots/sitemap,
  and cached theme asset delivery.

## Verification correction

The M1-001..003 runtime correction added a CommonJS-compatible DB export,
shared Prisma/Valkey infrastructure, Nest dependency wiring, flat settings API
shape (`patch`, JSON schema, export/import), strict future-dated Telegram
expiry, session sliding TTL, internal network/token guards, CSRF/admin checks,
and retry-safe concurrent user upsert. Verified with a clean PostgreSQL 18
migration, API startup against PostgreSQL/Valkey, `/api/v1/health` HTTP 200,
internal token rejection outside the trusted CIDR, successful trusted internal
user/token requests, 16 API tests, root tests, lint, typecheck, formatting, and
Turbo build.

- TASK-M1-004 acceptance checks passed: 18 API tests, clean PostgreSQL
  migration/deploy, ten parallel real PostgreSQL debits of 100 from a 1000
  minor-unit balance, `available() = 0`, audit over 7 accounts with zero
  mismatches, root tests, lint, typecheck, formatting, and Turbo build. No
  migration was needed because M0-007 already created all ledger tables and
  immutable triggers.
- TASK-M1-005 acceptance checks passed: 21 API tests, real PostgreSQL/Valkey
  CRUD and public cache smoke, 60-second cache TTL, mutation invalidation,
  public filtering, deactivation filtering, and `PLAN_HAS_SALES` rejection;
  root tests, lint, typecheck, formatting, and Turbo build. No migration was
  needed because M0-007 already created `plans` and transaction plan links.
- TASK-M1-006 acceptance checks passed: 22 API tests, real PostgreSQL lifecycle
  smoke for trial, activation, renewal, quote/apply, and expiry, root tests,
  lint, typecheck, formatting, and Turbo build. No migration was needed because
  M0-007 already created the partial one-live-subscription index.
- TASK-M1-007 acceptance checks passed: SDK/mock typecheck, lint, unit tests,
  package builds, joint HTTP mock smoke (`create → getByUsername → health`),
  API typecheck/lint, and full source formatting. ADR-010 numeric panel ID
  incompatibilities remain explicitly documented for later mapping work.
- TASK-M1-008 acceptance checks passed: root tests, lint, typecheck, formatting,
  full Turbo build, and real PostgreSQL/Valkey outbox smoke: rollback left zero
  rows, committed job published to BullMQ in 34 ms.
- TASK-M1-009 acceptance checks passed: `pnpm test:m1` with fresh PostgreSQL 18
  and Valkey 9.1 containers, 10-way AC-070 concurrent debit assertion, and
  subscription lifecycle assertions. Full M1 Definition of Done checks passed:
  root tests, package/API tests, lint, typecheck, formatting, Turbo build,
  migration deploy, contract mock smoke, and runtime API smoke.

## Known blockers

- Playwright/Chromium cannot start because this host lacks `libnspr4.so`.
- The web Docker build is constrained by this machine's Docker memory/runtime.
- The app image remains above NFR-011 after removing the full pnpm store.
- M5-004 requires a public real-domain TLS stand and manual checklist.
- Hosted GitHub Actions execution and maintainer review remain external Definition of Done gates.

Local browser runs (`pnpm test:e2e`, `pnpm lighthouse`) need Chromium's system
libraries. Installing them needs root; `docs/e2e.md` documents the rootless
loader-prefix alternative, which is what this machine uses.

The `web` image cannot be built on this machine: Next.js static generation runs
out of memory inside the Docker VM, which shares the same 7.9 GB. The same
build succeeds on the host in 22.5 seconds, and the CI `docker` job builds the
image on a runner with room. See "Defects found while verifying M5-002".

## OpenAPI repair verification — 2026-09-20

- `pnpm --filter @remnaray/api build` now regenerates the artifact with
  `OpenApiGeneratorV31`; the result is OpenAPI 3.1.0 with eight shared Zod
  schemas and 128 paths.
- The new tooling test passes, as do API lint/typecheck, root lint, root and
  workspace typechecks, formatting, and the full Turbo build.
- The generated route map is kept in `apps/api/openapi.routes.json`; generated
  output is `apps/api/openapi.json`. No secret or runtime credential is used by
  generation.
- This correction is committed separately as a follow-up to the M4 handoff;
  it does not claim M4 acceptance because the reference-server Lighthouse
  gate remains unverified.

## M3-001 verification

- Context7 documentation was checked for grammY middleware/webhooks, runner,
  Redis sessions, rate limiting, auto-retry, and ICU formatting. The installed
  package API was then checked locally because ratelimiter 1.2.1 exposes the
  older `limit`/`RedisStore` contract.
- `@remnaray/i18n-core`: typecheck and 2 tests passed.
- `@remnaray/bot`: typecheck and 3 tests passed, including internal headers,
  structured API errors, and the 20 updates/10 seconds drop boundary.
- `@remnaray/api`: typecheck and 30 tests passed, including Telegram Stream
  insertion, secret validation, locale delivery, and bot config.
- The API publishes `tg:updates`; the bot uses `XACK` after successful handling
  and reclaims pending entries after 60 seconds. Settings changes for `bot.*`
  and `domain.*` reload transport and commands without restart.

## M3-002 verification

- Context7 documentation was checked for the installed QR generator's async
  `toBuffer` API; QR output is generated as a 512px PNG in the bot process.
- `@remnaray/bot`: lint, typecheck, and 5 tests passed.
- `@remnaray/api`: lint, typecheck, and 31 tests passed, including home-menu
  state data, bot config, locale delivery, and webhook stream insertion.
- The internal bot facade serializes bigint money and panel values as strings,
  enforces acting-user ownership for invoice checks, and exposes top-up,
  referral, transaction, and subscription actions through `ApiClient`.

## M2 verification

- PostgreSQL 18 integration: duplicate paid webhook produced one invoice
  transaction and two ledger entries; late payment was credited to balance;
  balance payment and partial refund assertions passed.
- Provider contract tests: 28 API tests passed, including YooKassa IP ranges,
  Robokassa signature and acknowledgement, Lava HMAC, CryptoBot signature,
  Platega polling-only behavior, and Stars successful-payment normalization.
- `pnpm test`, database migration tests, `pnpm test:m1`, and `pnpm test:m2`
  passed.
- `pnpm lint`, `pnpm typecheck`, `pnpm format`, and the full Turbo build passed.
- Migration `0002_payment_event_processing` permits only processing markers on
  payment events, fixing the immutable-event processing contract.
- OpenAPI, provider documentation, ten Changesets, and the M2 integration
  fixture are present.

## Next

Close the M5-001/M5-002/M5-004/M5-005 verification blockers, then start TASK-M5-007. Do not begin M6.

## M3 acceptance reconciliation

The initial acceptance audit identified the M4 ordering conflict and runtime
gaps. The following M3 work resolved them without rewriting history: atomic
Stream deduplication and both-transport persistence, callback acknowledgement
before limiting, settings-based token startup, API-built i18n output, the
subscription reset guard, conversations, minimal RBAC/audit, support/promo
boundaries, and the Telegram mock/e2e harness. The permitted M4 dependencies
are included in M3; M4 remains unopened.

## M3-003 verification

- Context7 documentation was checked for `@grammyjs/conversations`, including
  replay storage, filtered waits, timeout handling, and conversation exit.
- Added Valkey-backed conversation storage with a 10-minute TTL, promo,
  custom top-up, receipt email, and support-message flows, three-attempt
  validation, command cancellation, and support forwarding.
- Added internal API boundaries for promo reservation and support forwarding;
  updated OpenAPI and both locale catalogs.
- `@remnaray/bot`: lint, typecheck, 8 tests, and build passed.
- `@remnaray/api`: lint, typecheck, 31 tests, and build passed.
- i18n lint/typecheck/tests, root tooling tests (10), full Turbo build, and
  Prettier passed.

## M3-004 verification

- Added `403` Telegram error handling that marks `users.bot_blocked_at`,
  suppresses delivery errors, and sends an eight-character incident code for
  handler failures. Added the unblocked endpoint used by `/start` flows.
- `autoRetry` remains the 429 retry boundary; outgoing message methods now use
  a serialized transformer with 30 messages/second global and 1 message/second
  per-chat spacing.
- `@remnaray/bot`: lint, typecheck, and 10 tests passed.
- `@remnaray/api`: lint, typecheck, and 31 tests passed.

## M3-005 verification

- Added the agreed minimal M4 dependency: bot-admin role checks for active
  `admin`/`operator` records, user lookup, daily stats, broadcast status, and
  `/admin_extend` with a zero-value adjustment transaction and immutable
  `audit_log` row using `reason='bot-admin'`.
- `@remnaray/api`: lint, typecheck, and 32 tests passed, including the audit
  assertion. `@remnaray/bot`: lint, typecheck, and 10 tests passed.

- TASK-M3-006 — added the HTTP Telegram Bot API mock with update injection,
  webhook/polling methods, message/payment/callback methods, and 403/429
  injection; added the first E2E-01 grammY interaction.

## M3-006 verification

- `@remnaray/telegram-mock`: lint, typecheck, and 3 tests passed, including
  getMe, webhook/update/sendMessage, 429 injection, and `/start` handling.
- The full Turbo build, root tooling tests, and formatting passed after the
  mock was added.

## M3 Definition of Done reconciliation

- All six M3 tasks have commits and task-level checks. The minimal RBAC/audit
  and referral/support dependencies explicitly permitted by the user were
  implemented inside M3.
- Hosted CI, maintainer review, live provider credentials, and proxy-smoke are
  external gates. M3 is complete and M4 is now active.

## M4-001 verification

- Context7 documentation was checked for Tailwind v4 `@theme inline`, React 19
  refs, Radix Dialog, CVA variants, and Zod 4 schemas.
- `pnpm theme-validate themes/manta` and `_admin` passed. The authoritative
  Manta palette reports the specified 3.03:1 primary/white pair as a warning;
  schema and asset validation still pass per section 18.3.
- Theme-schema tests: 3 passed. UI tests: 2 passed. Both package typechecks
  and lint passed; web typecheck and production build passed.
- Root `pnpm test` passed (10 tooling tests), `pnpm lint`, `pnpm typecheck`,
  `pnpm format`, and full `pnpm build` passed. Frozen install passed after the
  workspace lockfile update.
- Added `docs/theming.md` and `.changeset/m4-001-ui-theme.md`. No API routes,
  OpenAPI contract, or database migration changed in this task.

## M4-001 decisions

- `theme.json` remains the data source; `@remnaray/theme-schema` exports the
  runtime parser, CSS variable projection, and WCAG contrast helpers.
- `packages/ui` follows ADR-008 with Tailwind class composition, CVA variants,
  Radix Dialog accessibility, and reusable Skeleton/EmptyState/ErrorState
  components.
- The server layout emits validated Manta tokens and dark-mode variables;
  Tailwind v4 maps them with `@theme inline`, so a theme switch does not need
  a rebuild.
- The generated Manta OG asset is stored at 1200×630, with the required bot
  avatar at 512×512 and Apple touch icon at 180×180.

## M4-002 verification

- Context7 documentation was checked for Argon2id options, OTPAuth TOTP/URI
  handling, NestJS metadata/interceptors, and Prisma transactional writes.
- Added 2 domain RBAC tests, 3 admin API auth/audit/RBAC test files covering
  the fifth-failure `423` lock, TOTP enrollment, session creation, role and
  permission checks, and secret masking. API suite: 37 tests passed.
- `@remnaray/domain` and `@remnaray/api` lint/typecheck passed. OpenAPI now
  includes the admin auth routes; no migration was needed because M0-007
  already created `admins` and immutable `audit_log`.
- Added `docs/admin.md` and `.changeset/m4-002-admin-auth.md`. Password and
  TOTP secrets are encrypted or masked and are not written to audit rows.

## M4-003 verification

- Context7 documentation was checked for next-intl routing, request config,
  server translations, Next.js metadata, robots/sitemap, and Next 16 root
  parameters.
- `pnpm i18n-check` passed for 2 locales and 10 namespaces. Web lint,
  typecheck, production build, and the legal Markdown test passed. The build
  prerenders `/ru`, `/en`, all six localized legal routes, robots, and sitemap.
- Added `.changeset/m4-003-public-web.md`, `docs/i18n.md`, and the public web
  route set. No database migration or API route was required; public plans
  are read from the existing `GET /api/v1/public/plans` boundary.

## M4-001 reconciliation

Verified on 2026-09-20.

- `packages/ui` now exports the complete section 14.4 list: Button, Input,
  Select, Dialog, Sheet, Table, Tabs, Badge, Toast, Form (react-hook-form +
  zod), DataTable (cursor), MoneyInput, DateRangePicker, Stat, EmptyState,
  ErrorState, Skeleton, ConfirmDialog(reason). A test asserts the export list
  and renders the cursor table in loading/empty/error/ready states with
  `react-dom/server`.
- AA acceptance is now a hard gate: `contrastFailures()` fails the body-text
  pairs from section 13.5 and `pnpm theme-validate` exits non-zero on them. The
  section 18.3 warnings (including the specified 3.03:1 Manta primary/white
  pair) stay warnings.
- Themes load through `ThemeService` in `apps/api`: mounted directory scan,
  Zod validation, fingerprinted asset URLs, `ETag` plus `Cache-Control:
max-age=60` on `GET /api/v1/public/theme`, `GET /api/admin/v1/themes` rescan,
  and a `rr:theme.changed` subscription. `apps/web` reads those tokens per
  request with a five-second revalidation window (AC-181) and falls back to the
  bundled manifest only when the API is unreachable.
- Fixed a runtime defect found during this work: `@remnaray/domain` and
  `@remnaray/theme-schema` had no `dist` build and no `require`-resolvable
  export condition, so the compiled CommonJS API could not load
  `@remnaray/domain/rbac` at all (`ERR_PACKAGE_PATH_NOT_EXPORTED`). Both now
  build to `dist` like the other workspace packages; `@remnaray/payments-mock`
  gained the missing `default` condition.
- Added `packages/domain/client.ts` — the single typed fetch + Zod client
  required by section 13.1 — with the section 9.3 error envelope.
- `compose.yaml` now mounts `./themes:/themes:ro` and `./locales:/locales:ro`
  into the app services and web, with `RR_THEMES_DIR`/`RR_LOCALES_DIR`.
- Checks: ui 8 tests, theme-schema 5 tests, api 42 tests, all workspace tests,
  `pnpm lint`, `pnpm typecheck`, `pnpm format`, full `pnpm build`, and
  `pnpm theme-validate` for `themes/manta` and `themes/_admin`.

## M4-002 reconciliation

Verified on 2026-09-20.

- AC-143: `AdminsService` adds the FR-143 CRUD (`GET/POST /api/admin/v1/admins`,
  `PATCH /:id`, `/:id/reset-password`, `/:id/reset-totp`, `/:id/deactivate`).
  Deactivating or demoting the last active `admin` answers `409 LAST_ADMIN`.
  The survivor check runs inside the update transaction and locks the remaining
  admin rows with `SELECT … FOR UPDATE`. Seven tests cover it, including
  inactive and soft-deleted rows.
- AC-144: `AuditInterceptor` now records the prior state the handler read.
  Handlers return `Audited(before, after, body?)`; the interceptor writes both
  sides, copies only `reason` from the request body, masks secrets and truncates
  states above 16 KB.
- RBAC metadata now covers every admin route that exists: settings
  (`settings.read`/`settings.write`), plans (`plans.read`/`plans.write`),
  themes (`themes.read`) and admins (`admins.write` + `@Roles('admin')`). The
  hardcoded settings role check in `AuthGuard` was removed in favour of the
  decorators. The matrix itself gained `legal.read`, `themes.read` and
  `audit.read.self` so the section 14.2 operator row is represented exactly,
  plus `operatorLimits`/`limitKeyFor` for the `@Limit` work in TASK-M4-005.
- CSRF no longer exempts `/api/admin/v1/auth/*`. Login and TOTP have no session
  yet and are checked by origin and `X-Requested-With`; once a session exists,
  `X-CSRF-Token` is required too.
- The password failure counter is incremented by the database, the TOTP
  enrolment secret is encrypted with `RR_APP_KEY` before it reaches Valkey, and
  the login challenge `DEL` is the atomic commit point for issuing a session.
- Checks: api 56 tests (17 files), domain 5 tests, all workspace tests,
  `pnpm lint`, `pnpm typecheck`, `pnpm format`, full `pnpm build`.
- The settings import diff and the section 17.6 reaction matrix were completed
  in TASK-M4-009.

## M4-003 reconciliation

Verified on 2026-09-20.

- Locales are data again. The bot catalog moved out of TypeScript into
  `locales/{ru,en}/bot.json` and `notify.json`; `@remnaray/i18n-core` now reads
  the mounted directory and no process ships a compiled-in copy.
- Added `I18nService`: `locale_overrides` → `<lang>` file → `en` file → key,
  cached in Valkey under `rr:i18n:<lang>:<ns>` and dropped on
  `rr:i18n.changed`. It serves `GET /api/v1/public/i18n/:lang/:namespace` with
  an ETag and backs `GET /api/internal/v1/i18n/:lang` and the bot command
  descriptions.
- Added `GET /api/v1/public/config`, `GET /api/v1/public/legal/:doc?lang=` with
  `{brand}`/`{domain}`/`{support}` substitution, and `GET /api/v1/r/:code`
  plus the web `/r/[code]` handler, both storing `rr_ref` for 30 days.
- `GET /api/v1/public/plans` now returns the `PlanPublic` projection only;
  squads and internal flags no longer leak.
- Russian copy is real Russian. Landing, common, SEO, error and legal catalogs
  were rewritten in both languages, and the legal documents are complete.
- The landing follows section 13.2: brand and theme from the API, plans hidden
  when the list is empty or fails, features/steps/clients/FAQ from the catalog,
  CTA to `t.me/<bot>` plus the Login Widget, footer with legal links, support
  contact, language switcher and the `hide_powered_by` attribution.
- Money is formatted with `formatMoneyLocale`, which builds the decimal string
  from exact minor units before handing it to `Intl`.
- `pnpm i18n-check` now verifies ICU compilation, placeholder parity, array and
  object leaves, untranslated Russian copy and the legal documents.
- The site reads config, catalogs and theme with a five-second revalidation
  window, so AC-181 holds for the site side.
- Fixed workspace typechecks that had never run: `@remnaray/config` and
  `@remnaray/logger` were CommonJS packages compiled under `verbatimModuleSyntax`,
  and three shell packages failed on TS18003.
- Checks: api 69 tests (19 files), workspace tests, `pnpm lint`,
  `pnpm -r typecheck`, `pnpm format`, full `pnpm build`, `pnpm i18n-check`,
  `pnpm theme-validate`, and a CommonJS load of the compiled `AppModule`.
- Remaining external gate: Lighthouse ≥ 90/90/95 on the reference server.

## M4-004 verification

Verified on 2026-09-20.

- Added `MeService` with every section 9.4 `me/*` operation, exposed twice:
  `/api/v1/me/*` resolves the user from `rr_sid`, `/api/internal/v1/me/*` from
  `X-Acting-User` (section 9.5). The duplicated bot-only implementation was
  removed, as were the legacy `/api/v1/me/subscription/change/*` routes that
  section 9.4 does not define.
- Money crosses the public API as JSON numbers, `PlanPublic` is the only plan
  shape, transactions and referral lists are cursor-paginated, referral names are
  masked, promo codes follow the section 15.5 rules, and AC-061 hides a provider
  whose last healthcheck failed.
- Added `GET /me/subscription/qr` (512×512 PNG), `GET/DELETE
/me/subscription/devices`, `POST /me/invoices/:id/cancel`,
  `GET /me/plan-change/quote` and `POST /me/anonymize-request` (section 19.5
  records the request in `audit_log`; the admin alert belongs to TASK-M4-007).
- Fixed `POST /api/internal/v1/support/forward`, which the bot had been calling
  at a path the API never served.
- Web: all seven section 13.4 pages plus `/pay/[invoiceId]`, the Telegram Login
  Widget and `/auth/tg`. `useResource` caches reads for 15 seconds and mutations
  invalidate instead of applying optimistically.
- AC-133: `apps/web/test/account-pages.test.tsx` renders each page against a
  mocked API and asserts loading, empty and error, including the localized error
  message and the `requestId`. AC-134: `apps/web/test/pay-page.test.tsx` covers
  the three-second polling window, the countdown, Stars deep links, the paid and
  expired states and the error state.
- Checks: api 81 tests (20 files), web 13 tests (3 files), bot 10 tests, all
  workspace tests, `pnpm lint`, `pnpm -r typecheck`, `pnpm format`, full
  `pnpm build`, `pnpm i18n-check`.

## M4-005 verification

Verified on 2026-09-20.

- Added the section 9.6 admin API this task covers: dashboard overview, daily
  series and the requires-attention counters; user search, card and every FR-141
  action; subscriptions with bulk extension; invoices with masked provider
  events, recheck, transactions and refund; plan reorder. Every mutation returns
  `Audited`, so the interceptor records the prior state.
- Section 14.2 limits are enforced server-side: an operator cannot debit a
  balance, bulk-extend, anonymize or write plans, and their daily credit total is
  capped by `settings.operator.max_credit_minor`.
- Added `/admin` with the `_admin` theme and no locale prefix: login with TOTP
  enrolment, dashboard with Recharts revenue and registration charts, users list
  and card with reason modals, subscriptions with selection and bulk extension,
  payments with the event viewer and refund, and plan management with ordering.
- AC-142: `test/m4.admin.integration.test.mjs` recomputes revenue, payments, new
  users, trials, active subscriptions, balance liability and referral rewards
  with an independent SQL control on PostgreSQL 18 fixtures and compares them to
  the service output; the daily series sums back to the same totals. The same
  test covers AC-140 search by Telegram id, username and status, and AC-141
  audited extend, balance and anonymize actions.
- Checks: api 91 tests (22 files), web 18 tests (4 files), `pnpm test:m4`,
  workspace tests, `pnpm lint`, `pnpm -r typecheck`, `pnpm format`, full
  `pnpm build`, `pnpm i18n-check`.

## M4-006 verification

Verified on 2026-09-20.

- Added the section 15.2 accrual engine, running inside the payment
  transaction: source filters, the three modes, the daily cap with an
  administrator alert, idempotency on `source_transaction_id`, holds, the
  invitee bonus and the `maintenance.referral-release` endpoint.
- Refunding a source reverses the reward, fully or proportionally rounded down,
  and administrators can reverse manually from `/admin/referrals`.
- Section 15.3 attribution now also works from the site: `POST
/api/v1/auth/telegram` turns the `rr_ref` cookie into a `ref_<code>` start
  payload, and the sign-up invitee bonus is granted when the trigger says so.
- Section 15.5 promo codes reserve their slot under `SELECT … FOR UPDATE` on the
  promo code row before the invoice exists, so `max_uses` can never be oversold;
  the reservation carries the discount onto the invoice and settles to `applied`
  with `used_count + 1` on payment, or is released on cancel/underpay/failure.
- Added the admin promo code screen (create, batch generation, CSV export,
  soft delete) and the referral screen (programme form, accrual list, reversal),
  both hidden for roles without the permission.
- AC-152, AC-153 and AC-155 are covered by
  `test/m4.rewards.integration.test.mjs` on PostgreSQL 18; the test also asserts
  that held rewards are not spendable through `ledger.available()`.
- Checks: api 91 tests, web 18 tests, workspace tests, `pnpm lint`,
  `pnpm -r typecheck`, `pnpm format`, full `pnpm build`, `pnpm i18n-check`, and
  the M1, M2 and M4 integration gates.

## M4-007 verification

Verified on 2026-09-20.

- Added `NotifyService` with the complete section 16.1 event table, section 16.2
  delivery rules and the `notify.scan-expiring` cron. Emitters write outbox jobs
  inside the transaction that caused the change, so a notification cannot exist
  without its cause.
- `notification_log` is immutable, so a row is written once with its final
  status; a short Valkey lock on the dedup key serialises concurrent workers and
  the unique index is the backstop. Migration `0003_notification_log_status`
  adds the `skipped` status section 16.2 needs for a banned recipient.
- Administrator alerts deliver to every active admin with a Telegram id in
  `settings.admin.language` and deduplicate on `rr:alert:<type>` for an hour.
  `payment.late`, `payment.underpaid` and `referral.daily_cap` already emit.
- The worker now consumes the `notify`, `panel` and `maintenance` queues as well
  as `payments`, and ticks the expiry scan and referral release every ten
  minutes. Added `POST /api/internal/v1/remnawave/sync-user`, which the
  `panel.sync-user` jobs had been queued against with no consumer.
- AC-160 and AC-163 are covered by `test/m4.notify.integration.test.mjs` on
  PostgreSQL 18, plus five `NotifyService` unit tests.
- Checks: api 96 tests, workspace tests, `pnpm lint`, `pnpm -r typecheck`,
  `pnpm format`, full `pnpm build`, `pnpm i18n-check`, and the M1, M2 and M4
  integration gates after the new migration.

## M4-008 verification

Verified on 2026-09-20.

- Added `packages/domain/segment.ts`: the section 16.3 DSL compiles to a plan
  the repository executes, with all ten operators and `now±Nd/h` relative dates
  covered by tests. A segment can never widen the mandatory exclusions.
- Added the editor contract: one text per language, at most four buttons of the
  three supported kinds, an optional photo, the four placeholders, and Telegram
  HTML validation that rejects any tag outside the section 16.3 list.
- `start` materializes the audience once as `pending` deliveries (migration
  `0004_broadcast_delivery_pending`) and queues chunks of 500. Chunks skip
  non-pending deliveries, throttle at 25 messages per second with
  `concurrency: 1`, re-read the status every 50 messages, mark `403` as blocked
  with `users.bot_blocked_at`, and back off on `429`.
- Added the admin screen with presets, segment preview, test-on-myself,
  start/pause/resume/cancel and the failures CSV.
- AC-161 is covered by `test/m4.broadcast.integration.test.mjs`: a run is paused
  mid-way, resumed, and every recipient receives exactly one message; blocked,
  opted-out and anonymized users never enter the audience.
- Checks: api 101 tests, domain 12 tests, workspace tests, `pnpm lint`,
  `pnpm -r typecheck`, `pnpm format`, full `pnpm build`, `pnpm i18n-check`, and
  the M4 broadcast and notification integration gates.

## M4-009 verification

Verified on 2026-09-20.

- AC-061: `GET /api/admin/v1/providers` reports `offeredToUsers` as
  `enabled && lastHealthcheckOk === true`, and `GET /api/v1/me/payment-methods`
  now uses the same rule, so a provider that was never checked or failed its
  last check is never offered. Saving a provider configuration runs a
  healthcheck immediately. Five `ProvidersService` tests cover it.
- AC-181: `PUT /settings` publishes the section 17.6 channels for the changed
  keys and answers with `applied`, `restartRequired` and `reconfigured`. The
  site revalidates config, catalogs and theme every five seconds and the bot
  caches catalogs for sixty seconds, dropping them immediately on
  `rr:i18n.changed`. Both windows are asserted by tests.
- AC-146: `GET /api/admin/v1/system` reports version, images, last panel
  reconciliation, outbox depth, database size, bot mode, TLS and backup markers
  and the health endpoint; `GET /system/queues` plus `retry-failed` complete the
  page.
- Added panel, bot, theme, locale and legal administration, the action journal
  with the operator-only scope, and the administrators screen on top of the
  FR-143 API from TASK-M4-002.
- `POST /settings/import` now returns a real diff for `dryRun`, and every value
  patched into `locale_overrides` is ICU-compiled before it is stored.
- Checks: api 109 tests, bot 12 tests, web 19 tests, workspace tests,
  `pnpm lint`, `pnpm -r typecheck`, `pnpm format`, full `pnpm build`,
  `pnpm i18n-check`.

## M4-003 decisions

- The current Next.js 16 `proxy.ts` convention is used for next-intl locale
  negotiation; it replaces the deprecated `middleware.ts` filename while
  preserving the specification’s middleware behavior.
- Flat catalog files are expanded into nested runtime messages only at the
  web request boundary, preserving the specification’s dotted-key data format.

## M4-010 verification

Verified on 2026-09-20.

- `pnpm test:e2e` builds the workspace and runs 25 Playwright tests against a
  real stack: PostgreSQL 18 and Valkey 9.1 in Testcontainers, the API from
  `dist`, the site from its standalone build, and a reverse proxy that serves
  both from one origin exactly as nginx or Caddy do in a deployment
  (`e2e/setup/stack.mjs`). All 25 pass in under a minute.
- The coverage follows the section 22.1 E2E row. Site: landing brand, plan and
  call-to-actions, the language switch, legal pages, robots and sitemap, the
  public API, the `/r/<code>` referral cookie. Account: the anonymous redirect,
  the `/auth/tg` sign-in the bot performs, the empty subscription state, the
  plan list with providers and the promo field, balance and history, saving
  settings, sign-out, and a purchase with the `mock` provider that the provider
  confirms with its signed webhook. Administration: a wrong password, the
  password + TOTP flow, the dashboard widgets and charts, user search and the
  card, the journal, creating a plan, the AC-061 provider gate, the system page,
  a forged mutation and one with a wrong CSRF token, and `Disallow: /admin`.
- An administrator TOTP code may be redeemed once, so the suite signs in once in
  a `setup` project and the administration specs reuse that `storageState`.
- CI gained an `e2e` job after `quality`: `pnpm typecheck:e2e`, Chromium with
  its system dependencies, `pnpm test:e2e`, and the `test-results` artifact on
  failure. `docs/e2e.md` documents the harness and the rootless local run.
- Defects the suite found, each fixed in this task:
  - Next.js 16 rejects a local `next/image` source carrying a query string
    unless `images.localPatterns` allows the path. Section 18.2 serves theme
    assets as `/themes/<slug>/<asset>?v=<version>`, so every landing render
    after the build threw and the site kept serving its build-time fallback —
    which also broke the AC-181 five-second window on the live site.
    `apps/web/next.config.ts` now declares the patterns and a web test guards
    them.
  - `GET /api/v1/me` was declared by both `AuthController` and `MeController`,
    so Fastify refused to start with `FST_ERR_DUPLICATED_ROUTE`. The duplicate
    route and the service method it used are removed.
  - `RbacGuard` was registered only through `APP_GUARD`, so the administration
    module could not export it (`UnknownExportException`).
  - `/auth/tg` and `/r/<code>` built an absolute redirect from the request URL,
    which leaks the internal host behind a reverse proxy. Both now answer with a
    relative `Location`.
- Checks: 25 Playwright tests, `pnpm lint`, `pnpm typecheck`,
  `pnpm typecheck:e2e`, `pnpm -r typecheck`, `pnpm test` (10),
  `pnpm -r test` (api 109, web 20, bot 12, ui 8 and the remaining packages),
  `pnpm format`, full `pnpm build`, `pnpm i18n-check` (1264 messages),
  `pnpm theme-validate` for `manta` and `_admin`.

## M4 Definition of Done review

Section 25.9, reviewed on 2026-09-20 for TASK-M4-001 … TASK-M4-010.

1. Conventions and gates: `pnpm lint`, `pnpm typecheck`, `pnpm -r typecheck`
   and `pnpm typecheck:e2e` are green.
2. Tests: unit and component tests per package, Testcontainers integration
   suites (`test/m4.*.integration.test.mjs`) and the Playwright E2E suite. No
   coverage threshold was lowered.
3. Acceptance criteria with an executing test: AC-130 and AC-136 (M4-003),
   AC-133 and AC-134 (M4-004), AC-140 … AC-142 (M4-005), AC-143 and AC-144
   (M4-002), AC-150 … AC-156 (M4-006), AC-160 and AC-163 (M4-007), AC-161
   (M4-008), AC-061, AC-146 and AC-181 (M4-009), the section 22.1 E2E row
   (M4-010), and `theme-validate` with the AA contrast check (M4-001).
4. Locales: every key exists in `ru` and `en`; `pnpm i18n-check` is green.
5. OpenAPI: `apps/api/openapi.json` covers the M4 routes and is generated as
   a 3.1.0 document from the shared Zod contracts during the API build; see
   "OpenAPI repair verification".
6. Migrations: `0003_notification_log_status` and
   `0004_broadcast_delivery_pending` carry the `reversible` header and are
   applied from scratch by every integration run.
7. Documentation: `docs/theming.md`, `docs/admin.md`, `docs/i18n.md`,
   `docs/account.md`, `docs/rewards.md`, `docs/notifications.md`,
   `docs/broadcasts.md` and `docs/e2e.md`.
8. Changesets: one per task, `m4-001-*` … `m4-010-e2e`.
9. Secrets: the section 19.6 redaction tests pass and `Audited` never writes a
   secret value into `audit_log`; provider and panel credentials are stored in
   AES-256-GCM envelopes.
10. External gates that remain outside this repository's control: maintainer
    review, a full CI run on the hosted runners and the `proxy-smoke` job for
    both profiles (its templates land with M5). The Lighthouse ≥ 90/90/95
    measurement for M4-003 is no longer external; see the section below.

## M4-003 Lighthouse verification — historical result, not reproduced

The prior session recorded this as verified. In this reconciliation,
`pnpm lighthouse` built successfully but failed with
`ECONNREFUSED 127.0.0.1:39185`; retain the prior measurement as historical
evidence only until the runtime is available and the command passes again.

- `pnpm lighthouse` (`tools/lighthouse-check.mjs`) boots the Playwright
  harness stack — PostgreSQL 18 and Valkey 9.1 in Testcontainers, the API from
  `dist`, the site from its standalone build, one reverse proxy in front of
  both — and audits it with the official Lighthouse desktop preset. NFR-010
  names CI as its verification method, so a `lighthouse` job runs it after
  `quality` and always uploads `test-results/lighthouse`.
- The account audit enters through `/auth/tg?token=<jwt>`, the way the bot's
  «Открыть кабинет» button does. Lighthouse clears storage before it navigates,
  so a cookie set up front would not survive; the run fails if the navigation
  does not end on `/<locale>/account`.
- Context7 resolved `/googlechrome/lighthouse` and `/radix-ui/primitives`; the
  programmatic `lighthouse(url, flags, config)` call, the desktop config export
  and the Slot `asChild` contract were implemented from that documentation.
- First measurement: performance 100, accessibility **85**, SEO 100. Four axe
  audits failed, three of them real markup defects:
  - Every "link that looks like a button" rendered a `<button>` inside an `<a>`
    or a `<Link>`, which fails `target-size` and nests two interactive
    elements. `Button` gained `asChild` (Radix `Slot`) and the fourteen call
    sites in the site, the account and the administration console now render a
    single element.
  - The Telegram login container carried `aria-label` on a plain `<div>`
    (`aria-prohibited-attr`); it is now `role="group"`.
  - The widget script injects its `<iframe>` next to the `<script>` Next.js
    appends to `document.body`, without a title (`frame-title`). A
    `MutationObserver` names `iframe[id^="telegram-login-"]` as it appears.
  - `color-contrast` stays: the Manta teal and white brand pairing the
    specification fixes in section 18.1 is 3.03:1, which `theme-validate`
    reports as a warning for the same reason. The palette is specified data and
    was not changed.
- Final measurement: landing `ru` and `en` performance 100, accessibility 96,
  SEO 100; the signed-in account accessibility 96. Section 13.2 requires
  90/90/95.
- Two Playwright assertions named the old roles (`button` «Выбрать тариф» and
  «Открыть»); both now assert `link`, which is what the corrected markup
  renders.
- Checks: `pnpm lighthouse`, `pnpm test:e2e` (25), `pnpm lint`,
  `pnpm typecheck`, `pnpm -r typecheck`, `pnpm typecheck:e2e`, `pnpm test`
  (11), `pnpm -r test` (api 109, web 22, bot 12, ui 8 and the remaining
  packages), `pnpm format`, full `pnpm build`, `pnpm i18n-check` (1264
  messages), `pnpm theme-validate` for `manta` and `_admin`.

### M4-003 Lighthouse decisions

- `chrome-launcher` rewrites its profile directory into a Windows path when it
  detects WSL, and a Linux Chrome then creates that literal name in the working
  directory. The tool passes `userDataDir: false` and its own
  `--user-data-dir`, so the profile always lands in the system temp directory.
- The browser is `CHROME_PATH` if set, otherwise Playwright's Chromium, so the
  rootless loader-prefix workaround in `docs/e2e.md` covers this command too.

## M5-001 reconciliation

Implemented during reconciliation; verification is blocked by the host browser runtime.

- `apps/api/src/modules/setup/` implements `/api/setup/v1/*`: `state`, `token`,
  `steps/:step` for the seven writing steps, the three «Проверить» routes
  (`check/panel`, `check/bot`, `check/provider`) and `finish`. Every step
  validates on the server with its own Zod schema and writes straight into
  `settings` and the target tables.
- `SetupGuard` is registered as an `APP_GUARD` from a module imported before
  `AuthModule`, so a request made before the wizard finishes answers
  `SETUP_NOT_COMPLETED` 503 rather than `UNAUTHENTICATED`. `/api/setup/*` and
  `/api/v1/health*` stay open, which keeps the Compose healthcheck green and
  lets the bot wait instead of crash-looping (section 17.5). Once
  `setup.completed` is true the wizard answers `SETUP_ALREADY_COMPLETED` 404.
- Step 0 compares the submitted token with `argon2(RR_SETUP_TOKEN)`, stored in
  `setup_state.token_hash` on the first success, and blocks an address for
  fifteen minutes after five wrong attempts. It answers with `rr_setup`, a
  one-hour session that slides with every step.
- Step 1 is posted twice: without `code` the server generates the TOTP secret,
  keeps it encrypted in the wizard session and answers with the QR; with `code`
  it confirms and creates the administrator. An abandoned wizard therefore
  leaves no half-made account.
- `GET /state` serves the draft only to a wizard session. The draft names the
  domain, the panel and the brand, so an anonymous caller only learns which
  step to show. Secrets are never in the draft: they go into their encrypted
  columns when their step is submitted and the draft records `tokenSet: true`.
- `finish` requires every step but payments, flips `setup.completed`, marks
  `setup_state`, queues `panel.reconcile-all` through the outbox and publishes
  `rr:bot.reconfigure`, `rr:theme.changed` and `rr:i18n.changed`. The bot
  process owns `setWebhook`/`setMyCommands`, and its two-second reconcile loop
  picks the channel up; the administrators get the `setup.completed` alert.
- `apps/web/app/setup/` serves the eight-step UI on the `_admin` theme and
  answers 404 once the API says the wizard is closed. `apps/web/proxy.ts`
  redirects every path to `/setup` while it is pending, caching the answer for
  five seconds and permanently once the setup is done.
- AC-171: `e2e/specs/setup.spec.ts` walks E2E-02 steps 4–11 against a second
  stack whose database is empty and whose `RR_SETUP_TOKEN` is set, with the
  Remnawave and Telegram mocks behind the panel and bot checks, and ends on the
  404 for `/setup` and for the wizard API plus a 200 from the shop's public API.
- Checks: `pnpm test:e2e` (26), `pnpm lint`, `pnpm typecheck`,
  `pnpm -r typecheck`, `pnpm typecheck:e2e`, `pnpm test`, `pnpm -r test`
  (api 121, web 22, bot 12, ui 8 and the remaining packages), `pnpm format`,
  full `pnpm build`, `pnpm i18n-check` (1472 messages), `pnpm theme-validate`.

### M5-001 decisions

- The section 17.4 table gives step 1 two server interactions but one route.
  Both go to `POST /steps/1`; the presence of `code` selects enrolment or
  confirmation, so the documented route shape is kept.
- The «Проверить» buttons are separate `check/*` routes rather than steps, so a
  check never writes. Step 3 re-runs the panel check before it saves, and step 7
  healthchecks every provider it stores, which is what AC-061 needs.
- `PlansService.create` parses its own input and `planInputSchema` transforms
  the money fields into `bigint`, so the wizard hands it the untouched body and
  keeps the parsed copy only for the slug and the draft. A regression test
  covers it.
- The wizard's own e2e stack is a second `startStack({ seed: false })` rather
  than a mutation of the shared one: the section 22.1 specs need a shop whose
  setup is finished, and AC-171 needs one whose setup has not run. The main
  stack now seeds `setup.completed = true` for the same reason.
- `@remnaray/telegram-mock` gained the `tsconfig.build.json` and `build` script
  `@remnaray/remnawave-mock` already had, so the e2e harness can load it from
  `dist` the way it loads the panel mock.

### M5-001 repaired gap — the step 5 logo upload

The previously recorded missing PNG/SVG upload is now implemented. `RR_THEME_UPLOAD`
gates the setup upload route, the persistent `uploads:/uploads` volume stores
`themes/<slug>/overrides/logo.{png,svg}`, and `ThemeService` resolves the
override ahead of the shipped asset. The web route and bot asset lookup use the
same resolution. The admin archive endpoint validates a complete uploaded theme.
Fresh E2E verification is still blocked by the missing Chromium host library.

## M5-002 reconciliation

Proxy acceptance passed; the task remains incomplete because NFR-011 is not met and the Docker web-image gate is blocked.

- `deploy/proxy/nginx/Dockerfile` is `nginx:1.30-alpine` plus
  `nginx-module-acme`, both pinned. Verified against nginx.org on 2026-09-20:
  the Alpine v3.24 repository publishes `nginx-module-acme-1.30.5.0.4.1-r1`,
  which is the build for the `nginx/1.30.5` the base image carries, and the
  base image already ships nginx.org's signing key in `/etc/apk/keys`. The
  Dockerfile asserts `ngx_http_acme_module.so` exists, so a base image that
  moves ahead of the module fails the build.
- `deploy/proxy/nginx/` carries the whole section 21.3 configuration:
  `nginx.conf.tmpl`, `site.conf.tmpl`, the HTTP-only `site-bootstrap.conf.tmpl`,
  `tls-{acme,certbot,custom}.inc.tmpl`, `tls-cert-{acme,certbot,custom}.inc.tmpl`,
  and the verbatim `ratelimits.inc`, `security-headers.inc` and
  `common-proxy.inc`. `custom.d/` is the documented extension point and is
  copied through without ever being rewritten.
- `apps/api/src/tools/render-proxy.ts` renders them from `settings.domain.*`,
  `settings.admin.ip_allowlist` and `.env`, writes `tmp` + `rename` and, with
  `--watch`, re-renders on `rr:settings.changed` and publishes
  `rr:proxy.reload` only when the output actually changed.
- `apps/api/src/tools/proxy-reloader.ts` talks to the Engine API over the
  read-only docker socket, runs `nginx -t` before `nginx -s reload`, and reports
  every apply to the new `POST /api/internal/v1/system/proxy-reload-result`,
  which writes `audit_log(action=proxy.reload)` and raises `proxy.config_invalid`
  on a refusal. It also watches certbot's `/etc/letsencrypt/.renewed` flag.
- Compose gained `proxy-config`, `proxy-nginx` and `proxy-reloader` under the
  `nginx`/`caddy` profiles with the section 21.1 volumes, and `./rr` now reads
  `RR_PROXY_PROFILE`/`RR_TLS_MODE` from `.env` so one command starts a profile
  (NFR-013), plus `proxy:render` and `proxy:reload`.
- Acceptance: `pnpm test:m5` builds the image, asserts the module is in it,
  renders `acme`, `certbot` and `custom` and runs `nginx -t` on each — all three
  pass — then changes `settings.domain.main` and measures the reload. It took
  **1277 ms** against a fifteen-second budget. A `proxy` CI job runs it, and the
  nginx image joined the CI docker matrix.
- Checks: `pnpm test:m5`, `pnpm lint`, `pnpm typecheck`, `pnpm -r typecheck`,
  `pnpm typecheck:e2e`, `pnpm test` (11), `pnpm -r test` (api 131, web 22,
  bot 12, ui 8 and the remaining packages), `pnpm test:e2e` (26), `pnpm format`,
  full `pnpm build`, `pnpm i18n-check` (1476 messages),
  `docker compose --profile nginx config`, the nginx image build with its
  module assertion, and the app image build including a runtime check that
  `dist/tools` resolves its modules through the symlink. The web image build is
  recorded below as blocked by this machine's memory.

### M5-002 decisions

- The deployment tools live in `apps/api/src/tools/` so they are built with the
  API and share its `node_modules`; the runtime image links
  `dist/tools -> apps/api/tools`, so section 21.1's documented
  `node dist/tools/render-proxy.js` command works unchanged and Node still
  resolves modules next to the real files.
- `nginx -t` loads the certificate files, so the `certbot` and `custom` modes
  cannot be validated without one. The acceptance test mounts a throwaway
  self-signed pair at both documented paths; `acme` needs none because the
  module serves the certificate through variables.
- OCSP stapling is rendered for the `certbot` mode only. Section 21.3 puts it
  in the shared server block, but the ACME module's `$acme_certificate`
  variables do not support stapling and a `custom` certificate may be
  self-signed, so the directive moved into `tls-cert-certbot.inc`.
- The `extra_domains` redirect server, the administration allowlist and the
  `/api/docs` denial are emitted only when they apply. An empty `server_name`
  would make nginx redirect every unmatched host, and an unconditional
  `deny all;` would lock out the very surfaces the settings leave open.
- `.prettierignore` now covers `deploy/proxy/**`: Prettier infers the `html`
  parser for `.inc` and reflows an nginx include into an invalid file. The
  acceptance test caught it, which is what it is for.

### Defects found while verifying M5-002

Rebuilding the images for the `dist/tools` link surfaced two that predate this
task; both are fixed in the same commit and neither is an M5-002 requirement.

- Both `deploy/docker/app.Dockerfile` and `deploy/docker/web.Dockerfile` ran
  `pnpm --filter <app> build`, which does not build the workspace packages the
  application consumes from `dist`. The API's OpenAPI generation (added with
  `1396dbc`) and every `apps/web` import of `@remnaray/domain` therefore failed
  inside the image while `pnpm build` stayed green locally, because Turbo
  resolves `^build`. Both images now run their application through Turbo, and
  the web image copies `locales/` and `themes/` into the build stage because
  prerendering reads them.
- With that fixed, the web image still fails to build on this machine, and it
  is an environment limit rather than a repository defect. Inside Docker the
  Next.js static generation runs seven workers, pages exceed the sixty-second
  per-page budget and a worker finally exits with code 1 — the signature of
  memory pressure. The identical build on the host, with `.next` deleted and
  the same `INTERNAL_API_URL`, finishes in **22.5 seconds with no timeouts**,
  so the inputs are sound; the Docker VM shares this machine's 7.9 GB and the
  build also installs the workspace and builds four packages first. The CI
  `docker` job, which now includes the web image, verifies it on a runner with
  room. An earlier diagnosis blaming DNS was wrong: setting
  `INTERNAL_API_URL` did not change the symptom. The setting is kept anyway,
  because a build should not depend on what a resolver does with `api`.
- NFR-011 caps `api`/`bot`/`worker` at 250 MB and `web` at 300 MB. The app
  image copies the whole `.pnpm` store and is far above that; the section 6.1
  note and NFR-011 both point at `pnpm deploy --prod` as the remedy. This
  belongs to the image work, not to the proxy profile, and is carried into the
  M5 Definition of Done review.

## M5-003 verification

Verified on 2026-09-20.

- `deploy/proxy/caddy/Caddyfile.tmpl` is the section 21.4 configuration in
  full, rendered by the same `render-proxy` into the same `proxy-conf` volume
  and applied by the same `proxy-reloader`, so section 21.5's invariant holds:
  the profiles differ only in which containers run.
- `ghcr.io/remnaray/caddy` was already `caddy:2.11.4` rebuilt with
  `github.com/mholt/caddy-ratelimit` from TASK-M0-003; the acceptance test now
  asserts `http.handlers.rate_limit` is in the image it builds. The five zones
  carry the nginx numbers: `rr_webhooks` 300/10s, `rr_auth` 5/1m, `rr_admin`
  30/1m, `rr_api` 100/10s, `rr_general` 200/10s, plus the
  `order rate_limit before basicauth` the module needs.
- `RR_CADDY_IMAGE=caddy:2-alpine` renders the same file without any
  `rate_limit` block — the documented degradation of section 21.4 — and
  `GET /api/admin/v1/system` now answers `proxy.rateLimited`, so the console
  can show it instead of leaving it silent.
- Caddy owns its certificates, so the profile takes `acme` (default) and
  `custom`, and the renderer refuses `certbot` rather than emit a
  configuration that would quietly not work.
- Acceptance: `pnpm test:m5` builds the image, renders `acme`, `custom` and the
  stock-image variant and runs `caddy validate` on each — all three report
  `Valid configuration` — and asserts the `certbot` refusal. The nginx half of
  the suite still passes, with the reload after a domain change at **569 ms**.
- Checks: `pnpm test:m5` (2), `pnpm lint`, `pnpm typecheck`, `pnpm -r typecheck`,
  `pnpm typecheck:e2e`, `pnpm test` (11), `pnpm -r test` (api 136, web 22,
  bot 12, ui 8 and the remaining packages), `pnpm format`, full `pnpm build`,
  `pnpm i18n-check` (1476 messages), and
  `docker compose --profile caddy config`.

### M5-003 decisions

- Section 21.4 names the owner's certificate path `/etc/caddy/certs`, which
  cannot work: `/etc/caddy` is the read-only `proxy-conf` volume, and Docker
  cannot create a mount point inside a read-only mount — the acceptance test
  failed on exactly that. The directory is mounted at `/certs` instead and the
  rendered `tls` directive names it. The nginx profile is unaffected, because
  `/etc/nginx` there is not a volume.
- `custom.d/*.caddy` mirrors the nginx profile's `custom.d/*.conf`; the
  renderer picks the suffix from the profile so neither can pull the other's
  files in.

## M5-004 reconciliation

Implemented locally; BLOCKED BY EXTERNAL ENVIRONMENT for the required real-domain acceptance gate.

- `acme` was already complete with TASK-M5-002: the module renders only in that
  mode, keeps its state in `proxy-acme` and renews without a reload because the
  configuration names the certificate through `$acme_certificate`.
- `certbot` is now whole. The `certbot` service renews every twelve hours and
  its `--deploy-hook` touches `/etc/letsencrypt/.renewed`, which
  `proxy-reloader` already watches; `./rr tls:issue` performs the first issue
  against the HTTP-only bootstrap configuration the renderer chooses while no
  certificate exists, then restarts `proxy-config` so the full configuration
  renders. `./rr up` adds the `certbot` profile on its own.
- `custom` needs no runtime service; both profiles name the owner's files, at
  `/etc/nginx/certs` and `/certs`.
- `maintenance.tls-check` is the one maintenance job the worker performs itself,
  because section 19.2 wants the handshake made from outside the API. It runs at
  start and daily, and posts to the new
  `POST /api/internal/v1/system/tls-result`, which keeps the reading in Valkey,
  raises `tls.expiring` below fourteen days or when the host does not answer,
  and feeds `tls.expiresAt`, `tls.daysLeft` and `tls.checkedAt` on
  `GET /api/admin/v1/system`. Verification is deliberately not enforced by the
  check: an expired certificate still has to be readable.
- `packages/config` now refuses every combination that cannot work — `none`
  outside the `external` profile, and `certbot` with Caddy — so the process
  fails at startup with the variable named instead of running a proxy that
  never gets a certificate.
- Checks: `pnpm lint`, `pnpm typecheck`, `pnpm -r typecheck`, `pnpm test` (11),
  `pnpm -r test` (api 136, web 22, bot 12, worker 2, config 5 and the remaining
  packages), `pnpm format`, full `pnpm build`, and
  `docker compose --profile nginx --profile certbot config`.

### M5-004 external gate

Section 25.6 accepts this task "на стенде с реальным доменом… (ручная
проверка, чеклист в PR)" — both issue paths exercised by hand against a real
domain. That needs a public server and DNS this repository cannot supply, so it
stays open. The checklist to run is in `docs/tls.md` under "Acceptance
checklist"; everything that can be checked without a public domain is covered
by the unit tests and the environment validation above.

### M5-004 decisions

- `apps/worker` had no tests at all; it now has Vitest with the same
  configuration the API uses, so the TLS reading is covered rather than trusted.
- The TLS reading lives in Valkey rather than in a settings key: it is an
  observation, not configuration, and `/admin/system` is its only reader.
- The earlier `RR_TLS_EXPIRES_AT` environment reading on `/admin/system` was a
  placeholder with nothing writing it; it is replaced by the real measurement.

## M5-005 reconciliation

Implemented; the trusted-proxy unit gate passed, but the broader browser verification is blocked by the host runtime.

- Acceptance: a forged `X-Forwarded-For` from outside the trusted network must
  leave the source address alone. `apps/api/src/common/trusted-proxies.test.ts`
  drives a real Fastify instance: from `203.0.113.7` with
  `x-forwarded-for: 9.9.9.9` and `RR_TRUSTED_PROXIES=172.28.0.0/16`,
  `request.ip` is **203.0.113.7**; from `172.28.0.10` it is `9.9.9.9`, which is
  the proxy legitimately naming its client; and with nothing configured no
  header is believed at all.
- `apps/api` now builds its Fastify adapter with
  `trustProxy: trustedProxies()`. Context7 confirmed the current contract: a
  comma-separated IP/CIDR string, and Fastify deliberately refuses hop-count
  trust because it cannot validate the immediate peer.
- `deploy/proxy/external/edge.conf` is the section 21.7 container: routing
  only, no TLS, no limits, no security headers, because those belong to the
  owner's proxy and a second source of the same header is a second thing to
  keep in step. `nginx -t` passes. Compose starts it under the `external`
  profile, publishing `127.0.0.1:${RR_EXTERNAL_HTTP_PORT}`, and that profile
  starts none of the `proxy-*` services.
- `GET /api/admin/v1/system` reports `proxy.trustedProxies` and
  `proxy.external` — what the last request carried: the resolved client
  address, the protocol and whether each forwarded header was present. An
  owner can see the answer before something breaks rather than after.
- `.env.example` and `scripts/init-env.sh` now write `RR_TRUSTED_PROXIES` and
  `RR_EXTERNAL_HTTP_PORT`, so the documented default reaches the process
  instead of living only in the Zod schema.
- `docs/external-proxy.md` covers the contract and the nginx, Traefik and
  Cloudflare configurations, including the Cloudflare ranges and the
  no-cache rule for `/api`, `/webhooks` and `/tg`.
- Checks: `pnpm lint`, `pnpm typecheck`, `pnpm -r typecheck`, `pnpm test` (11),
  `pnpm -r test` (api 138 and the rest), `pnpm test:e2e` (26), `pnpm format`,
  full `pnpm build`, `docker compose --profile external config`, and `nginx -t`
  on `edge.conf`.

### M5-005 decisions

- The indicator is kept in process memory, not Valkey: it describes the last
  request this process served, `/admin/system` runs in the same process, and
  writing to Valkey on every request would cost a round trip for a diagnostic.
- With `RR_TRUSTED_PROXIES` unset the API trusts nobody rather than falling
  back to the compose network. A deployment that has not said what sits in
  front of it should not believe a header anyone can send.

## M5-006 verification

Verified on 2026-09-20.

- AC-202, both halves, in `test/m5.backup.integration.test.mjs` against a real
  PostgreSQL 18: `backup-entrypoint.sh once` writes a `pg_dump -Fc -Z 6` and a
  `.last-status` line carrying the state, the file and its size; the dump is
  then read back with `pg_restore --clean --if-exists` and the schema is whole
  again. Rotation is given 30 daily, 30 archive and 12 weekly files and keeps
  exactly **14 daily, 14 archives and 8 weekly**, the newest of each.
- The weekly copy is a hard link made on Sundays, so a Sunday costs no extra
  space and the two retentions cannot argue over one file: each prunes its own
  name and the bytes go with the last one.
- `deploy/backup/Dockerfile` is `postgres:18-alpine` plus a pinned
  `minio-client`, so the S3 copy has a client and a missing package fails the
  image build rather than a backup at three in the morning. Alpine's package
  is `minio-client` and its binary is `mcli`, which the script calls.
- `.env` is never copied into a backup. It holds `RR_APP_KEY`, and an archive
  carrying both the ciphertext and its key protects nothing.
- `deploy/backup/restore.sh` performs the section 20.5 sequence and asks for
  confirmation, because `--clean` drops what is there; `RR_RESTORE_ASSUME_YES`
  skips the prompt for a script.
- The `migrate` one-shot service of section 21.1 was missing from compose
  entirely. It now applies the migrations before `api`, `bot` and `worker`
  start, and takes `backups/pre-migrate-<version>.dump` first when a pending
  migration is marked `-- reversible: no` — never on a fresh database, where
  there is nothing to dump. Its header parsing, the pending comparison and the
  dump decision are unit tested.
- `maintenance.backup-check` reads `.last-status` in the worker and reports to
  `POST /api/internal/v1/system/backup-result`, which raises `backup.failed`
  when the newest backup failed or is older than 26 hours and feeds
  `GET /api/admin/v1/system`, replacing another environment reading nothing
  ever wrote.
- Checks: the AC-202 integration test, `pnpm lint`, `pnpm typecheck`,
  `pnpm -r typecheck`, `pnpm test` (11), `pnpm -r test` (api 141, worker 4,
  web 22, bot 12 and the rest), `pnpm format`, full `pnpm build`,
  `pnpm i18n-check`, and `docker compose config` for the `nginx` and
  `external` profiles.

### M5-006 decisions

- The app image gained a pinned `postgresql18-client`, because section 20.4
  makes `migrate` take a dump and the runtime image had no `pg_dump`. It also
  carries the db package's schema, migrations and Prisma CLI, which
  `prisma migrate deploy` needs beside them.
- The entrypoint takes `once` and `rotate` subcommands rather than only the
  scheduled loop. An operator can take a backup or apply the retention on
  demand, and the acceptance test drives the same code the schedule does.
- Rotation sorts by file name, which is chronological by construction, instead
  of parsing dates out of names in shell.
