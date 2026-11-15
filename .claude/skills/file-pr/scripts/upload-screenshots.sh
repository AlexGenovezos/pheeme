#!/usr/bin/env bash
# Upload PR screenshots to the repo's `pr-screenshots` branch and print Markdown to paste into
# the PR body. Usage: upload-screenshots.sh <pr-number> <file.png>...
# The branch holds only images (no workflow runs on it). Links pin the commit, so they never change.
set -euo pipefail
[ $# -ge 2 ] || { echo "usage: $0 <pr-number> <file.png>..." >&2; exit 2; }
pr=$1; shift
for f in "$@"; do
  [ -f "$f" ] || { echo "no such file: $f" >&2; exit 2; }
  # The name goes into a URL and Markdown unescaped.
  [[ $(basename "$f") =~ ^[A-Za-z0-9._-]+$ ]] || { echo "rename to letters, digits, . _ -: $f" >&2; exit 2; }
done
branch=pr-screenshots
repo=$(gh repo view --json nameWithOwner --jq .nameWithOwner)
index=$(mktemp); trap 'rm -f "$index"' EXIT

for attempt in 1 2 3; do
  parent=""
  if git fetch -q origin "refs/heads/$branch" 2>/dev/null; then parent=$(git rev-parse FETCH_HEAD); fi
  rm -f "$index"
  if [ -n "$parent" ]; then GIT_INDEX_FILE=$index git read-tree "$parent"; else GIT_INDEX_FILE=$index git read-tree --empty; fi
  for f in "$@"; do
    blob=$(git hash-object -w "$f")
    GIT_INDEX_FILE=$index git update-index --add --cacheinfo "100644,$blob,pr-$pr/$(basename "$f")"
  done
  tree=$(GIT_INDEX_FILE=$index git write-tree)
  commit=$(git commit-tree "$tree" ${parent:+-p "$parent"} -m "Screenshots for #$pr")
  # A plain push: someone else's upload in between makes it fail, and the loop rebuilds on theirs.
  if git push -q origin "$commit:refs/heads/$branch" 2>/dev/null; then
    for f in "$@"; do
      name=$(basename "$f")
      echo "![${name%.*}](https://raw.githubusercontent.com/$repo/$commit/pr-$pr/$name)"
    done
    exit 0
  fi
  echo "push raced another upload; retrying ($attempt)" >&2
done
echo "couldn't push to $branch" >&2
exit 1
