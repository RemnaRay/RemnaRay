---
'@remnaray/api': patch
'@remnaray/bot': patch
---

Stop refusing a customer's «Проверить оплату» after the worker's background status poll, which used up the one-check-per-10-seconds limit and made the bot show «Произошла ошибка». A check within the limit answers 429 and a silent provider 409, and the bot writes on the invoice when it was checked.
