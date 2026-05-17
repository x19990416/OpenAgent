#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

TARGET_ARCH="${OPENAGENT_MAC_ARCH:-}"
SKIP_BUILD=0
CLEAN=0
INCLUDE_ZIP=0

usage() {
  cat <<'USAGE'
Usage: bash scripts/package-macos-dmg.sh [--arch x64|arm64|universal] [--include-zip] [--skip-build] [--clean]

Build OpenAgent and package a macOS DMG installer.

Options:
  --arch <arch>    Target CPU arch. Defaults to the current machine arch.
  --include-zip    Also produce a zip artifact next to the dmg.
  --skip-build     Skip `pnpm build` and package the existing dist/.
  --clean          Remove release/ before packaging.

Environment:
  OPENAGENT_MAC_ARCH=x64|arm64|universal  Default arch when --arch is not provided.

Output:
  release/*.dmg
  release/*.zip when --include-zip is passed

TODO(auto-update): use the zip artifact as the basis for a future electron-updater feed.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --arch)
      TARGET_ARCH="${2:-}"
      shift 2
      ;;
    --include-zip)
      INCLUDE_ZIP=1
      shift
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

if [[ -z "$TARGET_ARCH" ]]; then
  case "$(uname -m)" in
    arm64|aarch64) TARGET_ARCH="arm64" ;;
    x86_64|amd64) TARGET_ARCH="x64" ;;
    *)
      echo "Unable to infer macOS arch from uname -m; pass --arch x64|arm64|universal." >&2
      exit 2
      ;;
  esac
fi

case "$TARGET_ARCH" in
  x64|arm64|universal) ;;
  *)
    echo "Unsupported macOS arch: $TARGET_ARCH. Use x64, arm64, or universal." >&2
    exit 2
    ;;
esac

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "macOS DMG packaging must run on macOS." >&2
  exit 1
fi

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
TARGETS=(dmg)
if [[ "$INCLUDE_ZIP" == "1" ]]; then
  TARGETS+=(zip)
fi

# Keep local/dev packaging unsigned unless the caller provides an explicit signing setup.
export CSC_IDENTITY_AUTO_DISCOVERY="${CSC_IDENTITY_AUTO_DISCOVERY:-false}"

echo "Packaging macOS artifact(s) for ${TARGET_ARCH}: ${TARGETS[*]}..."
pnpm exec electron-builder \
  --config electron-builder.config.cjs \
  --mac "${TARGETS[@]}" \
  "$ARCH_FLAG" \
  --publish never

DMGS=()
while IFS= read -r artifact; do
  DMGS+=("$artifact")
done < <(find release -maxdepth 2 -type f -name '*.dmg' | sort)

if [[ "${#DMGS[@]}" -eq 0 ]]; then
  echo "macOS DMG artifact was not found under release/. Expected release/*.dmg" >&2
  exit 1
fi

ZIPS=()
while IFS= read -r artifact; do
  ZIPS+=("$artifact")
done < <(find release -maxdepth 2 -type f -name '*.zip' | sort)

APPS=()
while IFS= read -r artifact; do
  APPS+=("$artifact")
done < <(find release -maxdepth 3 -type d -name 'OpenAgent.app' | sort)

echo
echo "macOS artifact(s):"
for artifact in "${DMGS[@]}"; do
  du -sh "$artifact"
done
if [[ "${#ZIPS[@]}" -gt 0 ]]; then
  for artifact in "${ZIPS[@]}"; do
    du -sh "$artifact"
  done
fi
if [[ "${#APPS[@]}" -gt 0 ]]; then
  for artifact in "${APPS[@]}"; do
    du -sh "$artifact"
  done
fi
