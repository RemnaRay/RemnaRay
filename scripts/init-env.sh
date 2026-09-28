#!/usr/bin/env sh
set -eu

umask 077
env_file=${1:-.env}

if [ -e "$env_file" ]; then
  printf '%s already exists; refusing to overwrite.\n' "$env_file" >&2
  exit 1
fi

printf 'Domain: '
read -r domain
printf 'ACME email: '
read -r acme_email
printf 'PostgreSQL password (empty to generate one): '
# Not a terminal when the answers are piped in; there is nothing to hide then.
stty -echo 2>/dev/null || true
IFS= read -r postgres_password || true
stty echo 2>/dev/null || true
printf '\n'
if [ -z "$postgres_password" ]; then
  postgres_password=$(openssl rand -hex 24)
  printf 'Generated a PostgreSQL password.\n'
fi
# Written single-quoted, which compose reads literally: `$` is not expanded
# and ` #` does not start a comment. A single quote cannot be written inside.
case "$postgres_password" in
  *\'*)
    printf 'The PostgreSQL password cannot contain a single quote.\n' >&2
    exit 1
    ;;
esac

app_key=$(openssl rand -base64 32 | tr -d '\n')
internal_token=$(openssl rand -base64 32 | tr -d '\n')
setup_token=$(openssl rand -base64 24 | tr -d '\n')
# P-21: the compose Valkey's password; hex, so it needs no escaping in a URL.
valkey_password=$(openssl rand -hex 24)
# Used only with --profile monitoring; Grafana refuses to start without one.
grafana_password=$(openssl rand -hex 16)

cat > "$env_file" <<ENV
RR_DOMAIN=$domain
RR_ACME_EMAIL=$acme_email
RR_PROXY_PROFILE=nginx
RR_TLS_MODE=acme
RR_APP_KEY=$app_key
RR_SETUP_TOKEN=$setup_token
RR_INTERNAL_TOKEN=$internal_token
POSTGRES_PASSWORD='$postgres_password'
POSTGRES_USER=remnaray
POSTGRES_DB=remnaray
VALKEY_PASSWORD=$valkey_password
RR_TRUSTED_PROXIES=172.28.0.0/16
RR_EXTERNAL_HTTP_PORT=8080
RR_LOG_LEVEL=info
RR_PAYMENTS_MOCK=false
RR_GRAFANA_PASSWORD=$grafana_password
ENV
chmod 600 "$env_file"
printf 'Created %s with mode 600.\n' "$env_file"
printf 'RR_SETUP_TOKEN=%s\n' "$setup_token"
