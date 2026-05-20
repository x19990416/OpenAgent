#!/usr/bin/env bash
set -euo pipefail

export HTTP_PROXY=http://127.0.0.1:7890
export HTTPS_PROXY=http://127.0.0.1:7890
export ALL_PROXY=socks5://127.0.0.1:7890

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

TARGET_ARCH="${OPENAGENT_WIN_ARCH:-x64}"
SKIP_BUILD=0
CLEAN=0

usage() {
  cat <<'EOF'
Usage: bash scripts/package-windows-installer.sh [--arch x64|arm64] [--skip-build] [--clean]

Build OpenAgent and package a Windows NSIS installer (.exe).

Options:
  --arch <arch>    Target CPU arch. Defaults to x64.
  --skip-build     Skip `pnpm build` and package the existing dist/.
  --clean          Remove release/ before packaging.

Environment:
  OPENAGENT_WIN_ARCH=x64|arm64  Default arch when --arch is not provided.

Output:
  release/*Setup*.exe

TODO(auto-update): keep this installer script as the stable baseline; add update feed
metadata and publish configuration in a later auto-update task.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --arch)
      TARGET_ARCH="${2:-}"
      shift 2
      ;;
    --skip-build)
      SKIP_BUILD=1
      shift
      ;;
    --clean)
      CLEAN=1
      shift
      ;;
    --)
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

case "$TARGET_ARCH" in
  x64|arm64) ;;
  *)
    echo "Unsupported Windows arch: $TARGET_ARCH. Use x64 or arm64." >&2
    exit 2
    ;;
esac

if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm is required but was not found in PATH." >&2
  exit 1
fi

if [[ ! -d node_modules ]]; then
  echo "node_modules not found; installing dependencies with pnpm install --frozen-lockfile..."
  pnpm install --frozen-lockfile
fi

if [[ "$CLEAN" == "1" ]]; then
  rm -rf release
fi

if [[ "$SKIP_BUILD" != "1" ]]; then
  pnpm build
fi

ARCH_FLAG="--${TARGET_ARCH}"

echo "Packaging Windows NSIS installer for ${TARGET_ARCH}..."
pnpm exec electron-builder \
  --config electron-builder.config.cjs \
  --win nsis \
  "$ARCH_FLAG" \
  --publish never

INSTALLERS=()
while IFS= read -r artifact; do
  INSTALLERS+=("$artifact")
done < <(find release -maxdepth 2 -type f -name '*Setup*.exe' | sort)

if [[ "${#INSTALLERS[@]}" -eq 0 ]]; then
  echo "Windows installer was not found under release/. Expected release/*Setup*.exe" >&2
  exit 1
fi

echo
echo "Windows installer artifact(s):"
for artifact in "${INSTALLERS[@]}"; do
  du -sh "$artifact"
done

UNPACKED=()
while IFS= read -r artifact; do
  UNPACKED+=("$artifact")
done < <(find release -maxdepth 2 -type d -name 'win*-unpacked' | sort)

if [[ "${#UNPACKED[@]}" -gt 0 ]]; then
  echo
  echo "Windows unpacked artifact(s):"
  for artifact in "${UNPACKED[@]}"; do
    du -sh "$artifact"
  done
fi
