# Telegram Stars

Configure `{"starsPerRub": 0.75}` — how many stars one rouble costs. There is no
token of its own: the adapter uses the bot token from `bot.token` (ADR-012), so
the health check fails until the bot is configured, and a failed health check
keeps Stars out of the payment methods (AC-061).

**Price.** A plan may fix its price in stars with `price_overrides: {"XTR": 200}`.
An invoice that charges less than the list price (a promocode discount, a
plan-change credit) pays the same share of those stars, rounded up. Without an
override, and for a top-up, the amount is `ceil(amount / 100 × starsPerRub)`.
Never less than one star. `provider_amount` holds the stars and
`fx_rate = stars / roubles`, truncated to eight places.

**Creation.** The API creates the invoice link with `createInvoiceLink`
(`currency: "XTR"`, one price, empty `provider_token`, payload `inv_<invoiceId>`)
and the bot shows it as the Pay button. The site's button opens
`t.me/<bot>?start=inv_<invoiceId>` instead; the bot then sends the same invoice
with `sendInvoice` from `POST /api/internal/v1/stars/create-link`. Invoices live
`invoice.ttl_minutes_crypto` minutes, 60 by default.

**Payment.** There is no HTTP webhook, and `/webhooks/stars` is refused.
Telegram delivers `pre_checkout_query` and `message.successful_payment` to the
bot:

- `pre_checkout_query` → `POST /api/internal/v1/stars/precheckout`. The query
  is approved only for a pending, unexpired invoice of the payer, in `XTR`, at
  exactly `provider_amount`; otherwise it is declined with a localized reason.
  Telegram waits ten seconds for the answer.
- `successful_payment` → `POST /api/internal/v1/stars/successful-payment`. The
  event is stored under `telegram_payment_charge_id` and applied: one
  transaction per invoice, a repeat is a duplicate, an invoice that expired in
  the meantime is credited to the balance (EX-02), and a smaller `total_amount`
  is scaled to roubles so the underpayment rule applies. If the API cannot
  record it — or anything before the payment handler fails, such as the user
  upsert or the message catalog — the bot never acknowledges the update: it
  stays pending in the `tg:updates` stream and is delivered again about every
  minute. The customer is told once, on the first failure, that the payment
  was received and is being credited (`bot.payment.received`, with the
  incident id of the log line).
- A second charge with another `telegram_payment_charge_id` for an invoice
  already paid — two copies of one invoice paid before the first was applied —
  is credited to the balance as a top-up of its own, and administrators get
  the `payment.duplicate` alert.

Payment updates are exempt from the bot's per-user rate limit and are handled
before any open dialog. Refunds go to the balance; `refundStarPayment` is not
called (section 11.3.6). There are no receipts.

Source: [Bot API 10.3 — Payments](https://core.telegram.org/bots/api#payments)
and [Payments in Telegram Stars](https://core.telegram.org/bots/payments-stars),
checked on 2026-09-25.
