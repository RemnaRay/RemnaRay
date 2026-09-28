#!/usr/bin/env sh
# Section 24.4: `X.Y` and `X` follow the newest final release of their line,
# which `RR_VERSION=1` or `1.2` resolves to. A release or rebuild of an older
# version — a security patch for the previous minor (24.5), a manual rebuild —
# publishes `X.Y.Z` but must not move them backwards; a pre-release moves
# neither. `latest` says whether the version is the newest final release of
# all, which only that one GitHub Release may claim (R114). Prints `minor=`,
# `major=` and `latest=` true or false for `$GITHUB_OUTPUT`.
#
#   scripts/floating-tags.sh 1.2.3
#
# Reads the release tags `vX.Y.Z` of the repository it runs in, so the
# checkout needs them (`fetch-depth: 0`).
set -eu

version=${1:?usage: floating-tags.sh X.Y.Z}

final=$(printf '%s\n' "$version" | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' || true)
if [ -z "$final" ]; then
  printf 'minor=false\nmajor=false\nlatest=false\n'
  exit 0
fi

releases=$(git tag --list 'v[0-9]*' | sed 's/^v//' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' || true)

# The newest final release whose version starts with `$1`, this one included.
newest() {
  prefix=$(printf '%s' "$1" | sed 's/\./\\./g')
  printf '%s\n%s\n' "$releases" "$version" | grep -E "^${prefix}" | sort -V | tail -n 1
}

owns() {
  if [ "$(newest "$1")" = "$version" ]; then echo true; else echo false; fi
}

printf 'minor=%s\nmajor=%s\nlatest=%s\n' \
  "$(owns "${version%.*}.")" "$(owns "${version%%.*}.")" "$(owns '')"
