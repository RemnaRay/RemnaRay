# Lava

Configure `shopId`, the project `secretKey`, and the additional webhook key.
Outgoing JSON is signed with HMAC-SHA256 and the incoming raw body is verified
with the additional key. Status polling uses `POST /business/invoice/status`.
«Проверить» signs `POST /business/invoice/get-available-tariffs` with the
`shopId` and succeeds on `status_check: true`, so wrong keys fail the check.

Source: [Lava Business API](https://developer.lava.ru/).

Checked 2026-09-29 (F37) against the OpenAPI embedded in
[developer.lava.ru](https://developer.lava.ru/): `CreateInvoiceApiRequest.sum`
has `minimum: 1` and `maximum: 2000000` roubles, so `minAmountMinor = 100`. The
payment description goes in `comment` (example «Оплата заказа №10245»),
returned in `InvoiceCreateResource.comment`; `customFields` is merchant data.
The schema does not say where Lava shows `comment` to the payer.

Lava не принимает данные чека через API счёта; `receipts: false`, чек
самозанятого формирует сам продавец в «Мой налог»: у `POST /business/invoice/create`
есть только `sum`, `orderId`, `shopId`, `hookUrl`, `customFields`, `comment`,
`failUrl`, `successUrl`, `expire`, `includeService` и `excludeService`, а
документация Lava Business API не описывает ни чеков, ни фискализации.
