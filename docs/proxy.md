# The proxy profiles

RemnaRay ships its own reverse proxy so the owner never writes a proxy
configuration. `RR_PROXY_PROFILE` chooses one of `nginx` (the default),
`caddy` or `external`, and `./rr up` starts exactly that set of containers
(section 21.1).

## How a configuration reaches nginx

```
settings.domain.* ─┐
settings.admin.ip_allowlist ─┼─► proxy-config ──► proxy-conf volume ──► proxy-nginx
.env ─┘                 (render-proxy.js)        │
                                                 └─► rr:proxy.reload ──► proxy-reloader
```

- `proxy-config` runs `dist/tools/render-proxy.js --watch`. It renders
  `deploy/proxy/<profile>` for the shared `proxy-conf` volume. The files there
  are the last configuration known to be good, and only a validated render
  replaces them: a render that changes them is written to `.staging/` in the
  same volume, and `proxy-config` asks `proxy-reloader` (`rr:proxy.validate`)
  to check it in the running proxy — `nginx -t -c
/etc/nginx/conf.d/.staging/nginx.conf` or `caddy validate --config
/etc/caddy/.staging/Caddyfile`. The templates include each other by
  relative path, so the staged files are checked together. Accepted, the
  render replaces the live files (each written to a `.tmp` name and renamed,
  so nginx never reads a half-written file) and `rr:proxy.reload` follows.
  Refused, the live files stay, the refusal is reported like a refused reload
  (below), and `.staging/` is left for inspection. With no running proxy to
  ask — the first seconds of `rr up` — the live files stay, the proxy starts
  on them, and the render is tried again every 15 s. Only the very first
  render, with nothing live yet, is written straight away. `rr proxy:render`
  exits non-zero when its render was refused or could not be checked.
- `proxy-reloader` is the only container with the docker socket, mounted
  read-only. On `rr:proxy.validate` it runs the check above and answers on
  `rr:proxy.validated` (`ok`, `invalid`, or `unavailable` when the proxy
  cannot run it). On `rr:proxy.reload` it runs `nginx -t` inside
  `proxy-nginx` and reloads only if that passes, so a broken render never
  takes the site down — not now, and not at the proxy's next start.
  One reload runs at a time; a request that arrives during it is applied
  right after it, and any number of them make one more reload.
  Every outcome is reported to `POST /api/internal/v1/system/proxy-reload-result`,
  which writes `audit_log(action=proxy.reload)` and raises the
  `proxy.config_invalid` alert on a refusal. A report the API refuses — it
  answers `503` to every internal call until the setup wizard finishes, and
  the wizard's domain step is what reloads — is kept and sent again every 30 s
  and before the next one, until recorded.
- certbot's `--deploy-hook` updates the root-owned certificate list in the
  separate `certbot-state` volume and touches `/run/remnaray/certbot/.renewed`;
  the reloader watches that marker and reloads gracefully after a renewal.

## Templates

`deploy/proxy/nginx/` holds the whole configuration:

| File                       | Rendered as          | Notes                                            |
| -------------------------- | -------------------- | ------------------------------------------------ |
| `nginx.conf.tmpl`          | `nginx.conf`         | the main file; nginx is started with `-c` on it  |
| `site.conf.tmpl`           | `site.conf`          | the `:80` redirect and the `:443` shop           |
| `site-bootstrap.conf.tmpl` | `site.conf`          | HTTP only, while certbot has no certificate yet  |
| `site-locations.inc.tmpl`  | `site-locations.inc` | the shop's locations, included by both of them   |
| `tls-<mode>.inc.tmpl`      | `tls-<mode>.inc`     | http-level TLS setup; only `acme` needs anything |
| `tls-cert-<mode>.inc.tmpl` | `tls-cert.inc`       | the certificate directives of the active mode    |
| `ratelimits.inc`           | copied               | the section 19.2 zones                           |
| `security-headers.inc`     | copied               | the section 19 response headers                  |
| `common-proxy.inc`         | copied               | the upstream headers and timeouts                |
| `custom.d/*.conf`          | copied, never wiped  | the owner's single extension point               |

`security-headers.inc` uses nginx's `add_header_inherit merge` so the shared
headers remain on nested locations that add their own cache or content headers.
This covers static Next.js assets, theme assets, `/healthz` and error responses
as well as the main HTML pages. The web image disables Next.js's
`X-Powered-By` response header, and the `rr_lang` locale cookie is marked
`Secure` when the language is changed.

