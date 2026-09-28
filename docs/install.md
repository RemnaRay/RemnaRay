# Installing RemnaRay

One RemnaRay serves one Remnawave panel. The target is a shop that takes money
within half an hour of the first command.

## What you need

|                  | Minimum                                                                                     | Recommended           |
| ---------------- | ------------------------------------------------------------------------------------------- | --------------------- |
| CPU / RAM / disk | 1 vCPU / 2 GB / 20 GB SSD                                                                   | 2 vCPU / 4 GB / 40 GB |
| OS               | Ubuntu 22.04+ or Debian 12+, Docker Engine 27+, Compose 2.20+                               | Ubuntu 24.04 LTS      |
| Open ports       | `80/tcp`, `443/tcp`, `443/udp` (HTTP/3, optional)                                           | and `22`              |
| DNS              | an `A` record for your domain pointing at the server, TTL ≤ 300 while installing; no `AAAA` |                       |
| Clock            | NTP — webhook signatures and TOTP both depend on it                                         |                       |
| Panel            | Remnawave 2.8.0+, reachable over HTTPS, with an API token that may manage users and squads  |                       |

You also need a Telegram bot token from [@BotFather](https://t.me/BotFather).

The shop answers on IPv4 only: the proxy ports are published on `0.0.0.0`, so
leave the domain without an `AAAA` record (a client that prefers IPv6 would
otherwise fail to connect). Docker would carry IPv6 connections into the
IPv4-only compose network from its gateway address, which the proxy has to
trust for `X-Forwarded-For`, so any IPv6 visitor could claim any address.

## Install

```sh
git clone https://github.com/RemnaRay/RemnaRay && cd RemnaRay
./scripts/init-env.sh
./scripts/rr up
```

`init-env.sh` asks for the domain, the ACME email and a database password,
generates `RR_APP_KEY`, `RR_INTERNAL_TOKEN` and `RR_SETUP_TOKEN`, writes `.env`
with mode `600` and prints the setup token. **Keep `.env` somewhere else as
well**: it holds the key everything else is encrypted with, and the backups
deliberately do not contain it.

`./scripts/rr up` reads the profile out of `.env`, so you never type
`--profile` yourself. First start: the images pull in one to three minutes, the
migrations take seconds, and the certificate arrives in another thirty to
sixty. Then open `https://<your domain>/setup` and follow the eight steps —
[`setup.md`](setup.md) describes each one.

When the wizard finishes, `/setup` answers 404 and `RR_SETUP_TOKEN` can be
removed from `.env`.

## Verifying the images

Every published image is signed with [cosign](https://docs.sigstore.dev/)
by the release (or weekly rebuild) workflow of this repository, keyless, and
carries an SBOM and a build provenance attestation. To check one before you
run it:

```sh
cosign verify ghcr.io/remnaray/app:1 \
  --certificate-identity-regexp '^https://github\.com/RemnaRay/RemnaRay/\.github/workflows/(release|rebuild)\.yml@' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

## Running from a source checkout

`compose.yaml` names published images rather than build contexts, so a
checkout that is ahead of the last release — or a fork that has published
nothing of its own — has nothing to pull and `./scripts/rr up` stops at
`error from registry: denied`. Build them first:

```sh
./scripts/rr build     # app, web, backup and the proxy your profile starts
./scripts/rr up
```

The images are tagged with exactly the names `compose.yaml` resolves to, so
`up` finds them locally and pulls nothing. Budget ten to fifteen minutes and
2 GB of free RAM for the first build; afterwards Docker's layer cache makes it
minutes. Name images to build fewer of them: `./scripts/rr build web`.

A published release needs none of this — `./scripts/rr up` pulls
`ghcr.io/remnaray/<image>:${RR_VERSION:-1}` and starts.

### Building somewhere other than the server

The smallest servers cannot do it. On 1 vCPU and 2 GB the Next.js build alone
takes a quarter of an hour and may run out of memory, so build the images in
GitHub Actions and pull them instead: run the **images** workflow on your fork
(Actions → images → Run workflow), give it a tag such as `dev`, and add two
lines to `.env`. The workflow refuses a tag shaped like a release's — `1`,
`1.2`, `1.2.3`, `1.2.3-…` or `rc` — so this unsigned build never replaces a
published release:

```
RR_REGISTRY=ghcr.io/<your github account, lowercase>
RR_VERSION=dev
```

Then `./scripts/rr up`. A tag that is not a release's, such as `dev`, is rebuilt
under the same name, so `up` pulls it every time before starting — otherwise an
older copy left on the server would start instead. If the package is private,
the server needs
`docker login ghcr.io` once with a token carrying `read:packages`; making the
package public at Packages → Package settings avoids that.

`RR_REGISTRY` and `RR_VERSION` are what a release deployment uses too — they
simply default to the published images.

## The seven variables

Everything else is configured from the administration console and lives in the
database. `.env` carries only secrets and infrastructure:

| Variable            | What it is                                                   |
| ------------------- | ------------------------------------------------------------ |
| `RR_DOMAIN`         | the public domain, without a scheme                          |
| `RR_ACME_EMAIL`     | where Let's Encrypt writes about expiry (`RR_TLS_MODE=acme`) |
| `RR_PROXY_PROFILE`  | `nginx`, `caddy` or `external`                               |
| `RR_APP_KEY`        | encrypts every secret in the database — losing it loses them |
| `RR_SETUP_TOKEN`    | one-time, for the wizard                                     |
| `RR_INTERNAL_TOKEN` | how the bot and the worker authenticate to the API           |
| `POSTGRES_PASSWORD` | the database password                                        |

`api`, `worker` and `bot` check `.env` when they start: a missing or malformed
variable — `RR_APP_KEY` must be 32 bytes in base64, `openssl rand -base64 32`
— stops the process with the names of the variables at fault (never their
values) in `docker compose logs`. An empty line counts as unset, and
`POSTGRES_PASSWORD` may be left out when `DATABASE_URL` names the database.

### Changing `RR_APP_KEY`

The key encrypts every secret in the database — the bot and panel tokens,
the payment providers' settings, the administrators' TOTP secrets. If it may
have leaked, make a new one (`openssl rand -base64 32`) and run:

```sh
./scripts/rr rotate-key
```

It asks for the current and the new key without echoing them, stops `api`,
`worker` and `bot`, and re-encrypts everything in one transaction — a value
the current key cannot read stops it with nothing changed. Then replace
`RR_APP_KEY` in `.env` and run `./scripts/rr up`. From a source checkout the
same tool is `pnpm rr:rotate-key --old <key> --new <key>`.

Replacing the key in `.env` without that step is caught at the next start:
when the key decrypts none of the stored secrets, the API stops with
`RR_APP_KEY decrypts none of the … stored secrets` instead of running with
empty tokens.

`init-env.sh` writes `POSTGRES_PASSWORD` single-quoted, so any character but
a single quote is safe in it, and generates one if you type none. Edit it by
hand the same way: without the quotes compose drops a `$name` from the value
and cuts it at ` #`. The application builds its connection URL from the
`POSTGRES_*` variables itself; set `DATABASE_URL` only to point it elsewhere,
percent-encoding the password.

`.env.example` documents the optional ones with comments.

## Choosing a proxy profile

| Profile    | TLS                                           | When                                                   |
| ---------- | --------------------------------------------- | ------------------------------------------------------ |
| `nginx`    | ACME module, certbot, or your own certificate | the default; nothing else on the server uses 80/443    |
| `caddy`    | its own ACME client, or your own certificate  | you prefer Caddy, or want HTTP/3 with no extra thought |
| `external` | none — RemnaRay terminates no TLS             | something else already owns 80/443                     |

Switching is one variable and `./scripts/rr up`; nothing else changes.
[`proxy.md`](proxy.md) explains how the configuration is generated,
[`tls.md`](tls.md) covers the certificate modes, and
[`external-proxy.md`](external-proxy.md) has ready snippets for nginx on the
host, Traefik and Cloudflare.

## Hardening

- **Keep `.env` off the backups.** An archive holding both the ciphertext and
  its key protects nothing, which is why `backup` never copies it.
- **Set `RR_TRUSTED_PROXIES`** to the addresses whose `X-Forwarded-*` headers
  you believe. The compose subnet `172.28.0.0/16` is always in it — with your
  own proxy the API's peer is still the `edge` container — followed by your
  provider's ranges if there is a CDN in front. Unset means
  nobody is believed, which is the safe default and not the useful one.
- **Restrict the console** with the administration allowlist in Settings →
  Security if your administrators have fixed addresses.
- **Take a backup before the first upgrade** and check you can restore it:
  [`backup.md`](backup.md).

## Afterwards

- [`admin.md`](admin.md) — the console
- [`theming.md`](theming.md) — your brand without a fork
- [`i18n.md`](i18n.md) — the texts
- [`payments/README.md`](payments/README.md) — the providers
- [`monitoring.md`](monitoring.md) — metrics and the optional dashboards
- [`upgrade.md`](upgrade.md) — staying current
- [`troubleshooting.md`](troubleshooting.md) — when something does not answer
