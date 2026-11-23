#!/usr/bin/env bash
# Publish the contents of a data directory as the ONLY commit on a branch.
#
#   scripts/publish-data.sh <data-dir> [branch] [remote]
#
# The branch is replaced on every run (force-push of a parentless commit), so
# five-minute readings never pile up in the repository's history. Uses the
# surrounding repository's own credentials and never touches its working tree
# or index.
set -euo pipefail

dir="${1:?usage: publish-data.sh <data-dir> [branch] [remote]}"
branch="${2:-data}"
remote="${3:-origin}"

[ -f "$dir/state.json" ] || { echo "publish-data: $dir/state.json is missing; nothing to publish" >&2; exit 1; }
[ -f "$dir/public/overview.json" ] || { echo "publish-data: $dir/public/overview.json is missing" >&2; exit 1; }

cat > "$dir/README.md" <<'TXT'
# FLOWSTATE data branch

Written by the "Collect market data" workflow. Do not edit by hand: this
branch is replaced on every run.

- `public/` — JSON the website reads (`overview.json`, `tokens/<mint>.json`)
- `state.json` — the collector's working state, carried from run to run
TXT

index="$(mktemp -u)"
trap 'rm -f "$index"' EXIT
export GIT_INDEX_FILE="$index"
export GIT_AUTHOR_NAME="${GIT_AUTHOR_NAME:-flowstate-collector}"
export GIT_AUTHOR_EMAIL="${GIT_AUTHOR_EMAIL:-41898282+github-actions[bot]@users.noreply.github.com}"
export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME"
export GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"

git --work-tree="$dir" add -A -f .
tree="$(git write-tree)"
commit="$(git commit-tree "$tree" -m "Readings $(date -u +%Y-%m-%dT%H:%M:%SZ)")"
git push --force --quiet "$remote" "$commit:refs/heads/$branch"
echo "publish-data: pushed $(git ls-tree -r --name-only "$commit" | wc -l | tr -d ' ') files to $remote/$branch"