The values come in as they are, so only valid ones get there: `domain.main`
and `domain.extra_domains` must be host names and `admin.ip_allowlist` IP
addresses or CIDR ranges — the settings API refuses anything else, and the
renderer drops a stored value that is not (falling back to `RR_DOMAIN` for the
domain), so a character that ends a directive or a block never reaches a
configuration.

Placeholders are `{{NAME}}` and nothing else is interpreted: `DOMAIN`,
`EXTRA_DOMAINS`, `ACME_EMAIL`, `TLS_MODE`, `DOCKER_CIDR`, `ADMIN_ALLOWLIST`,
`ADMIN_ALLOWLIST_BLOCK`, `API_DOCS_BLOCK`, `INTERNAL_API_BLOCK`,
`LOAD_MODULE_BLOCK`, `EXTRA_DOMAINS_SUFFIX` and `EXTRA_DOMAINS_SERVER`.

`/api/internal/*` is the API of the bot and the worker (section 9.5), which
reach `api:3000` on the compose network. Both profiles answer it themselves
with `404`, and so does the `edge` of the external profile. Only the section
22.7 smoke stand, which sets `RR_ECHO_HEADERS=true` on `proxy-config`, routes
it, for the header echo of step 5 and the browser suite's sign-in. In the
Caddy profile this and the `/api/docs` denial are `handle` blocks: a bare
`respond` is ordered after `handle`, so `handle /api/*` would answer first.

The `extra_domains` redirect server is emitted only when there are extra
domains: an empty `server_name` would make nginx redirect every unmatched host.
The administration allowlist and the `/api/docs` denial are emitted only when
they apply, so an empty setting leaves no stray `deny all;` behind.

## TLS modes

| `RR_TLS_MODE` | Certificate                                             |
| ------------- | ------------------------------------------------------- |
| `acme`        | `nginx-module-acme` issues and renews it over HTTP-01   |
| `certbot`     | the `certbot` container, files under `/etc/letsencrypt` |
| `custom`      | the owner's files in `deploy/proxy/certs/`              |
| `none`        | `external` profile only; RemnaRay terminates no TLS     |

`acme` is the default. `load_module modules/ngx_http_acme_module.so;` is
rendered only for that mode, so the other two run on a stock nginx. OCSP
stapling is enabled for `certbot` only: the ACME module serves the certificate
through variables, which stapling does not support, and a `custom` certificate
may be self-signed.

Until certbot has a certificate, `site.conf` is the HTTP-only bootstrap. It
carries the shop's own locations (`site-locations.inc`), so `/api/internal/*`
answers `404` and the console keeps its allowlist and limits before the first
certificate too.

## The Caddy profile

`RR_PROXY_PROFILE=caddy` renders `deploy/proxy/caddy/Caddyfile.tmpl` into the
same `proxy-conf` volume, and `proxy-reloader` applies it with
`caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile`. Section 21.5
requires the two profiles to be indistinguishable from outside: the same paths,
the same statuses, the same security headers, the same `405` on a non-POST
webhook and the same `403` on `/metrics` from outside the compose network.

Caddy issues and renews its own certificates, so only two TLS modes apply.
`acme` is the default and needs no configuration; `custom` renders
`tls /certs/fullchain.pem /certs/privkey.pem` from the same
`deploy/proxy/certs/` directory the nginx profile uses. Section 21.4 writes
that path as `/etc/caddy/certs`, but `/etc/caddy` is the read-only `proxy-conf`
volume and Docker cannot create a mount point inside it, so the directory is
mounted at `/certs` instead. `certbot` has no
meaning here and the renderer refuses it rather than emit something that would
silently not work.

`ghcr.io/remnaray/caddy` is `caddy:2.11.4-alpine` rebuilt with
`github.com/mholt/caddy-ratelimit`, because the official image has no
rate-limit module. The zones carry the nginx allowance (`rate × window +
burst`, as events of a sliding window): `rr_webhooks` 360/10s, `rr_auth` 15/1m
(the setup wizard), `rr_signin` 15/1m counting `POST`s only, `rr_admin` 240/1m,
`rr_api` 130/10s and `rr_general` 250/10s.

