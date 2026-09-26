---
'@remnaray/api': minor
'@remnaray/web': minor
---

Sign in on the site with Telegram Login over OpenID Connect, which Telegram now documents in place of the archived widget. The page opens Telegram's popup, and the API checks the returned token against Telegram's keys and a nonce bound to the browser. In the BotFather mini app open the bot → Login Widget, switch it to OpenID Connect Login, and add https://<domain>/ru and https://<domain>/en as Redirect URIs and https://<domain> as a Trusted Origin.
