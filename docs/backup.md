# Backups and restore

Section 20.5. The `backup` service runs in every profile and takes one dump a
day; `NFR-014` sets the targets it is built for: **RPO 24 hours, RTO 30
minutes**.

## What is kept

| File                                               | What                                            |
| -------------------------------------------------- | ----------------------------------------------- |
| `remnaray-<yyyymmdd-HHMM>.dump`                    | `pg_dump -Fc -Z 6` of the whole database        |
| `remnaray-weekly-<stamp>.dump`                     | a hard link made on Sundays, for the 8 weeklies |
| `files-<stamp>.tar.gz`                             | `themes/` and `uploads/`                        |
| `.last-status`                                     | one line: state, time, file, size               |
| `pre-migrate/pre-migrate-<migration>-<stamp>.dump` | written by `migrate`; see below                 |

The dumps and archives hold everything the database and the uploads do, so
they are written `0600` and handed to the owner of `backups/` — whoever
restores from the host reads them, no other user of the host does. The
directory is `0711`: the worker reaches `.last-status` (`0644`) through it
without listing it.

`.env` is never copied. It holds `RR_APP_KEY`, and a backup that carries both
the ciphertext and the key protects nothing — the README asks you to keep it
somewhere else.

Valkey is not backed up either: sessions and queues rebuild themselves. People
sign in again, the cron regenerates the scans, and unfinished `outbox_jobs`
live in PostgreSQL.

## Retention

Fourteen daily dumps and eight weekly ones. The weekly copy is a hard link, so
a Sunday costs no extra space and the two retentions never argue over the same
file: the daily rule prunes `remnaray-<stamp>.dump`, the weekly rule prunes
`remnaray-weekly-<stamp>.dump`, and the bytes go only when the last name does.

`docker compose exec backup /scripts/backup-entrypoint.sh once` takes one now,
and `… rotate` applies the retention without taking one.

## S3

Set `RR_BACKUP_S3_ENDPOINT` and `RR_BACKUP_S3_BUCKET` — and the keys, and
optionally `RR_BACKUP_S3_PREFIX` — and each dump is copied with the MinIO
client after it is written. The keys reach the client through its environment
(`MC_HOST_rr`), never a command line another user of the host could see in
`ps`; an endpoint without a scheme is taken as `https://`. With the variables unset the step is skipped
silently; the local copy is the same either way. A failed upload does not fail
the backup, because a dump on disk is better than no dump at all, and it is
logged.

## Restore

```sh
./deploy/backup/restore.sh backups/remnaray-20260920-0300.dump
```

It performs the section 20.5 sequence — stop the stack, start PostgreSQL
alone, restore, start the stack — and asks for confirmation first, because
the current database is replaced. Set `RR_RESTORE_ASSUME_YES=true` to skip the
prompt in a script.

- It restores into a fresh database (`<POSTGRES_DB>_restore`) in one
  transaction, and only when that succeeded drops the current database and
  renames the fresh one in its place. Section 20.5 names
  `pg_restore --clean --if-exists` into the live database; that fails on a
  dump older than the schema (a rollback, or a daily dump restored after an
  upgrade), because a newer table can hold a foreign key to an older one. If
  the restore fails, the current database is unchanged and the stack stays
  stopped: `./scripts/rr up` starts it again.

- It restores as the database user and into the database PostgreSQL itself was
  given (`POSTGRES_USER`, `POSTGRES_DB` in `.env`), whatever the shell has.
- When `files-<stamp>.tar.gz` of the same stamp lies next to the dump, it
  restores `themes/` and the `uploads` volume from it too; files the archive
  does not name are kept. A pre-migrate dump has no such archive, and the
  files are then left as they are.
- It waits for PostgreSQL over TCP, so it also works on an empty data volume
  (acceptance 26.4 R3 removes it first).

## The pre-migrate dump

Section 20.4: the `migrate` service applies migrations before `api`, `bot` and
`worker` start. When a pending migration does not say `-- reversible: yes` in
its header — `no`, anything else, or no header — it first takes
`backups/pre-migrate/pre-migrate-<last applied migration>-<yyyymmdd-HHMMSS>.dump`
of the database it is about to migrate (the same host, port and name), so a
rollback has something to go back to. The name is the schema the dump holds —
the version the upgrade leaves — and the time, so neither two upgrades nor two
attempts at one replace an earlier dump; a dump that fails half-way is
removed. Restoring one leaves the stack stopped: set `RR_VERSION` in `.env`
to the version you are going back to, then `./scripts/rr up` (see
[`upgrade.md`](upgrade.md#going-back)). `RR_AUTO_PREMIGRATE_BACKUP=false` turns
the dump off.

`migrate` runs as uid 1000, while `./backups` belongs to whoever cloned the
repository — often root. The `backup` service, which runs as root, creates
`backups/pre-migrate` for uid 1000 (mode 700) when it starts, and `migrate`
waits for it to be healthy.

A fresh database is not dumped: there is nothing in it yet.

## Checking it

`maintenance.backup-check` reads `.last-status` and raises the `backup.failed`
alert when the newest backup is older than 26 hours or the last run failed.
Like `tls-check` it runs at worker start and daily, and a reading the API
refused (during the setup wizard, for one) is taken again five minutes later.

## Disk space

`maintenance.disk-check` asks the filesystem of the `pgdata` volume, which the
worker mounts read-only at `/pgdata` (the database files themselves stay
unreadable to it), how much space is left. Below `admin.disk_alert_pct` of the
volume free — 10 % unless changed in the console settings — it raises the
`disk.low` alert. It runs at worker start and hourly, and `/admin/system`
shows the last reading next to the database size.
