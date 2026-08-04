#!/usr/bin/env bash
# scripts/bump-version.sh — bump the ELO version and tag it.
#
# WHY THIS SCRIPT EXISTS
# ----------------------
# The version sat at `0.1.0` for 67 commits. Not by decision: the panel displayed
# "v0.1.0" while the gateway accumulated an SSRF guard, rate limiting, CSP, its own
# webhook key, structured logging and full group management. The number on screen said
# nothing about what was running — the only reliable signal was the short commit hash,
# which nobody remembers.
#
# A manual bump gets forgotten, so this makes it a one-liner.
#
# Semver below 1.0.0 (the API can still change):
#   patch — a fix with no contract change
#   minor — new capability, or a visible behaviour change
#   major — reserved for 1.0.0 (stable API)
#
# Usage:
#   ./scripts/bump-version.sh patch      # 0.6.0 -> 0.6.1
#   ./scripts/bump-version.sh minor      # 0.6.0 -> 0.7.0
#   ./scripts/bump-version.sh 1.0.0      # exact version
#   DRY_RUN=1 ./scripts/bump-version.sh patch

set -euo pipefail

cd "$(dirname "$0")/.."

ARG="${1:-patch}"
CURRENT=$(node -p "require('./package.json').version")

case "$ARG" in
  patch|minor|major)
    IFS='.' read -r MA MI PA <<< "$CURRENT"
    case "$ARG" in
      patch) PA=$((PA + 1)) ;;
      minor) MI=$((MI + 1)); PA=0 ;;
      major) MA=$((MA + 1)); MI=0; PA=0 ;;
    esac
    NEXT="${MA}.${MI}.${PA}"
    ;;
  [0-9]*.[0-9]*.[0-9]*)
    NEXT="$ARG"
    ;;
  *)
    echo "[error] invalid argument: '$ARG' (use patch|minor|major or X.Y.Z)" >&2
    exit 1
    ;;
esac

echo "version: $CURRENT -> $NEXT"

if [[ "${DRY_RUN:-}" == "1" ]]; then
  echo "[dry-run] nothing changed"
  exit 0
fi

# `npm version` rather than `sed`: it updates package.json AND package-lock.json
# consistently. Editing only package.json leaves the lock out of sync, and `npm ci`
# then FAILS with "lock file does not satisfy" — a build break, which surfaces late.
#
# `--no-git-tag-version` because the tag is created below together with the commit;
# npm would tag without an associated commit if the tree were dirty.
npm version "$NEXT" --no-git-tag-version >/dev/null
echo "package.json + package-lock.json updated"

cat <<EOF

Next steps (this script does NOT commit or push — no automatic publishing):

  git add package.json package-lock.json
  git commit -m "chore: version $NEXT"
  git tag v$NEXT
  git push && git push --tags
EOF
