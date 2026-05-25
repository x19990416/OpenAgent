#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

REMOTE="${OPENAGENT_GITHUB_REMOTE:-github}"
BRANCH="${OPENAGENT_GITHUB_BRANCH:-$(git branch --show-current)}"
FORCE_WITH_LEASE=0

usage() {
  cat <<'USAGE'
Usage: bash scripts/push-github.sh [--branch <branch>] [--remote <remote>] [--force-with-lease]

Push the selected branch to the GitHub remote. Defaults:
  remote: github
  branch: current branch

Environment:
  OPENAGENT_GITHUB_REMOTE  Override remote name. Defaults to github.
  OPENAGENT_GITHUB_BRANCH  Override branch name. Defaults to current branch.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --branch)
      BRANCH="${2:-}"
      shift 2
      ;;
    --remote)
      REMOTE="${2:-}"
      shift 2
      ;;
    --force-with-lease)
      FORCE_WITH_LEASE=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -z "$BRANCH" ]]; then
  echo "No branch selected. Use --branch <branch>." >&2
  exit 2
fi

if ! git remote get-url "$REMOTE" >/dev/null 2>&1; then
  echo "Missing GitHub remote '$REMOTE'. Add it with:" >&2
  echo "  git remote add $REMOTE https://github.com/x19990416/OpenAgent.git" >&2
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Working tree has uncommitted changes. Commit or stash before pushing." >&2
  git status --short >&2
  exit 1
fi

if [[ "$FORCE_WITH_LEASE" == "1" ]]; then
  git push "$REMOTE" "$BRANCH" --force-with-lease
else
  git push "$REMOTE" "$BRANCH"
fi
