# Payment providers

RemnaRay treats the database invoice and `payment_events` row as the source of
truth. A provider callback is authenticated, normalized to `ProviderEvent`,
stored before processing, and applied idempotently. Provider secrets are stored
in encrypted `payment_providers.config_enc` values.

The provider adapters follow the current provider contracts:

- [YooKassa](./yookassa.md) uses Basic authentication, `Idempotence-Key`, IP
  allowlisting, and status re-fetch before a `paid` event is applied.
- [Robokassa](./robokassa.md) uses `ResultURL`, the configured hash algorithm,
  and `OK<InvId>` acknowledgements.
- [Lava](./lava.md) verifies incoming HMAC-SHA256 signatures with the
  additional webhook key.
- [Platega](./platega.md) polls `GET /transaction/{id}` because polling is the
  source of truth.
- [CryptoBot](./cryptobot.md) verifies `crypto-pay-api-signature`.
- [Telegram Stars](./stars.md) have no HTTP webhook: `/webhooks/stars` is
  refused with `WEBHOOK_NOT_SUPPORTED` before anything is stored, and payment
  proof arrives as the bot's `successful_payment` update through the internal
  endpoints of section 9.5.

A payment is accepted onto an invoice that is pending, expired or canceled.
Money for an expired (EX-02) or canceled invoice is credited to the balance
without activating anything, and administrators are alerted (`payment.late`,
`payment.after_cancel`). Another `paid` event for an invoice already paid is
the same payment reported again (EX-03) and changes nothing — except for
Telegram Stars, where a new charge id is new money (see [stars](./stars.md)).

A payment for a plan taken off sale (inactive or deleted) after the invoice
was issued is credited to the balance in the same way, and administrators get
the `payment.plan_unavailable` alert (owner decision О-19): nothing is
activated, and the customer may buy another plan from the balance.

Provider configuration is deliberately incomplete until an administrator
enables the provider and records a successful health check. `POST
/me/invoices` applies the same rule as `GET /me/payment-methods` (AC-061): an
invoice through a provider that is disabled, was never checked or failed its
last check is refused with `409 PROVIDER_UNAVAILABLE` before the provider is
called.

## The balance

`balance` pays for a plan or a plan change from the customer's available
balance (FR-070, section 11.3.7). The invoice row and the debit are written in
one transaction: the invoice is `paid` when the request returns, or it was
never created and the request answers `409 INSUFFICIENT_FUNDS`, so the same
request again is refused again rather than handed a pending invoice. A top-up
cannot be paid from the balance itself (FR-071) and answers
`PROVIDER_UNAVAILABLE`; the site and the bot let the customer choose among the
offered providers instead.

The balance is built in and has nothing to configure, so it is never a
`payment_providers` row: the setup wizard neither lists nor saves it, and a row
an earlier wizard wrote is ignored by `GET /me/payment-methods` and the
console, which list the balance once.

«Проверить» (`POST /me/invoices/:id/check`, the console's recheck, FR-064)
asks `fetchStatus` only of providers with status polling. The balance and
Telegram Stars have none: the check answers the invoice as it is.

## The `mock` provider

`mock` exists for development and test stands only (section 22.4). It is
registered when `RR_PAYMENTS_MOCK=true` and is absent from the registry
otherwise, so `/webhooks/mock` and an invoice naming it answer
`PAYMENT_PROVIDER_NOT_FOUND`. Its webhook secret has a public default: on a
live shop the variable must be `false` or unset. `scripts/init-env.sh` and
`.env.example` write `false`; a `.env` created by an earlier version carried
`true` and has to be edited before the upgrade.
