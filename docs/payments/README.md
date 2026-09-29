# Payment providers

RemnaRay treats the database invoice and `payment_events` row as the source of
truth. A provider callback is authenticated, normalized to `ProviderEvent`,
stored before processing, and applied idempotently. Provider secrets are stored
in encrypted `payment_providers.config_enc` values. The stored copy of a
callback is masked after its signature is checked (section 19.1): a body field
named like `secret`, `token`, `password` or `signature` (Robokassa's
`SignatureValue`) is kept as `***`, and of the request headers only
`content-type`, `user-agent`, `x-request-id` and the source `ip` are kept.

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

## Модель оплаты (F37, ADR-021)

Платёжная система только пополняет баланс. Тариф или смена тарифа — второй
шаг, покупка с баланса: клиент нажимает «Купить», когда деньги уже на балансе.

- Счёт через провайдера всегда пополнение: триггер `invoices_provider_topup`
  в базе не даёт вставить провайдерский счёт другого вида. `POST /me/invoices`
  с `kind: purchase` или `plan_change` и провайдером отвечает
  `400 VALIDATION_ERROR`; такая покупка идёт только с баланса.
- Сумма пополнения для тарифа: `max(нехватка, balance.topup_min_minor,
минимум провайдера)`, верхний предел `topup_max_minor` к ней не применяется.
  При смене тарифа нехватка считается с остатком старого тарифа на момент
  «сейчас + 24 часа». Расчёт даёт `GET /me/checkout/quote`; когда баланса
  хватает, ответ — `BALANCE_SUFFICIENT`, а нехватка при покупке приходит как
  `INSUFFICIENT_FUNDS` с `details.missingMinor`. `GET /me/plan-change/quote`
  удалён.
- Номер счёта провайдера — `NN-00001`, счётчик у каждого провайдера свой:
  ЮKassa 01, Platega 02, Lava 03, Robokassa 04, CryptoBot 05, Telegram Stars 06. Номер выдаётся до обращения к провайдеру, поэтому в нумерации возможны
  пропуски.
- Строка чека и описание платежа — `fiscal.item_name_template`, по умолчанию
  `Пополнение баланса (#{number})`; подстановки `{number}` и `{brand}`. ЮKassa:
  описание и наименование позиции чека обрезаются до 128 символов; Robokassa:
  `Description` до 100, наименование позиции чека до 128; Lava чек не
  отправляет (`receipts: false`).
- Любая оплата у провайдера зачисляется на баланс: и поздняя, и по
  отменённому счёту, и за тариф, снятый с продажи, и по старому счёту. Сообщённая
  сумма 0 не зачисляет ничего (`PAID_ZERO`, оповещение администраторам), а
  недоплата зачисляет фактически оплаченное.
- После зачисления клиент получает `payment.to_balance` с номером счёта; при
  пополнении под тариф в нём кнопка «Купить «тариф»», которая открывает в боте
  карточку подтверждения со свежим расчётом. То же показывает сайт на
  `/pay/<id>`.
- Реферальное вознаграждение начисляется только с пополнений.

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

A stored event is applied inline and by its queued `payments.apply-event`
job. As a backstop, the worker's `payments.reapply-events` cron (every five
minutes) applies again every signed event still unprocessed two minutes after
it arrived — for instance when the API stopped between storing and applying
it, or a Telegram Stars apply failed after the insert. A failed attempt keeps
its error in `payment_events.process_error`; an event still unapplied after
fifteen minutes raises the `payment.unapplied` alert once.

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
offered providers instead. Under F37 the balance is the only way to pay for a
plan: a provider only tops it up (see «Модель оплаты» above).

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

## Минимальная сумма пополнения и чек самозанятого (F37, ADR-021)

Проверено 2026-09-29–30 по документации провайдеров (ссылки в таблице и в
разделе «Checked» страницы каждого провайдера).