Sign-in and the console are limited apart (owner decision F17, 2026-09-26, a
deviation from the section 21.3 template, which put all of
`/api/admin/v1/auth/` under 5 r/m): only the sign-in and TOTP `POST`s spend
the 5 r/m `rr_signin` allowance (section 9.1 limits `POST /auth/*`); the
console reading its own session, `GET /api/admin/v1/auth/me` on every page,
counts in `rr_admin`, raised to 120 r/m with a burst of 120 so that switching
console pages quickly is not answered 429. An owner who sets `RR_CADDY_IMAGE=caddy:2-alpine` gets a Caddyfile
with no `rate_limit` blocks — the documented degradation of section 21.4, with
the limits left to `@nestjs/throttler`. `GET /api/admin/v1/system` reports it
as `proxy.rateLimited: false` so the administration console can say so.

`custom.d/*.caddy` is the extension point, imported at the end of the site
block exactly as `custom.d/*.conf` is in the nginx profile.

## The image

`deploy/proxy/nginx/Dockerfile` is `nginx:1.30-alpine` plus
`nginx-module-acme`, both pinned. The module is published only by nginx.org and
only for the exact nginx patch it was built against, so a base image that moves
ahead of the module fails the build in CI rather than on the owner's server.
The base image already carries nginx.org's signing key.

## Tests

`pnpm test:m5` builds the image, asserts the module is in it, renders the
configuration for `acme`, `certbot` and `custom` and runs `nginx -t` on each,
then changes `settings.domain.main` and measures the time until the rendered
configuration carries the new domain and the reloader has reported a successful
apply — the section 25.6 budget is fifteen seconds. `nginx -t` loads the
certificate files, so the test mounts a throwaway self-signed pair for the two
modes that name real paths.

It then builds the Caddy image, asserts the rate-limit module is in it, renders
`acme`, `custom` and a stock-image variant, and runs `caddy validate` on each —
`caddy validate` loads the certificate files too, so `custom` gets the same
throwaway pair. It also asserts that `certbot` is refused for the profile.

`apps/api/src/tools/proxy-render.test.ts` covers the rendering itself:
placeholder substitution, the per-mode file set, the bootstrap configuration,
the conditional blocks, the Caddy zones and the atomic write.

## The smoke run: both profiles answer the same

Section 21.5 says the only difference between the profiles is which containers
run. `deploy/ci/proxy-smoke.sh <nginx|caddy>` is what makes that a fact:

```sh
deploy/ci/proxy-smoke.sh nginx
deploy/ci/proxy-smoke.sh caddy
```

It builds a stand from `compose.yaml` plus `deploy/ci/compose.smoke.yaml`, with
a self-signed certificate for `rr.test` (`RR_TLS_MODE=custom` — ACME has no
public domain to answer for on a runner), seeds the section 22.3 fixture with
`dist/tools/seed-dev.js`, and then runs the ten checks of section 22.7:
`/healthz`, the whole path table, the security headers, the upstream echo,
compression, HTTP/2, the HTTP redirect, the reload, and the browser suite.

The expected statuses are a file rather than assertions in the script:

```
# vantage	method	path	status	why
outside	GET	/webhooks/mock	405	webhooks are POST only
outside	GET	/metrics	403	not reachable from outside the compose network
```

`deploy/ci/expected-status.tsv` is read by both profiles, so a divergence is a
failed row and not two scripts that disagree.

**The vantage matters.** A request from the host to a published port is
translated to the compose gateway, which is inside `RR_TRUSTED_PROXIES` — so a
`/metrics` check made from the host would pass without proving anything. The
overlay puts the proxy on a second network, `rr_edge`, and the `outside`
requests come from there.

The stand refuses to start if a `.env` is already present, because it writes
its own, and it removes the stand and that file when it finishes.
`RR_SMOKE_KEEP=true` leaves both in place to look at.

Section 26.4 X2 runs the same script against a live deployment:

```sh
RR_SMOKE_NO_STACK=true RR_SMOKE_DOMAIN=shop.example.com \
  deploy/ci/proxy-smoke.sh nginx
```

Then nothing is created or removed; the checks run against the deployment as it
is, and the `outside` and `inside` vantages still need the two networks the
overlay adds.

CI runs both profiles as a matrix on every pull request, and both have to be
green to merge.
