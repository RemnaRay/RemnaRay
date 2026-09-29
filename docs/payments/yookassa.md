# YooKassa

Configure `shopId`, `secretKey`, optional fiscal settings, and the documented
YooKassa notification IP ranges. RemnaRay sends `POST /v3/payments` with
`capture=true`, the invoice identifier in `metadata.invoiceId`, and an
`Idempotence-Key`. A callback is never trusted for the final state by itself:
the adapter fetches `GET /v3/payments/{id}` before applying it.

Sources: [payment creation](https://yookassa.ru/developers/payment-acceptance/getting-started/quick-start), [webhooks](https://yookassa.ru/developers/using-api/webhooks).

Checked 2026-09-29 (F37): the minimum payment is 1 ₽ for bank cards, SBP,
SberPay, T-Pay and YooMoney ([limits](https://yookassa.ru/docs/support/payments/limits)),
so `minAmountMinor = 100`. `description` (up to 128 characters) is the text the
payer sees at checkout ([API](https://yookassa.ru/developers/api)). YooKassa
stopped its self-employed services on 29 December 2025 — receipts for
self-employed sellers on payments and refunds, and payouts to them
([changelog, 23 December 2025](https://yookassa.ru/developers/using-api/changelog));
the former self-employed receipts page now redirects there. A `receipt` object
still registers a 54-FZ receipt (item name `receipt.items[].description`), but
YooKassa no longer produces a НПД receipt in «Мой налог».
