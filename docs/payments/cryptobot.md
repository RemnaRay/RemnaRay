# CryptoBot

Configure the Crypto Pay API token. The adapter creates a fiat RUB invoice,
whose `amount` is the decimal string of roubles (`"299.00"` for 29900 kopecks),
and checks the `crypto-pay-api-signature` HMAC header on callbacks. The provider
invoice payload is retained without the API token; `paid_asset` is provider
payload data and must remain available for payment reporting. «Проверить»
calls `getMe`, which exists to test the app token.

Source: [Crypto Pay API](https://help.send.tg/en/articles/10279948-crypto-pay-api)
(moved from help.crypt.bot; read 2026-09-26).

Checked 2026-09-30 (F37): `createInvoice` documents no minimum `amount`; the
«1-25000 USD» limit in the same document belongs to `transfer`. So
`minAmountMinor = 100`. `description` (up to 1024 characters) is what the user
sees when paying. The live page was unreachable from the checking network, so
it was read from the [Wayback copy of 2 June 2026](https://web.archive.org/web/20260602112620/https://help.send.tg/en/articles/10279948-crypto-pay-api)
and matched against Context7's copy of the same article.
