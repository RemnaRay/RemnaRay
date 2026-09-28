# Initial setup wizard

RemnaRay ships unconfigured. The owner fills the variables of `.env`
(`scripts/init-env.sh` writes them), starts the stack and finishes the rest in
the browser: `https://<domain>/setup` (section 17.4, FR-171).

## The gate

While `settings.setup.completed` is false:

- the API answers every route except `/api/setup/*` and `/api/v1/health*` with
  `SETUP_NOT_COMPLETED` 503 (`SetupGuard`, registered before the
  authentication guard so the answer is the setup code and not
  `UNAUTHENTICATED`);
- the site's proxy redirects every path to `/setup`.

Once it is true the direction reverses: `/api/setup/*` answers
`SETUP_ALREADY_COMPLETED` 404 and `/setup` is a 404 page. The wizard cannot be
reopened, and `RR_SETUP_TOKEN` can be removed from `.env`.

## The steps

Each step is one `POST /api/setup/v1/steps/<n>` that validates on the server and
writes straight into `settings` and the target tables. `GET /api/setup/v1/state`
returns the current step and the draft; the draft names the domain, the panel
and the brand, so it is only served to a wizard session.

| #   | Step                | Server check                                                                                                                |
| --- | ------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 0   | Token               | `argon2` against the stored hash; five wrong tries block the IP 15 minutes                                                  |
| 1   | Administrator       | password ≥ 12 characters, TOTP code confirms the enrolment                                                                  |
| 2   | Domain              | `settings.domain.*`, prefilled from `RR_DOMAIN` and `RR_ACME_EMAIL`                                                         |
| 3   | Panel               | `system.stats` plus `squads.list`; accepts an existing webhook secret or generates one and answers the panel's `.env` lines |
| 4   | Bot                 | `getMe`; the webhook itself is set on the last step                                                                         |
| 5   | Brand               | the theme must load from the mounted `themes/` directory                                                                    |
| 6   | Plan and trial      | creates the first `plans` row and writes `settings.trial.*`                                                                 |
| 7   | Payments and fiscal | a form per provider from its `configSchema` (see admin.md, FR-061), healthchecks each, or the step is skipped               |
| 8   | Ready               | flips `setup.completed` and launches the shop                                                                               |

Step 1 is posted twice: without `code` the server generates the TOTP secret and
answers with the QR image, with `code` it confirms and creates the
administrator. The secret lives encrypted in the wizard session until then, so
an abandoned wizard leaves no half-made account.

The «Проверить» buttons are separate routes — `POST /api/setup/v1/check/panel`,
`/check/bot` and `/check/provider` — so a check never writes anything.

Step 3 accepts the secret already configured in the Remnawave panel. Enter it
in **Panel webhook secret** before checking and saving the step; the generated
`.env` hint then uses that exact value. Leave the field empty to generate a new
secret as before.

## Finishing

`POST /api/setup/v1/finish` requires every step but payments to be in the draft.
It sets `setup.completed`, marks `setup_state`, queues `panel.reconcile-all`
through the outbox and publishes the section 17.6 channels: `rr:bot.reconfigure`
(the bot process rebuilds its transport, which is where `setWebhook` and
`setMyCommands` happen), `rr:theme.changed` and `rr:i18n.changed`. The
administrators get the `setup.completed` alert, and the answer carries the bot
link and the administration URL.

### Site login through Telegram

The landing page's «Войти» uses Telegram Login over OpenID Connect
(core.telegram.org/widgets/login). Telegram only signs a visitor in on a page
the bot allows. After the wizard, open @BotFather, open its mini app and choose
the shop's bot → **Login Widget**:

1. A bot still on the legacy widget shows its `/setdomain` domain and **Switch
   to OpenID Connect Login**. Press it: the legacy widget is replaced (the
   site no longer uses it, and the bot's «Открыть кабинет» link does not
   depend on it).
2. Under **Redirect URIs** add the landing pages the button is on,
   `https://<domain>/ru` and `https://<domain>/en` (the domain of step 2):
   they must match exactly, and the library sends the page it runs on
   (`location.origin + location.pathname`) as its `redirect_uri`. Under
   **Trusted Origins** add `https://<domain>`, without a trailing slash.
3. Check that the **Client ID** BotFather shows is the number before the colon
   in the bot token: the API reads the Client ID from the token and refuses a
   token issued for another one.
4. Leave the signing algorithm (**Advanced**) at RS256 or ES256; EdDSA and
   ES256K carry no profile, and the API refuses them.

The **Client Secret** is not needed and goes nowhere: it serves the
authorization-code flow, while this page receives a signed `id_token` straight
from the popup and the API checks it against Telegram's public keys. Until the
URLs are allowed, the Telegram popup refuses the login; customers can still
sign in from the bot with «Открыть кабинет».

## Resuming

`setup_state.data` keeps a secret-free draft and `setup_state.current_step` the
next step, so a closed tab continues where it stopped. Secrets are never in the
draft: the panel token, the bot token and the provider configuration go into
their encrypted columns as soon as their step is submitted, and the draft only
records that they are set.

## Sessions and the token

`POST /api/setup/v1/token` compares the submitted value with
`argon2(RR_SETUP_TOKEN)`, which is stored in `setup_state.token_hash` on the
first successful attempt. It answers with the `rr_setup` cookie, a one-hour
session that slides with every step.

## Tests

`e2e/specs/setup.spec.ts` walks E2E-02 steps 4–11 (AC-171) against a second
stack whose database is empty and whose `RR_SETUP_TOKEN` is set, with the
Remnawave and Telegram mocks behind the panel and bot checks. It ends by
asserting the 404 on `/setup` and on the wizard API, and that the shop's public
API answers again. `apps/api/src/modules/setup/*.test.ts` cover the token
lockout, the TOTP confirmation, the draft and the gate.
