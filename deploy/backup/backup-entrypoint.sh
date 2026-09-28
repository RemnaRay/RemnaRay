#!/bin/sh
# Section 20.5: a daily dump at 03:00 UTC, kept 14 daily and 8 weekly, with an
# optional copy to S3 and a status file `maintenance.backup-check` reads.
#
# Subcommands exist so an operator — and the acceptance test — can run one step
# without waiting for the schedule:
#   once     take a backup now (dump, archive, rotate, upload, status)
#   rotate   apply the retention policy to whatever is already there
#   run      install the crontab and stay in the foreground (the default)
set -eu

BACKUP_DIR=${RR_BACKUP_DIR:-/backups}
SOURCE_DIR=${RR_BACKUP_SOURCE_DIR:-/src}
DAILY_KEEP=${RR_BACKUP_DAILY_KEEP:-14}
WEEKLY_KEEP=${RR_BACKUP_WEEKLY_KEEP:-8}
STATUS_FILE="$BACKUP_DIR/.last-status"

log() { printf '%s backup: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

status() {
  # One line, so `maintenance.backup-check` needs no parser: state, timestamp,
  # the file it produced and its size in bytes.
  printf '%s %s %s %s\n' "$1" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${2:--}" "${3:-0}" \
    > "$STATUS_FILE"
}

# Keeps the newest $DAILY_KEEP dumps and the newest $WEEKLY_KEEP Sunday ones.
# Sunday dumps are hard links made when the dump is taken, so a weekly copy
# costs no extra space and the two retentions never fight over one file.
rotate() {
  prune 'remnaray-2*.dump' "$DAILY_KEEP"
  prune 'remnaray-weekly-*.dump' "$WEEKLY_KEEP"
  prune 'files-2*.tar.gz' "$DAILY_KEEP"
}

prune() {
  pattern=$1
  keep=$2
  # The names sort chronologically, so the newest are simply the last ones.
  # shellcheck disable=SC2012
  ls "$BACKUP_DIR"/$pattern 2>/dev/null | sort | head -n -"$keep" | while read -r stale; do
    [ -n "$stale" ] || continue
    log "pruning $(basename "$stale")"
    rm -f "$stale"
  done
}

upload() {
  file=$1
  [ -n "${RR_BACKUP_S3_BUCKET:-}" ] || return 0
  [ -n "${RR_BACKUP_S3_ENDPOINT:-}" ] || return 0
  mcli --quiet alias set rr "$RR_BACKUP_S3_ENDPOINT" \
    "${RR_BACKUP_S3_ACCESS_KEY:-}" "${RR_BACKUP_S3_SECRET_KEY:-}" >/dev/null
  target="rr/$RR_BACKUP_S3_BUCKET/${RR_BACKUP_S3_PREFIX:+$RR_BACKUP_S3_PREFIX/}$(basename "$file")"
  mcli --quiet cp "$file" "$target" >/dev/null
  log "uploaded $(basename "$file") to $target"
}

once() {
  mkdir -p "$BACKUP_DIR"
  stamp=$(date -u +%Y%m%d-%H%M)
  dump="$BACKUP_DIR/remnaray-$stamp.dump"

  if ! PGPASSWORD=${POSTGRES_PASSWORD:-} pg_dump \
    --host "${POSTGRES_HOST:-postgres}" \
    --username "${POSTGRES_USER:-remnaray}" \
    --dbname "${POSTGRES_DB:-remnaray}" \
    --format=custom --compress=6 --file "$dump"; then
    log 'pg_dump failed'
    rm -f "$dump"
    status failed
    return 1
  fi
  size=$(wc -c < "$dump" | tr -d ' ')
  log "wrote $(basename "$dump") ($size bytes)"

  # Sunday keeps a second name for the weekly retention; a hard link, so the
  # bytes are not stored twice.
  if [ "$(date -u +%u)" = '7' ]; then
    ln -f "$dump" "$BACKUP_DIR/remnaray-weekly-$stamp.dump"
    log "linked the weekly copy for $stamp"
  fi

  # Section 20.5: the theme and upload directories travel with the dump.
  # `.env` never does — the README requires keeping it separately.
  if [ -d "$SOURCE_DIR" ]; then
    tar -czf "$BACKUP_DIR/files-$stamp.tar.gz" -C "$SOURCE_DIR" . 2>/dev/null || true
  fi

  rotate
  upload "$dump" || log 'S3 upload failed'
  status ok "$(basename "$dump")" "$size"
}

# `migrate` runs as `node` (uid 1000 in `node:24-alpine`) and writes its
# pre-migrate dump here; `./backups` itself is whoever cloned the repository's,
# often root (R60). The service's healthcheck waits for this.
prepare() {
  mkdir -p "$BACKUP_DIR/pre-migrate"
  chown 1000:1000 "$BACKUP_DIR/pre-migrate"
  chmod 700 "$BACKUP_DIR/pre-migrate"
}

case "${1:-run}" in
  once) once ;;
  rotate) rotate ;;
  run)
    mkdir -p "$BACKUP_DIR" /etc/crontabs
    prepare
    echo "0 3 * * * /scripts/backup-entrypoint.sh once >> /proc/1/fd/1 2>&1" > /etc/crontabs/root
    log 'scheduled the daily dump at 03:00 UTC'
    exec crond -f -l 8
    ;;
  *)
    echo "Usage: backup-entrypoint.sh {run|once|rotate}" >&2
    exit 1
    ;;
esac
