#!/usr/bin/env bash
set -euo pipefail

# Sync the OpenAgent app repository to a separate GitHub working tree and,
# optionally, commit/push from that working tree.
#
# Default source/target can be changed by passing --source/--target or setting
# OPENAGENT_SOURCE_DIR/OPENAGENT_GITHUB_DIR.
# Docs mapping:
#   source GitLab repo:  github-docs/
#   target GitHub repo: docs/
# Source docs/ is internal and is not published. Target github-docs/ should not exist.

DEFAULT_SOURCE="/Users/guolimin/Desktop/project-git/gitlab/openagent"
DEFAULT_TARGET="/Users/guolimin/Desktop/project-git/github/OpenAgent"
SOURCE_DIR="${OPENAGENT_SOURCE_DIR:-}"
TARGET_DIR="${OPENAGENT_GITHUB_DIR:-$DEFAULT_TARGET}"
COMMIT_MESSAGE="chore: sync OpenAgent public repo"
RUN_TYPECHECK=1
# This script is intended to be directly runnable during active development.
# The source GitLab repo often has uncommitted work, so sync the current working tree by default.
ALLOW_DIRTY=1
DRY_RUN=0
DO_COMMIT=0
DO_PUSH=0
# The target GitHub working tree is treated as a generated mirror by default,
# so rerunning this script can update a previously synced but uncommitted tree.
ALLOW_TARGET_DIRTY=1

usage() {
  cat <<USAGE
Usage: $0 [options]

Options:
  --source DIR       Optional source GitLab repo working tree override. Default: current repo,
                     or ${DEFAULT_SOURCE} when this script is run from the GitHub mirror.
  --target DIR       Optional GitHub repo working tree override. Default: ${DEFAULT_TARGET}
  --message MSG      Commit message used with --commit. Default: ${COMMIT_MESSAGE}
  --skip-typecheck   Do not run pnpm typecheck before syncing.
  --no-allow-dirty   Refuse to sync when the source GitLab working tree has uncommitted changes.
  --no-target-dirty  Refuse to sync when the target GitHub working tree has uncommitted changes.
  --dry-run          Show what would be synced without writing to the target directory.
  --commit           Create a commit in the target repo after syncing.
  --push             Push the current branch in the target repo after syncing. Implies --commit.
  -h, --help         Show this help.

Examples:
  $0
  $0 --commit
  $0 --message "chore: sync public release" --commit --push
  $0 --source /path/to/gitlab/openagent --target /path/to/github/OpenAgent --dry-run
  $0 --target /path/to/OpenAgent --dry-run
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --source)
      SOURCE_DIR="${2:?Missing value for --source}"
      shift 2
      ;;
    --target)
      TARGET_DIR="${2:?Missing value for --target}"
      shift 2
      ;;
    --message)
      COMMIT_MESSAGE="${2:?Missing value for --message}"
      shift 2
      ;;
    --skip-typecheck)
      RUN_TYPECHECK=0
      shift
      ;;
    --allow-dirty)
      ALLOW_DIRTY=1
      shift
      ;;
    --no-allow-dirty)
      ALLOW_DIRTY=0
      shift
      ;;
    --no-target-dirty)
      ALLOW_TARGET_DIRTY=0
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --commit)
      DO_COMMIT=1
      shift
      ;;
    --push)
      DO_COMMIT=1
      DO_PUSH=1
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

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

if [[ -z "${SOURCE_DIR}" ]]; then
  SOURCE_DIR="${SCRIPT_REPO_DIR}"
  # The script itself is copied into the public GitHub mirror. If it is invoked
  # from there, use the private GitLab working tree as the default source
  # instead of trying to mirror the target repo onto itself.
  if [[ -d "${DEFAULT_SOURCE}/.git" && -d "${TARGET_DIR}" ]]; then
    SCRIPT_REPO_REAL="$(cd "${SCRIPT_REPO_DIR}" && pwd)"
    TARGET_REAL="$(cd "${TARGET_DIR}" && pwd)"
    if [[ "${SCRIPT_REPO_REAL}" == "${TARGET_REAL}" ]]; then
      SOURCE_DIR="${DEFAULT_SOURCE}"
    fi
  fi
fi

SOURCE_DIR="$(cd "${SOURCE_DIR}" && pwd)"

cd "${SOURCE_DIR}"

if [[ ! -f "package.json" || ! -d "src" ]]; then
  echo "Source directory does not look like the OpenAgent app repo: ${SOURCE_DIR}" >&2
  exit 1
fi

if [[ ! -d "github-docs" ]]; then
  echo "Source repo is missing github-docs/: ${SOURCE_DIR}" >&2
  echo "The public GitHub repo should contain docs/, but the private source repo must contain github-docs/." >&2
  echo "Run this script from the GitLab source repo, or pass --source /path/to/gitlab/openagent." >&2
  exit 1
fi

if [[ "${RUN_TYPECHECK}" -eq 1 ]]; then
  echo "==> Running pnpm typecheck in source repo"
  pnpm typecheck
fi

