# The API

One API serves both channels. The bot and the site are thin clients over it,
which is why a rule exists once and behaves the same wherever a customer meets
it.

`apps/api/openapi.json` is generated from the Zod contracts in
`packages/domain` — OpenAPI 3.1, 135 paths — so it cannot drift from what the
code accepts. Regenerate it with `pnpm --filter @remnaray/api build`.

## The four surfaces

| Prefix                             | Who calls it                                    | How it authenticates                                      |
| ---------------------------------- | ----------------------------------------------- | --------------------------------------------------------- |
| `/api/v1/...`                      | the site, and anyone reading the public catalog | a session cookie for `/me`, nothing for the public routes |
| `/api/admin/v1/...`                | the administration console                      | administrator session plus `X-CSRF-Token`                 |
| `/api/internal/v1/...`             | the bot and the worker                          | `X-Internal-Token`, and only from the compose network     |
| `/webhooks/...`, `/tg/webhook/...` | payment providers, the panel, Telegram          | the provider's own signature — never a session            |

`/api/docs` serves the document when `RR_API_DOCS=true`; the proxy answers 404
for it otherwise, in both profiles.

## The rules that apply everywhere

- **Errors** are `{ "error": { "code": "...", "message": "..." } }` with the
  code carrying the meaning. The table of codes and statuses is section 9.3 of
  the specification.
- **Money** is integer minor units, never a float. A price of 299 ₽ is
  `29900`.
- **Idempotency**: `POST /me/invoices` requires an `Idempotency-Key: <uuid>`,
  and `POST /me/trial` and `POST /me/promocodes/redeem` take one. The first
  successful answer is kept 24 hours per user; the same request with the same
  key gets it again with `Idempotent-Replay: true` instead of being performed
  twice. The key with a different request is `422 IDEMPOTENCY_KEY_REUSED`,
  and while the first request is still running a second is `409 CONFLICT`. A
  failed request keeps nothing, so it can be retried with the same key.
- **Mutations from a browser** need `X-Requested-With: RemnaRay` and either
  `Sec-Fetch-Site: same-origin` or a matching `Origin`. Webhooks are exempt —
  they authenticate by signature.
- **Rate limits** apply at the proxy by zone and again per user inside the API;
  both answer 429.

## Buying a plan

A plan is bought, renewed and changed only from the balance; a payment
provider only tops the balance up ([ADR-021](adr/ADR-021.md)). A client asks
first what the purchase costs:

```
GET /api/v1/me/checkout/quote?planId=<uuid>&kind=purchase|plan_change&promocode=<code>
GET /api/internal/v1/me/checkout/quote?…          the same, for the bot (X-Acting-User)
```

```json
{
  "planId": "…",
  "kind": "purchase",
  "priceMinor": 29900,
  "discountMinor": 0,
  "creditMinor": 0,
  "toPayMinor": 29900,
  "availableMinor": 29600,
  "missingMinor": 300,
  "topups": [
    { "provider": "yookassa", "amountMinor": 5000 },
    { "provider": "platega", "amountMinor": 10000 }
  ],
  "promocode": null
}
```

`availableMinor` is the balance less held referral rewards. `topups` is empty
when nothing is missing, and otherwise lists every offered provider with
`max(missing, balance.topup_min_minor, the provider's minimum)` — above
`balance.topup_max_minor` too. For a plan change the missing amount uses the
old plan's remainder a day later, because the remainder melts while the
customer pays. A promocode the shop refuses comes back as
`{ "code": "…", "applied": false, "error": "PROMO_…" }` with no discount; the
quote itself still answers. An unavailable plan is `409 PLAN_UNAVAILABLE`, a
plan change without an active subscription `409 PLAN_CHANGE_NOT_ALLOWED`.

`POST /me/invoices` takes one of three bodies:

| Body                                                                              | What it does                                                                                                                                                                                                                                                 |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `{ kind: "purchase" \| "plan_change", planId, provider?: "balance", promocode? }` | buys from the balance, paid at once; any other provider is `400 VALIDATION_ERROR`; a short balance is `409 INSUFFICIENT_FUNDS` with `details.missingMinor`                                                                                                   |
| `{ kind: "topup", provider, amountMinor }`                                        | tops up by an amount within `balance.topup_min_minor`…`topup_max_minor` (`400 TOPUP_AMOUNT_OUT_OF_RANGE`); `provider: "balance"` is `409 PROVIDER_UNAVAILABLE`                                                                                               |
| `{ kind: "topup", provider, forPlan: { planId, kind, promocode? } }`              | tops up by the amount the quote names for that provider; `409 BALANCE_SUFFICIENT` when nothing is missing (buy instead). A pending, unexpired top-up for the same plan, kind and promocode at that provider that still covers the amount is returned instead |

A top-up «for a plan» only remembers the promocode; the purchase from the
balance after it applies the discount. Nothing is bought by the top-up itself:
once it is paid, the customer buys as a second step.

An invoice carries `number` — `NN-00001` for a provider invoice, the number
its receipt and payment description show, `null` for one paid from the
balance — and `target`, `{ planId, planSlug, kind, promocode }` for a top-up
for a plan, else `null`. A transaction in `GET /me/transactions` carries its
invoice's number as `invoiceNumber`. `GET /me/plan-change/quote` no longer
exists.

## Health and metrics

```
GET /api/v1/health          liveness, no dependencies
GET /api/v1/health/ready    database, Valkey, panel, migrations, setup
GET /metrics                Prometheus text, from the internal network only
```

[`monitoring.md`](monitoring.md) lists the twelve metrics and what writes them.

## Outgoing webhooks

RemnaRay can call you when something happens (section 9.8). Up to five
recipients go in the `webhooks.outgoing` setting (Settings → Store in the
console, a JSON array; the value is secret, so it is written whole):

```json
[
  {
    "url": "https://example.com/hook",
    "secret": "…",
    "events": ["payment.succeeded"],
    "enabled": true
  }
]
```

Events: `user.created`, `subscription.activated` (a purchase, a trial once the panel has the user, plan
change, invitee bonus or an administrator's extension), `subscription.expired`,
`payment.succeeded` (money taken for an invoice, including one credited to the
balance), `payment.refunded`, `referral.rewarded`. The body is

```json
{
  "id": "01J…",
  "type": "payment.succeeded",
  "createdAt": "2026-09-18T10:00:00.000Z",
  "data": {
    "userId": "…",
    "telegramId": 123,
    "transactionId": "…",
    "invoiceId": "…",
    "type": "purchase",
    "amountMinor": 29900,
    "currency": "RUB",
    "provider": "yookassa",
    "planId": "…"
  }
}
```

with `X-RemnaRay-Signature: sha256=<hex HMAC-SHA256 of the raw body with the
recipient's secret>`, `X-RemnaRay-Event` and `X-RemnaRay-Delivery` (the event
`id`; deduplicate on it). Any 2xx within 10 s is delivered; anything else,
a redirect included, is retried 1 min, 5 min, 30 min, 2 h and 12 h later with
the same body. The event is recorded in the transaction that causes it and
sent after it commits, from the `webhooks` queue; a recipient removed or
unsubscribed before a retry is not called again. No delivery table is kept:
failures are logged and counted in `rr_outgoing_webhook_failures_total`.
