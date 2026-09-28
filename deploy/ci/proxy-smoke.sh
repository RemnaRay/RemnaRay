#!/usr/bin/env bash
#
# Section 22.7: the same ten checks against either proxy profile. Section 21.5
# says the only difference between `nginx` and `caddy` is which containers run,
# and this script is what makes that a fact rather than an intention.
#
#   ./deploy/ci/proxy-smoke.sh nginx
#   ./deploy/ci/proxy-smoke.sh caddy
#
# The stand is `compose.yaml` with `deploy/ci/compose.smoke.yaml` on top, a
# self-signed certificate for `rr.test` (`RR_TLS_MODE=custom` — ACME has no
# public domain to answer for here) and the section 22.3 fixture in the
# database. Section 26.4 X2 also runs it against a live deployment, which is
# what `RR_SMOKE_NO_STACK=true` is for: then no stand is created or removed and
# the checks run against `RR_SMOKE_DOMAIN` as it already is.
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
Usage: deploy/ci/proxy-smoke.sh <nginx|caddy>

Environment:
  RR_SMOKE_DOMAIN        stand domain (default rr.test)
  RR_SMOKE_EXTRA_DOMAIN  the domain step 9 adds (default www.<domain>)
  RR_SMOKE_NO_STACK      true: check an existing deployment, start nothing
  RR_SMOKE_KEEP          true: leave the stand running after the run
  RR_SMOKE_NO_BROWSER    true: skip step 10 (the Playwright run)
  RR_APP_IMAGE RR_WEB_IMAGE RR_NGINX_IMAGE RR_CADDY_IMAGE RR_BACKUP_IMAGE
                         images to run (default remnaray/<name>:ci)
USAGE
}

profile=${1:-}
case "$profile" in
  nginx | caddy) ;;
  *)
    usage
    exit 2
    ;;
esac

root=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$root"

DOMAIN=${RR_SMOKE_DOMAIN:-rr.test}
EXTRA_DOMAIN=${RR_SMOKE_EXTRA_DOMAIN:-www.$DOMAIN}
CURL_IMAGE=${RR_SMOKE_CURL_IMAGE:-curlimages/curl:8.19.0}
NO_STACK=${RR_SMOKE_NO_STACK:-false}
NETWORK_INSIDE=remnaray_rr_net
NETWORK_OUTSIDE=remnaray_rr_edge
PROXY_INSIDE=172.28.0.10
PROXY_OUTSIDE=172.29.0.10
TABLE=deploy/ci/expected-status.tsv
# The seeded fixture's administrator. Against a live deployment (26.4 X2) the
# operator names their own, and `RR_SMOKE_TOTP_SECRET` replaces the fixture.
ADMIN_EMAIL=${RR_SMOKE_ADMIN_EMAIL:-owner@example.test}
ADMIN_PASSWORD=${RR_SMOKE_ADMIN_PASSWORD:-SmokePassword123}
# Section 21.6 gives the reload fifteen seconds.
RELOAD_TIMEOUT=${RR_SMOKE_RELOAD_TIMEOUT:-15}

failures=0
step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
ok() { printf '   ok    %s\n' "$*"; }
bad() {
  printf '   FAIL  %s\n' "$*"
  failures=$((failures + 1))
}
check() {
  local what=$1 expected=$2 actual=$3
  if [ "$expected" = "$actual" ]; then ok "$what → $actual"; else
    bad "$what → $actual, expected $expected"
  fi
}

compose() {
  docker compose -f compose.yaml -f deploy/ci/compose.smoke.yaml --profile "$profile" "$@"
}

# `outside` is a client on `rr_edge`, which is not in RR_TRUSTED_PROXIES;
# `inside` is one on the compose network. Both reach the proxy by name, so the
# request carries the `Host` a visitor would send.
curl_from() {
  local vantage=$1
  shift
  local network=$NETWORK_OUTSIDE address=$PROXY_OUTSIDE
  if [ "$vantage" = inside ]; then
    network=$NETWORK_INSIDE
    address=$PROXY_INSIDE
  fi
  docker run --rm --network "$network" \
    --add-host "$DOMAIN:$address" --add-host "$EXTRA_DOMAIN:$address" \
    "$CURL_IMAGE" "$@"
}

