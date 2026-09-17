#!/usr/bin/env sh
# Fetch upstream mirrors and print current SHAs next to the pinned ones in
# docs/upstream.md. Absorbing a new SHA is a deliberate act: update the doc,
# re-vendor affected files, note the new SHA in their provenance headers.
set -eu
for r in qm buzz jcode-1jehuang tdam; do
  if [ -d ".upstream/$r" ]; then
    sha=$(git -C ".upstream/$r" rev-parse HEAD)
    date=$(git -C ".upstream/$r" log -1 --format=%ci)
    echo "$r $sha $date"
  else
    echo "$r MISSING (.upstream/$r not cloned)" >&2
  fi
done
echo '--- pinned (docs/upstream.md) ---'
grep -E '^\| (QM|Buzz|jcode|TDAM)' docs/upstream.md || true
