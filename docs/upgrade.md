# Upgrading

`compose.yaml` follows the major line: the images resolve to
`ghcr.io/remnaray/<image>:${RR_VERSION:-1}`, so a pull brings the current minor
and patch of major 1. Pin `RR_VERSION=1.2.3` in `.env` if you would rather
decide each time.

`1` and `1.2` always name the newest final release of their line. A security
patch to the previous minor moves `1.1` but not `1`, and a release candidate
moves neither.

## The procedure

```sh
git pull                      # the compose files and the proxy templates
# read the CHANGELOG section for the version you are moving to
./scripts/rr up --pull        # pulls the images of your profile, then starts
docker compose ps
```

`up` pulls on its own only for a tag that is not a release's (such as `dev`);
for a release tag it starts whatever image is on the server, which is why the
upgrade asks for `--pull` (or a `docker compose pull` of its own).

`migrate` runs first and `api`, `bot` and `worker` wait for it. Downtime is the
length of the migrations, usually seconds. `web` and the proxy are not
restarted unless their image changed, so the site stays up while the API
restarts.

Afterwards, open **Settings → System** in the console: it shows the panel, the
queues, the certificate and the last backup.

## Knowing there is one

Once a day the worker asks GitHub Releases which versions exist, and
`/admin/system` says "version X.Y.Z is available" when one is newer than the
running image, with a **security** badge when a release on the way fixes a
vulnerability (its notes carry the Security section that pull requests
labelled `security` fill). Turn it off with the `admin.check_updates` setting;
GitHub is then not contacted at all. A fork points it at its own repository
with `RR_UPDATE_REPOSITORY=<owner>/<repo>` in `.env`. An image built from a
source checkout is `0.0.0-dev` and never claims an update.

## Read the changelog first

Every release says what an owner has to know under three headings:

- **⚠ Breaking** — behaviour that changes.
- **Migration notes (reversible: yes/no)** — whether the database change can be
  undone. A migration marked `reversible: no` means the only way back is a
  restore.
- **Downgrade path** — what to do if you want to go back.

Before an irreversible migration, `migrate` takes a dump of its own into
`backups/pre-migrate-<version>.dump` (`RR_AUTO_PREMIGRATE_BACKUP`, on by
default). It is a safety net, not a backup policy: see
[`backup.md`](backup.md).

### Plans without squads (migrations 0008 and 0009)

A plan must name at least one panel squad (section 8): the panel receives the
squads as the customer's own, so a plan without any takes every squad away
from the customers who buy it. The upgrade takes such a plan off sale (its
slugs are printed by the `migrate` service) instead of failing. Open «Тарифы»
in the console: a plan marked «Нет сквадов» can be deleted, or edited to tick
its squads and put back on sale; it cannot be activated without them.

## Going back

```sh
RR_VERSION=1.2.2 docker compose pull
RR_VERSION=1.2.2 ./scripts/rr up
```

That works while no irreversible migration has run in between. When one has,
restore the pre-migrate dump first:

```sh
./scripts/rr restore backups/pre-migrate-1.2.3.dump
```

## Security rebuilds

The base images move faster than the application. Every Monday the five images
are rebuilt on the current `node`, `nginx`, `caddy` and `postgres` bases,
scanned, and published as `X.Y.Z-<yyyymmdd>` with the floating `X.Y` and `X`
tags moved onto them. The rebuild takes the highest published release, and a
manual rebuild of an older version moves only the floating tags it is still
the newest of. The application version does not change and neither does the
changelog, so `docker compose pull` on a quiet week still picks up the patched
base.

Neither a release nor a rebuild tags an image before it has passed the
vulnerability scan, and a release publishes its tags only once all five images
are through, so `RR_VERSION=1` never resolves to a half-published release.

Renovate pins `postgres` and `valkey` to a digest and opens a pull request on
this repository when a new one appears. A PostgreSQL minor inside 18.x is safe to take; a major change
only ever arrives in a major release of RemnaRay, with instructions.

## Which versions are supported

The latest minor of the current major, plus security fixes for the previous
minor for thirty days and for the previous major for ninety. See
[`SECURITY.md`](../SECURITY.md).
