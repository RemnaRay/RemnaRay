---
'@remnaray/api': minor
'@remnaray/bot': minor
'@remnaray/web': minor
'@remnaray/db': minor
'@remnaray/domain': minor
---

Plans are bought only from the balance. A payment system only tops the balance up — for the missing amount when a plan is being bought — and every provider invoice is numbered per provider (`01-00001`) with one receipt line «Пополнение баланса (#…)». After the top-up the customer presses «Купить». Referral rewards come from top-ups only; the `count_topups` setting is gone. The dashboard shows receipts and sales. A settings export made before this release still imports: the retired `count_topups` is skipped and the old default receipt template `Subscription {plan}` becomes the new default; a template the owner customised with `{plan}` is refused and has to be edited in the export (only `{number}` and `{brand}` remain).