| Провайдер      | Код в номере | Минимум счёта                                                                                | `minAmountMinor` | Чек самозанятого                                                                                                                      | Поле описания                                                                               |
| -------------- | ------------ | -------------------------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| ЮKassa         | 01           | [1 ₽](https://yookassa.ru/docs/support/payments/limits) (карта, СБП, SberPay, T-Pay, ЮMoney) | 100              | [не выдаётся с 29.12.2025](https://yookassa.ru/developers/using-api/changelog): ЮKassa закрыла чеки для самозанятых                   | [`description`](https://yookassa.ru/developers/api), до 128 символов                        |
| Platega        | 02           | [нет](https://docs.platega.io/llms.txt)                                                      | 100              | —                                                                                                                                     | [`description`](https://docs.platega.io/createtransactionrequest-13226217d0)                |
| Lava           | 03           | [1 ₽](https://developer.lava.ru/) (`sum`, `minimum: 1`)                                      | 100              | [не через API](https://developer.lava.ru/): в счёте нет полей чека                                                                    | [`comment`](https://developer.lava.ru/)                                                     |
| Robokassa      | 04           | [нет](https://docs.robokassa.ru/ru/pay-interface)                                            | 100              | [автоматически](https://robokassa.com/online-check/robocheck-smz/) (Робочеки СМЗ → «Мой налог»); поле наименования не документировано | [`Description`](https://docs.robokassa.ru/ru/pay-interface), до 100 символов                |
| CryptoBot      | 05           | [нет](https://help.send.tg/en/articles/10279948-crypto-pay-api) (для `createInvoice`)        | 100              | —                                                                                                                                     | [`description`](https://help.send.tg/en/articles/10279948-crypto-pay-api), до 1024 символов |
| Telegram Stars | 06           | [1 XTR](https://core.telegram.org/bots/api#labeledprice)                                     | 100              | —                                                                                                                                     | [`description`](https://core.telegram.org/bots/api#createinvoicelink), 1–255 символов       |

- «нет» — провайдер не документирует минимум счёта; `minAmountMinor = 100`
  (1 ₽), чтобы счёт не был меньше рубля.
- ЮKassa: 1 ₽ — минимум для карты, СБП, SberPay, T-Pay и ЮMoney; у отдельных
  способов он выше (кредит СберБанка — 3 000 ₽). Объект `receipt`
  (наименование — `receipt.items[].description`) по-прежнему регистрирует чек
  54-ФЗ через кассу магазина, но чек НПД в «Мой налог» ЮKassa больше не
  формирует.
- Robokassa: Робочеки СМЗ регистрируют чек после каждой оплаты; документация
  не говорит, берётся ли наименование услуги из `Receipt.items[].name` или из
  `Description`. Поэтому RemnaRay передаёт в оба поля один текст — шаблон
  `fiscal.item_name_template` (ADR-021).
- Lava: решение по чеку записано в [lava.md](./lava.md).
- CryptoBot: «1–25000 USD» в документации относится к `transfer`, а не к
  `createInvoice`.
- Telegram Stars: `LabeledPrice.amount` — целое число в наименьших единицах
  валюты; для `XTR` это одна звезда, отдельного минимума нет. Сумма в звёздах
  — `ceil(roubles × starsPerRub)`, но не меньше одной звезды; счёт на 1 ₽ стоит
  `ceil(starsPerRub)` ([stars](./stars.md)).
- Оговорка для владельца: Platega, Robokassa и CryptoBot не документируют
  минимальную сумму, поэтому RemnaRay берёт 1 ₽. У вашего аккаунта у
  провайдера всё же могут быть свои минимумы по отдельным способам оплаты;
  если провайдер отклонил счёт, поднимите `balance.topup_min_minor`.
- Самозанятый (НПД) и ЮKassa: с 29.12.2025 ЮKassa больше не формирует чеки
  самозанятых, так что магазин на НПД не может выдавать чеки через ЮKassa.
  Используйте Robokassa (Робочеки СМЗ регистрируют чек в «Мой налог»
  автоматически) или формируйте чеки в «Мой налог» самостоятельно.
