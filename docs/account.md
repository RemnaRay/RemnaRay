# Customer account

The account lives at `/<locale>/account` and is protected by `proxy.ts`: a
request without `rr_sid` is redirected to `/<locale>?login=1`.

## Pages and states

| Path                 | Content                                                           | Empty state                                          |
| -------------------- | ----------------------------------------------------------------- | ---------------------------------------------------- |
| `/account`           | Status, expiry, traffic, subscription link, QR, client deep links | «У вас нет подписки» with the trial and plan actions |
| `/account/plans`     | Plan cards with a checkout panel, promo code preview              | «Тарифов пока нет»                                   |
| `/account/balance`   | Available balance with held rewards as pending, presets, history  | «Операций пока нет»                                  |
| `/account/referrals` | Links, statistics, terms, masked invited users                    | «Пока никого»                                        |
| `/account/devices`   | HWID list, removal when the owner allows it                       | «Устройств нет»                                      |
| `/account/settings`  | Language, receipt email, marketing, anonymization request         | —                                                    |
| `/pay/[invoiceId]`   | Status, countdown, payment and check actions                      | —                                                    |

## Buying a plan (F37, ADR-021)

A plan is bought from the balance; a payment system only tops the balance up.

- `/account/plans` is the showcase. «Выбрать» on a card opens the checkout
  panel, which asks `GET /me/checkout/quote` (the price with the promo code, the
  available balance, the shortage and the top-up each offered provider would
  need). When the balance covers the price the panel offers «Купить с баланса за
  …». Otherwise it says «Не хватает …», lists the providers with the top-up
  amount of each and offers «Пополнить на …»; a note tells the customer to come
  back and press «Купить» once the money is on the balance.
- `/account/plans?change=1` is the plan change. It offers the other plans only,
  shows the credit for the rest of the current plan («Зачёт за остаток текущего
  тарифа»), and the button reads «Сменить за …». The shortage is computed with
  the old plan's remainder at now + 24 hours.
- «Пополнить» creates a top-up for the shortage and opens `/pay/<id>`. The page
  shows «Счёт #NN-00001» (the provider's number, see
  [payments](./payments/README.md)), the status and the countdown. When the
  top-up lands it says «Баланс пополнен.» and, for a top-up made for a plan,
  shows the checkout panel with a fresh quote, so «Купить с баланса за …» is one
  click away and leads to `/account` with the subscription.
- A top-up made from `/account/balance` has no plan behind it: the page offers
  «Перейти к балансу» instead.

Every page renders through `ResourceSection`, which owns the three states of
section 13.4: `LoadingState` (skeletons), `Empty` and `FailureState` (localized
error code plus `requestId`). `useResource` caches a read for 15 seconds;
mutations call `invalidate(prefix)` instead of updating optimistically, because
the values are money.

`test/account-pages.test.tsx` renders each page against a mocked API and asserts
all three states (AC-133); `test/pay-page.test.tsx` covers the payment page
behaviour from FR-134.

## Authentication

- The landing page signs in with Telegram Login over OpenID Connect (owner
  decision F29, 2026-09-26). `GET /api/v1/auth/telegram/nonce` gives the page a
  nonce signed with `RR_APP_KEY` (ten minutes) and the bot's Client ID, and sets
  the same nonce as the HttpOnly cookie `rr_oidc_nonce`; the button opens
  Telegram's popup (`telegram-login.js?6`) with them; the returned `id_token`
  goes to `POST /api/v1/auth/telegram/oidc`, which checks the signature against
  Telegram's JWKS (RS256 or ES256), `iss`, `aud` = the bot id, `exp`, and that
  its nonce is this browser's cookie and unused, then opens the session. The
  Telegram id is the token's `id` claim (profile scope; `[verify]` on the first
  live login). The section 13.3 widget route `POST /api/v1/auth/telegram`
  remains for compatibility. Setup: `docs/setup.md`, «Site login through
  Telegram».
- From the bot, «Открыть кабинет» opens `/auth/tg?token=<jwt>`, which
  redirects to `/<locale>/auth/tg#<jwt>` — the token in the fragment, out of
  every log and `Referer`. That page asks the API whose account the link opens
  (`POST /api/v1/auth/tg/preview`) and shows «Войти как <name>?»; only the
  button signs in (`POST /api/v1/auth/tg`, same-origin, then
  `/<locale>/account`), so a link someone else hands over cannot sign a visitor
  into their account unasked (L-3). A link opens one session and is spent
  (R79); it is no `Authorization: Bearer` credential for `/api/v1/me`.
- «Выйти» posts `POST /api/v1/auth/logout`, drops the cached resources and
  returns to the landing page.

## API

`/api/v1/me/*` and `/api/internal/v1/me/*` are the same operations backed by one
`MeService` (sections 9.4 and 9.5). The public controller resolves the user from
the session cookie, the internal one from `X-Acting-User`. Money is transported
as `{ amountMinor, currency }` with `amountMinor` as a JSON number.

`POST /api/v1/me/anonymize-request` does not anonymize anything by itself: per
section 19.5 it records `users.anonymize.requested` in the immutable audit log,
from where an administrator performs the anonymization. The administrator alert
for that request is scheduled with the notification work in TASK-M4-007.