status_of() {
  local vantage=$1 method=$2 url=$3
  curl_from "$vantage" -sk -o /dev/null -w '%{http_code}' -X "$method" "$url"
}

cleanup() {
  local code=$?
  if [ "$NO_STACK" != true ] && [ "${RR_SMOKE_KEEP:-false}" != true ]; then
    printf '\n-- tearing the stand down\n'
    compose down -v --remove-orphans >/dev/null 2>&1 || true
    rm -f .env
  fi
  exit "$code"
}

# ---------------------------------------------------------------- the stand --
if [ "$NO_STACK" != true ]; then
  if [ -e .env ]; then
    printf 'A .env is already here; the stand would overwrite it. Move it aside first.\n' >&2
    exit 2
  fi
  trap cleanup EXIT INT TERM

  step "stand: $profile, custom TLS for $DOMAIN"
  sh deploy/ci/gen-selfsigned.sh "$DOMAIN"

  umask 077
  cat > .env <<ENV
RR_DOMAIN=$DOMAIN
RR_PROXY_PROFILE=$profile
RR_TLS_MODE=custom
RR_APP_KEY=$(openssl rand -base64 32 | tr -d '\n')
RR_SETUP_TOKEN=$(openssl rand -base64 24 | tr -d '\n')
RR_INTERNAL_TOKEN=$(openssl rand -base64 32 | tr -d '\n')
POSTGRES_PASSWORD=$(openssl rand -hex 16)
POSTGRES_USER=remnaray
POSTGRES_DB=remnaray
VALKEY_PASSWORD=$(openssl rand -hex 16)
RR_TRUSTED_PROXIES=172.28.0.0/16
RR_LOG_LEVEL=warn
RR_PAYMENTS_MOCK=true
RR_APP_IMAGE=${RR_APP_IMAGE:-remnaray/app:ci}
RR_WEB_IMAGE=${RR_WEB_IMAGE:-remnaray/web:ci}
RR_NGINX_IMAGE=${RR_NGINX_IMAGE:-remnaray/nginx:ci}
RR_CADDY_IMAGE=${RR_CADDY_IMAGE:-remnaray/caddy:ci}
RR_BACKUP_IMAGE=${RR_BACKUP_IMAGE:-remnaray/backup:ci}
ENV
  umask 022

  # Seeded before the applications start, not after: `api` and `web` read the
  # settings once and are told about changes over Valkey, so a row written
  # behind their backs would leave them serving SETUP_NOT_COMPLETED.
  compose up -d --wait postgres valkey
  compose run --rm -T migrate node /app/dist/tools/migrate.js > /dev/null
  compose run --rm -T --no-deps api node /app/dist/tools/seed-dev.js > deploy/ci/.stand.json
  ok "seeded the section 22.3 fixture"
  # Step 10's account spec previews a promo code, which the section 22.3
  # fixture has none of; `e2e/setup/stack.mjs` creates the same one locally.
  compose exec -T postgres psql -v ON_ERROR_STOP=1 \
    -U "$(grep -E '^POSTGRES_USER=' .env | cut -d= -f2-)" \
    -d "$(grep -E '^POSTGRES_DB=' .env | cut -d= -f2-)" -qc \
    "INSERT INTO promocodes (code, type, value, max_uses) VALUES ('E2E10', 'discount_percent', 10, 100)"
  ok "created the browser suite's promo code"

  compose up -d --wait
fi

INTERNAL_TOKEN=$(grep -E '^RR_INTERNAL_TOKEN=' .env | cut -d= -f2-)
DB_USER=$(grep -E '^POSTGRES_USER=' .env | cut -d= -f2-)
DB_NAME=$(grep -E '^POSTGRES_DB=' .env | cut -d= -f2-)

