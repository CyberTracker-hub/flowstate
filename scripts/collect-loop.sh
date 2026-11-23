#!/usr/bin/env bash
# Collect on a fixed rhythm for a bounded time.
#
#   scripts/collect-loop.sh <run-seconds> [data-dir] [branch] [remote]
#
# GitHub starts scheduled workflows far less often than asked (observed: about
# once an hour for a five-minute schedule). So instead of one reading per
# workflow run, one run stays alive and takes a reading every INTERVAL
# seconds, publishing after each. The workflow starts the next run when this
# one ends.
#
# Every round restores the state from the data branch first, so a second loop
# that was started by mistake converges on the same state instead of
# overwriting it (a reading for an already processed interval is a no-op).
#
# A failed round is logged and the loop carries on: one bad reading must not
# stop the next sixty.
set -uo pipefail

run_seconds="${1:?usage: collect-loop.sh <run-seconds> [data-dir] [branch] [remote]}"
dir="${2:-.data}"
branch="${3:-data}"
remote="${4:-origin}"
interval="${INTERVAL:-300}"
# Seconds past each interval boundary at which a reading is taken.
offset="${OFFSET:-30}"
collect_cmd="${COLLECT_CMD:-pnpm -s collect}"
here="$(cd "$(dirname "$0")" && pwd)"

started="$(date +%s)"
deadline=$(( started + run_seconds ))
rounds=0
failures=0

restore() {
  rm -rf "$dir"
  mkdir -p "$dir"
  if git ls-remote --exit-code --heads "$remote" "$branch" >/dev/null 2>&1; then
    git fetch --quiet --depth=1 "$remote" "$branch" && git archive FETCH_HEAD | tar -x -C "$dir"
  else
    echo "collect-loop: no $branch branch yet; starting from empty"
  fi
}

while :; do
  rounds=$(( rounds + 1 ))
  if restore && FLOWSTATE_DATA_DIR="$dir" $collect_cmd && "$here/publish-data.sh" "$dir" "$branch" "$remote"; then
    :
  else
    failures=$(( failures + 1 ))
    echo "collect-loop: round $rounds failed (total failures: $failures)" >&2
  fi

  now="$(date +%s)"
  # Next moment that is `offset` seconds past an interval boundary.
  wait=$(( interval - ( (now - offset) % interval ) ))
  if [ $(( now + wait )) -ge "$deadline" ]; then
    break
  fi
  sleep "$wait"
done

echo "collect-loop: finished $rounds rounds in $(( $(date +%s) - started )) s, $failures failed"
# Only a loop in which nothing ever worked is reported as a failed job.
[ "$failures" -lt "$rounds" ]
