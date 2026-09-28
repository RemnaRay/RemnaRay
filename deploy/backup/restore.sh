#!/bin/sh
# Section 20.5 restore, run from the repository root on the server:
#
#   ./deploy/backup/restore.sh backups/remnaray-20260920-0300.dump
#
# It performs exactly the documented sequence, and refuses to guess: the dump
# has to exist and the operator has to confirm, because the current database
# is replaced by the dump's. The themes and uploads archive the backup took
# with the dump (`files-<stamp>.tar.gz`, section 20.5) is restored with it.
set -eu

dump=${1:-}
compose_file=${COMPOSE_FILE:-compose.yaml}
profile=${RR_PROXY_PROFILE:-nginx}
project_dir=$(cd "$(dirname "$compose_file")" && pwd)

if [ -z "$dump" ] || [ ! -f "$dump" ]; then
  echo "Usage: $0 <backups/remnaray-<stamp>.dump>" >&2
  exit 1
fi

# `remnaray-<stamp>.dump` goes with `files-<stamp>.tar.gz`, and a weekly dump
# with `files-weekly-<stamp>.tar.gz`, kept as long as it is (a weekly dump
# older than R112 has only the daily archive, while it lasts); a pre-migrate
# dump has none.
stamp=$(basename "$dump" .dump | sed -e 's/^remnaray-weekly-//' -e 's/^remnaray-//')
directory=$(cd "$(dirname "$dump")" && pwd)
files="$directory/files-$stamp.tar.gz"
case "$(basename "$dump")" in
  remnaray-weekly-*)
    if [ -f "$directory/files-weekly-$stamp.tar.gz" ]; then
      files="$directory/files-weekly-$stamp.tar.gz"
    fi
    ;;
esac

if [ "${RR_RESTORE_ASSUME_YES:-}" != 'true' ]; then
  printf 'This replaces the contents of the current database with %s. Continue? [y/N] ' "$dump"
  read -r answer
  case "$answer" in y | Y | yes | YES) ;; *) echo 'Aborted.' >&2; exit 1 ;; esac
fi

echo '1/5 stopping the stack'
docker compose -f "$compose_file" --profile "$profile" down

echo '2/5 starting PostgreSQL alone'
docker compose -f "$compose_file" up -d postgres
# The user and database are the container's own, which compose takes from
# `.env`: this shell never reads `.env`, so a changed POSTGRES_USER or
# POSTGRES_DB expanded here would be the defaults. Readiness is asked over TCP:
# on an empty volume (26.4 R3 removes it) the image first initialises with a
# server on the socket only, which answers ready and then restarts.
until docker compose -f "$compose_file" exec -T postgres \
  sh -c 'pg_isready -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' >/dev/null 2>&1; do
  sleep 1
done

# Into a fresh database, never over the live one (P-4): a dump older than
# the schema — the rollback of section 20.6, or a daily dump after an upgrade —
# cannot `--clean` a table a newer one references, and a half-done restore
# would leave both. The fresh database replaces the old one only once the
# whole dump is in; until then the old one is untouched.
echo '3/5 restoring the database'
if ! docker compose -f "$compose_file" exec -T postgres sh -c '
  set -eu
  admin() {
    psql -X -q -v ON_ERROR_STOP=1 -v db="$POSTGRES_DB" -v fresh="${POSTGRES_DB}_restore" \
      -U "$POSTGRES_USER" -d template1
  }
  printf "%s\n" "DROP DATABASE IF EXISTS :\"fresh\";" "CREATE DATABASE :\"fresh\";" | admin
  pg_restore -U "$POSTGRES_USER" -d "${POSTGRES_DB}_restore" --single-transaction --exit-on-error
  printf "%s\n" "DROP DATABASE :\"db\" WITH (FORCE);" \
    "ALTER DATABASE :\"fresh\" RENAME TO :\"db\";" | admin
' < "$dump"; then
  echo 'The restore failed; the current database is unchanged.' >&2
  echo 'Start the stack again with ./scripts/rr up.' >&2
  exit 1
fi

echo '4/5 restoring themes and uploads'
if [ -f "$files" ]; then
  # A one-off `backup` container writes into ./themes and the `uploads`
  # volume, which the running service only reads. Existing files the archive
  # does not name are left in place.
  docker compose -f "$compose_file" --profile "$profile" run --rm -T --no-deps \
    --entrypoint sh \
    -v "$files:/restore/files.tar.gz:ro" \
    -v "$project_dir/themes:/restore/themes" \
    -v uploads:/restore/uploads \
    backup -c 'tar -xzf /restore/files.tar.gz -C /restore'
else
  echo "  no $(basename "$files") next to the dump; themes and uploads are left as they are"
fi

# A pre-migrate dump holds the schema of the version the upgrade left, and
# `.env` may still name the new one, whose `migrate` would apply the same
# irreversible migration again at once (R59). The owner picks the version.
case "$(basename "$dump")" in
  pre-migrate-*)
    echo '5/5 not starting the stack: this dump is from before an upgrade.'
    echo 'Set RR_VERSION in .env to the version you are going back to, then run:'
    echo '  ./scripts/rr up'
    exit 0
    ;;
esac

echo '5/5 starting the stack'
docker compose -f "$compose_file" --profile "$profile" up -d
echo 'Restored. Check /admin/system and the bot before announcing it.'