# ------------------------------------------------------------------- step 1 --
step '1. the proxy answers its own health check'
check "GET https://$DOMAIN/healthz" 200 "$(status_of outside GET "https://$DOMAIN/healthz")"

# ------------------------------------------------------- steps 2 and 4 --------
# Step 4's three cases — a non-POST webhook, `/metrics` from outside and an
# unsigned Telegram webhook — are rows of the same table, because they are the
# same kind of assertion and a second copy could disagree with the first.
step "2, 4. every path of section 21.5 against $TABLE"
while IFS=$'\t' read -r vantage method path expected _why; do
  case "$vantage" in '' | '#'*) continue ;; esac
  check "$vantage $method $path" "$expected" "$(status_of "$vantage" "$method" "https://$DOMAIN$path")"
done < "$TABLE"

# ------------------------------------------------------------------- step 3 --
step '3. the security headers of section 19.3'
headers=$(curl_from outside -skI "https://$DOMAIN/" | tr 'A-Z' 'a-z')
for header in \
  'strict-transport-security: max-age=31536000; includesubdomains' \
  'x-content-type-options: nosniff' \
  'x-frame-options: deny' \
  'referrer-policy: strict-origin-when-cross-origin' \
  'permissions-policy: camera=(), microphone=(), geolocation=()'; do
  case "$headers" in
    *"$header"*) ok "${header%%:*}" ;;
    *) bad "${header%%:*} missing or different" ;;
  esac
done
# The CSP is the one header `web` owns, because only it knows the nonce.
case "$headers" in
  *'content-security-policy: default-src '"'"'self'"'"';'*'nonce-'*) ok 'content-security-policy (from web, with a nonce)' ;;
  *) bad 'content-security-policy missing, or carries no nonce' ;;
esac

