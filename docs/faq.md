# Questions people ask

**Does one RemnaRay serve several panels?**
No. One instance, one Remnawave panel. Two panels means two deployments, each
with its own domain and database.

**Can I change the brand without forking?**
Yes — that is the point. The theme and the texts are data: copy `themes/manta`,
change the colours and the logo, select it in the console. Nothing is
recompiled and nothing is patched. See [`theming.md`](theming.md) and
[`i18n.md`](i18n.md).

**Do I have to use the bundled nginx?**
No. `RR_PROXY_PROFILE=caddy` swaps the proxy, and `external` turns it off
entirely so your own proxy can own 80 and 443. The routes, the statuses and the
security headers are identical either way — a smoke test compares them on every
pull request.

**Where do I put my own nginx rules?**
`deploy/proxy/nginx/custom.d/*.conf`, or `deploy/proxy/caddy/custom.d/*.caddy`.
They survive a re-render and an upgrade.

**Why does the shop overwrite what I change in the Remnawave panel?**
Because the shop is the source of truth for the term, the limits, the squads
and whether a user is enabled; the panel is the source of truth for traffic
used, the `LIMITED` state, devices and the subscription URL. Change users
through RemnaRay's console and the two stay in step. If you must let the panel
extend a term, `settings.panel.respect_manual_expire` does that explicitly.

**What happens if the panel is down when someone buys?**
The payment is recorded and the subscription is queued. The customer is told
the subscription is being activated, an alert reaches the administrator within
five minutes, and the link arrives within two minutes of the panel coming back.
No money is lost and nothing is charged twice.

**A customer paid after the invoice expired. Now what?**
The money lands on their balance, the subscription is untouched, and they are
told. Every payment system only tops the balance up (F37): the customer then
presses «Купить» and spends the balance on any plan.

**Can customers pay with something other than cards?**
Yes: YooKassa, Platega, Lava, Robokassa, CryptoBot, Telegram Stars, and the
account balance. Which ones you can sign up for depends on your legal status;
the table in the README says which. See [`payments/README.md`](payments/README.md).

**Do I need fiscal receipts?**
If you sell as a registered business or a self-employed person in Russia, yes,
and RemnaRay will only offer you providers that can issue them. If you sell
with no status, turn receipts off in the console and the providers that require
them are not offered. The receipt is issued for the top-up, with the line
«Пополнение баланса (#…)». A self-employed shop cannot issue receipts through
YooKassa any more (it stopped on 29 December 2025); use Robokassa or issue
them in «Мой налог» yourself.

**Is there a trial?**
One per customer, for as many days as you set, with its own traffic and device
limits. It is replaced — not extended — by the first paid plan.

**How do referrals work?**
Three schemes: a share of the payment, a fixed amount, or bonus days. The
referrer is credited after the invited customer's first **paid** purchase, not
on sign-up, and the accrual is held for a configurable period against refunds.

**Can I run it without a public domain?**
Not usefully. Telegram will not send webhooks to an IP address, and Let's
Encrypt will not issue for one. You can develop locally with
`compose.dev.yaml`, and the bot in long-polling mode.

**Which database do I back up?**
PostgreSQL, and the `themes/` and `uploads/` directories. The bundled `backup`
service does both daily and keeps 14 daily and 8 weekly copies. It never copies
`.env`, so keep that separately — without `RR_APP_KEY` a restored database is
unreadable. See [`backup.md`](backup.md).

**How do I know it is working?**
Settings → System shows the panel, the queues, the certificate and the last
backup. For graphs, the optional monitoring profile ships Prometheus and a
Grafana dashboard: [`monitoring.md`](monitoring.md).

**Something does not answer.**
[`troubleshooting.md`](troubleshooting.md) is organised by symptom.
