# Contributing to RemnaRay

Thank you for helping. This page is what you need to run the project, to add
the two things people most often add — a payment provider and a language — and
to get a change merged.

## The development environment

```sh
corepack enable
pnpm install --frozen-lockfile
docker compose -f compose.dev.yaml up -d   # PostgreSQL, Valkey and the mocks
pnpm --filter @remnaray/db db:migrate:deploy
pnpm dev
```

`pnpm dev` runs the API, the site, the bot and the worker together. The
dependencies in `compose.dev.yaml` are the only containers you need; the
production `compose.yaml` is for deployments, not for development.

Export `RR_PAYMENTS_MOCK=true` for the API to pay through the `mock` provider
locally. It is off by default because the provider must never reach a live
shop; see [`docs/payments/README.md`](docs/payments/README.md#the-mock-provider).

Node 24.21 or newer and pnpm 11.26.0 are pinned in `package.json`; Corepack
installs the right pnpm for you.

## Before you open a pull request

```sh
pnpm lint
pnpm format
pnpm typecheck && pnpm -r typecheck && pnpm typecheck:e2e
pnpm test && pnpm turbo run test
pnpm build
pnpm i18n-check
```

Those read generated types — the Prisma client and the Next.js route types —
which your checkout has and a runner's does not until `pnpm install` puts them
there. If CI disagrees with a green working tree, that gap is the usual
reason, and this runs the same gate from the state CI starts in:

```sh
./scripts/ci-local.sh   # deletes node_modules, dist, .turbo and .next first
```

The end-to-end and integration suites need Docker:

```sh
pnpm test:e2e     # Playwright against a stack the harness starts
pnpm test:m5      # the proxy templates and the backup, against real containers
```

Both proxy profiles are smoke-tested against a real deployment:

```sh
deploy/ci/proxy-smoke.sh nginx
deploy/ci/proxy-smoke.sh caddy
```

See [`docs/proxy.md`](docs/proxy.md) for what those ten checks are and
[`docs/e2e.md`](docs/e2e.md) for the browser suite.

On GitHub, CI (`.github/workflows/ci.yml`) runs on pushes to `main` and `dev`
and on every pull request. Its `ci-ok` job passes only when every blocking job
passed; it is the one check the `main` ruleset requires, so it keeps its name
when the Node versions of the matrix change. Lighthouse measures and does not
block.

## Definition of done

A change is done when:

1. It does what it says, with no placeholder left behind.
2. Tests cover it — a unit test for a rule, an integration test for anything
   that touches PostgreSQL or Valkey, a smoke row for anything the proxy
   answers.
3. Every check above passes.
4. Any new or changed message exists in **both** `ru` and `en`
   (`pnpm i18n-check` fails otherwise).
5. The documentation page for the area is updated.
6. There is a changeset.

## Changesets

Every pull request that changes behaviour carries one:

```sh
pnpm changeset
```

Pick `patch`, `minor` or `major` and write the line that will appear in
`CHANGELOG.md` — it is read by owners deciding whether to upgrade, so write it
for them and not for the diff. A change with no user-visible behaviour (a
refactor, a test, a comment) needs none.

## Adding a payment provider

A provider is one class implementing `PaymentProvider`
(`apps/api/src/modules/payments/payments.types.ts`), and nothing else in the
system knows its name. The checklist:

1. **Declare the capabilities.** `receipts`, `webhooks`, `statusPolling`, the
   `kind` (`redirect`, `invoice` or `native`) and the currencies it accepts.
   The wizard and the administration console read these; a provider that
   cannot issue receipts is simply not offered to an owner who needs them.
2. **`configSchema`** — a Zod schema for what the owner types in. Secrets are
   encrypted at rest with `RR_APP_KEY`; never log a value from it.
3. **`createInvoice`** — always pass RemnaRay's own `invoiceId` as the
   provider's order id or payload. It is how a webhook finds its invoice.
   Return `rawSafe` with the provider's answer minus anything secret.
4. **`verifyWebhook`** — signature, and an IP allowlist where the provider
   publishes one. Return `{ ok: false, reason }` rather than throwing.
5. **`parseWebhook`** — return `null` for a body that names no event. An event
   with no type reaches the database as a null column and turns anything
   posted at the webhook path into a 500.
6. **`fetchStatus`** — for polling, and for the providers whose webhook must be
   confirmed by a second request before it is believed.
7. **`ackResponse`** — exactly what the provider wants to see, or it retries.
8. **Fixtures and tests** — one valid webhook and one with a broken signature
   per event type, in `packages/payments-mock` style.
9. **`docs/payments/<provider>.md`** — what the owner types into the console,
   where those values come from in the provider's own dashboard, the webhook
   URL to register, and how to use the provider's test mode.
10. Register the code in `ProviderCode` and the registry.

## Adding a language

Locales are data, not code (`locales/<lang>/*.json`). To add one:

1. Copy `locales/en` to `locales/<lang>` and translate. Keep the ICU
   placeholders exactly as they are.
2. Add the code to `SUPPORTED_LOCALES` in `packages/i18n-core`.
3. Translate the legal documents in `locales/<lang>/legal/`.
4. `pnpm i18n-check` — it fails on a key that exists in one locale and not the
   other, and on a broken ICU message.

Owners can override any message from the administration console without a fork;
see [`docs/i18n.md`](docs/i18n.md).

## Commits

Conventional Commits, checked by commitlint:

```
feat(payments): add the Lava provider
fix(proxy): answer 405 on a non-POST webhook
docs(install): describe the external proxy profile
```

## Code of conduct

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).
Security problems go through [`SECURITY.md`](SECURITY.md), never a public
issue.