if grep -Eq '^export[[:space:]]+(HTTP_PROXY|HTTPS_PROXY|ALL_PROXY)=.*127[.]0[.]0[.]1' "scripts/package-windows-installer.sh"; then
  echo "Refusing to publish: scripts/package-windows-installer.sh contains a forced local proxy export." >&2
  echo "Use an opt-in local proxy env var instead, so GitHub Actions can package Windows artifacts without 127.0.0.1 proxy settings." >&2
  exit 1
fi

SOURCE_STATUS="$(git status --short)"
if [[ -n "${SOURCE_STATUS}" && "${ALLOW_DIRTY}" -ne 1 ]]; then
  echo "Source repo has uncommitted changes. Review them first or pass --allow-dirty to sync the working tree:" >&2
  echo "${SOURCE_STATUS}" >&2
  exit 1
fi

if [[ ! -d "${TARGET_DIR}" ]]; then
  echo "Target directory does not exist: ${TARGET_DIR}" >&2
  echo "Create/clone the GitHub repo there first, then rerun this script." >&2
  exit 1
fi

if [[ ! -d "${TARGET_DIR}/.git" ]]; then
  echo "Target directory is not a Git working tree: ${TARGET_DIR}" >&2
  echo "Clone the GitHub OpenAgent repo there first." >&2
  exit 1
fi

TARGET_DIR="$(cd "${TARGET_DIR}" && pwd)"

if [[ "${SOURCE_DIR}" == "${TARGET_DIR}" ]]; then
  echo "Source and target point to the same working tree; refusing to publish in-place:" >&2
  echo "  source: ${SOURCE_DIR}" >&2
  echo "  target: ${TARGET_DIR}" >&2
  echo "Pass --source /path/to/gitlab/openagent and --target /path/to/github/OpenAgent." >&2
  exit 1
fi

TARGET_BRANCH="$(git -C "${TARGET_DIR}" branch --show-current)"
if [[ -z "${TARGET_BRANCH}" ]]; then
  echo "Target repo is in detached HEAD state; refusing to publish." >&2
  exit 1
fi

TARGET_STATUS="$(git -C "${TARGET_DIR}" status --short)"
if [[ -n "${TARGET_STATUS}" && "${ALLOW_TARGET_DIRTY}" -ne 1 ]]; then
  echo "Target repo has uncommitted changes. Commit/stash them first, or omit --no-target-dirty to overwrite the generated mirror:" >&2
  echo "${TARGET_STATUS}" >&2
  exit 1
fi

RSYNC_ARGS=(
  -a
  --delete
  --exclude '.git/'
  # GitHub-only repo metadata must be preserved in the public mirror.
  --exclude '.github/'
  --exclude 'LICENSE'
  --exclude '.DS_Store'
  --exclude 'node_modules/'
  --exclude 'dist/'
  --exclude 'release/'
  --exclude '.env'
  --exclude '.env.*'
  --exclude '*.log'
  --exclude 'logs/'
  --exclude 'docs/'
  --exclude 'github-docs/'
  --exclude '.openagent/'
  --exclude 'openagent-plugins/'
  --exclude 'openagent-skills/'
)

if [[ "${DRY_RUN}" -eq 1 ]]; then
  RSYNC_ARGS+=(--dry-run --itemize-changes)
fi

echo "==> Syncing OpenAgent app repo"
echo "    source: ${SOURCE_DIR}/"
echo "    target: ${TARGET_DIR}/"
echo "    public docs: ${SOURCE_DIR}/github-docs/ -> ${TARGET_DIR}/docs/"
echo "    preserving target-only: .github/, LICENSE"
rsync "${RSYNC_ARGS[@]}" "${SOURCE_DIR}/" "${TARGET_DIR}/"

DOCS_RSYNC_ARGS=(-a --delete --exclude '.DS_Store')
if [[ "${DRY_RUN}" -eq 1 ]]; then
  DOCS_RSYNC_ARGS+=(--dry-run --itemize-changes)
fi

if [[ "${DRY_RUN}" -ne 1 ]]; then
  mkdir -p "${TARGET_DIR}/docs"
fi
rsync "${DOCS_RSYNC_ARGS[@]}" "${SOURCE_DIR}/github-docs/" "${TARGET_DIR}/docs/"

if [[ "${DRY_RUN}" -eq 1 ]]; then
  echo "==> Dry run complete; no files were changed."
  exit 0
fi

cd "${TARGET_DIR}"

if [[ ! -f ".github/workflows/release.yml" ]]; then
  echo "Refusing to continue: target .github/workflows/release.yml is missing after sync." >&2
  echo "Restore the GitHub release workflow in ${TARGET_DIR} before committing/pushing." >&2
  exit 1
fi

echo "==> Target repo status"
git status --short

if [[ "${DO_COMMIT}" -eq 1 ]]; then
  if [[ -z "$(git status --short)" ]]; then
    echo "==> No changes to commit in target repo."
  else
    echo "==> Committing changes on target branch: ${TARGET_BRANCH}"
    git add -A
    git commit -m "${COMMIT_MESSAGE}"
  fi
fi

if [[ "${DO_PUSH}" -eq 1 ]]; then
  echo "==> Pushing target branch: ${TARGET_BRANCH}"
  git push origin "${TARGET_BRANCH}"
fi

echo "==> Done."