# Issue #2: a page can pass while nginx locations with their own add_header
# lose every inherited security header. Exercise actual JS/CSS, cached assets,
# an error response and the proxy's own HTTPS health response on both profiles.
check_security_headers() {
  local path=$1 expected=$2 headers header count
  headers=$(curl_from outside -sk -D - -o /dev/null -w 'smoke-status: %{http_code}\n' "https://$DOMAIN$path" | tr 'A-Z' 'a-z' | tr -d '\r')
  check "$path status" "$expected" "$(printf '%s\n' "$headers" | sed -n 's/^smoke-status: //p')"
  for header in \
    'strict-transport-security: max-age=31536000; includesubdomains' \
    'x-content-type-options: nosniff' \
    'x-frame-options: deny' \
    'referrer-policy: strict-origin-when-cross-origin' \
    'permissions-policy: camera=(), microphone=(), geolocation=()'; do
    case "$headers" in
      *"$header"*) ok "$path ${header%%:*}" ;;
      *) bad "$path ${header%%:*} missing or different" ;;
    esac
    count=$(printf '%s\n' "$headers" | grep -c "^${header%%:*}:" || true)
    check "$path ${header%%:*} occurs once" 1 "$count"
  done
  case "$headers" in
    *'x-powered-by:'*) bad "$path exposes x-powered-by" ;;
    *) ok "$path has no x-powered-by" ;;
  esac
  if [[ "$path" == /_next/static/* ]] && [ "$expected" = 200 ]; then
    case "$headers" in
      *'immutable'*) ok "$path still has immutable caching" ;;
      *) bad "$path lost immutable caching" ;;
    esac
  fi
}

html=$(curl_from outside -fsk "https://$DOMAIN/ru")
assets=$(printf '%s' "$html" | node -e '
  let html = "";
  process.stdin.on("data", (chunk) => (html += chunk));
  process.stdin.on("end", () => {
    const paths = [...html.matchAll(/(?:src|href)="(\/_next\/static\/[^"?]+\.(?:js|css))"/gu)].map((match) => match[1]);
    for (const extension of [".js", ".css"]) {
      const path = paths.find((value) => value.endsWith(extension));
      if (!path) throw new Error(`No ${extension} asset found in the rendered page`);
      console.log(path);
    }
  });
')
for path in /ru /themes/manta/favicon.svg /healthz; do
  check_security_headers "$path" 200
done
while IFS= read -r path; do
  check_security_headers "$path" 200
  check_security_headers "$path" 200
done <<< "$assets"
check_security_headers /_next/static/rr-security-missing.js 404

# Force a language change: next-intl need not set a cookie for the default.
locale_headers=$(curl_from outside -fsk -D - -o /dev/null \
  -H 'Accept-Language: ru' -H 'Cookie: rr_lang=ru' "https://$DOMAIN/en" | tr -d '\r')
locale_cookie=$(printf '%s\n' "$locale_headers" | grep -i '^set-cookie: rr_lang=en;' || true)
case "$locale_cookie" in
  *'; Secure;'* | *'; Secure') ok 'rr_lang is Secure after changing language' ;;
  *) bad 'rr_lang missing or not Secure after changing language' ;;
esac

# ------------------------------------------------------------------- step 5 --
step '5. what the upstream receives'
echoed=$(docker run --rm --network "$NETWORK_INSIDE" --add-host "$DOMAIN:$PROXY_INSIDE" \
  --entrypoint sh "$CURL_IMAGE" -c "
    printf '{\"callerIp\":\"%s\",\"echo\":' \"\$(hostname -i | tr -d ' ')\";
    curl -sk -X POST -H 'x-internal-token: $INTERNAL_TOKEN' \
      -H 'content-type: application/json' -d '{}' \
      'https://$DOMAIN/api/internal/v1/echo-headers';
    printf '}'")
eval "$(printf '%s' "$echoed" | node -e '
  let input = "";
  process.stdin.on("data", (chunk) => (input += chunk));
  process.stdin.on("end", () => {
    const { callerIp, echo } = JSON.parse(input);
    const quote = (value) => `"${String(value ?? "").replace(/"/gu, "")}"`;
    for (const [name, value] of Object.entries({
      ECHO_CALLER: callerIp,
      ECHO_PROTO: echo.forwardedProto,
      ECHO_REAL_IP: echo.realIp,
      ECHO_REQUEST_ID: echo.requestId,
      ECHO_HOST: echo.host,
    }))
      process.stdout.write(`${name}=${quote(value)}\n`);
  });
')"
check 'x-forwarded-proto' https "$ECHO_PROTO"
check 'x-real-ip is the client, not the proxy' "$ECHO_CALLER" "$ECHO_REAL_IP"
check 'host is passed through' "$DOMAIN" "$ECHO_HOST"
if [ -n "$ECHO_REQUEST_ID" ]; then ok "x-request-id → $ECHO_REQUEST_ID"; else
  bad 'x-request-id is empty'
fi

# ------------------------------------------------------------------- step 6 --
step '6. compression'
encoding=$(curl_from outside -sk -H 'Accept-Encoding: gzip' -o /dev/null -D - \
  "https://$DOMAIN/api/v1/public/config" | tr 'A-Z' 'a-z' | grep -c 'content-encoding: gzip' || true)
check 'content-encoding on /api/v1/public/config' 1 "$encoding"

# ------------------------------------------------------------------- step 7 --
step '7. HTTP/2'
version=$(curl_from outside -sk --http2 -o /dev/null -w '%{http_version}' "https://$DOMAIN/ru")
check 'negotiated version' 2 "$version"

# ------------------------------------------------------------------- step 8 --
step '8. the HTTP redirect'
redirect=$(curl_from outside -s -o /dev/null -w '%{http_code} %{redirect_url}' "http://$DOMAIN/")
check 'http:// is redirected' "301 https://$DOMAIN/" "$redirect"

# ------------------------------------------------------------------- step 9 --
step "9. a settings change reloads the proxy within ${RELOAD_TIMEOUT}s"
resolve_args=()
if [ "$NO_STACK" != true ]; then resolve_args=(--resolve 127.0.0.1); fi
session=$(RR_SMOKE_STAND_FILE=deploy/ci/.stand.json \
  node deploy/ci/admin-session.mjs "https://$DOMAIN" "$ADMIN_EMAIL" "$ADMIN_PASSWORD" "${resolve_args[@]}")
eval "$session"
before=$(date -u '+%Y-%m-%d %H:%M:%S')
curl_host=()
if [ "$NO_STACK" != true ]; then curl_host=(-k --resolve "$DOMAIN:443:127.0.0.1"); fi
applied=$(curl -s "${curl_host[@]}" \
  -X PUT "https://$DOMAIN/api/admin/v1/settings" \
  -H 'content-type: application/json' \
  -H 'x-requested-with: RemnaRay' \
  -H 'sec-fetch-site: same-origin' \
  -H "x-csrf-token: $ADMIN_CSRF" \
  -H "cookie: rr_asid=$ADMIN_SESSION" \
  -o /dev/null -w '%{http_code}' \
  -d "{\"patch\":{\"domain.extra_domains\":[\"$EXTRA_DOMAIN\"]}}")
check 'PUT /api/admin/v1/settings' 200 "$applied"

reloaded=no
deadline=$((SECONDS + RELOAD_TIMEOUT))
while [ "$SECONDS" -lt "$deadline" ]; do
  rows=$(compose exec -T postgres psql -U "$DB_USER" -d "$DB_NAME" -tAc \
    "select count(*) from audit_log where action = 'proxy.reload'
       and after->>'ok' = 'true' and created_at >= timestamptz '$before+00'" | tr -d '[:space:]')
  if [ "${rows:-0}" -ge 1 ]; then
    reloaded=yes
    break
  fi
  sleep 1
done
check 'audit_log proxy.reload ok' yes "$reloaded"
check "https://$EXTRA_DOMAIN/ redirects" 301 "$(status_of outside GET "https://$EXTRA_DOMAIN/")"

# ------------------------------------------------------------------ step 10 --
if [ "${RR_SMOKE_NO_BROWSER:-false}" = true ]; then
  step '10. the browser suite — skipped by RR_SMOKE_NO_BROWSER'
else
  step '10. the browser suite against this stand'
  # Chromium is told where the stand is with `--host-resolver-rules`, but the
  # request context the specs use for their scaffolding is Node's and reads
  # the resolver. One line in /etc/hosts serves both.
  if ! getent hosts "$DOMAIN" > /dev/null 2>&1; then
    if sudo -n true 2> /dev/null; then
      printf '127.0.0.1 %s %s\n' "$DOMAIN" "$EXTRA_DOMAIN" | sudo tee -a /etc/hosts > /dev/null
      ok "added $DOMAIN to /etc/hosts"
    else
      bad "$DOMAIN does not resolve here: add '127.0.0.1 $DOMAIN $EXTRA_DOMAIN' to /etc/hosts"
    fi
  fi
  if RR_E2E_EXTERNAL_STACK=true RR_E2E_BASE_URL="https://$DOMAIN" \
    RR_E2E_STAND_FILE=deploy/ci/.stand.json \
    RR_E2E_INTERNAL_TOKEN="$INTERNAL_TOKEN" \
    pnpm exec playwright test -c e2e/playwright.config.ts; then
    ok 'playwright'
  else
    bad 'playwright'
  fi
fi

# ------------------------------------------------------------------ verdict --
printf '\n'
if [ "$failures" -eq 0 ]; then
  printf '\033[32mproxy-smoke %s: all checks passed\033[0m\n' "$profile"
else
  printf '\033[31mproxy-smoke %s: %d check(s) failed\033[0m\n' "$profile" "$failures"
  exit 1
fi
