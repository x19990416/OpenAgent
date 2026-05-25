#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

TARGET_ARCH="${OPENAGENT_MAC_ARCH:-}"
SKIP_BUILD=0
CLEAN=0

usage() {
  cat <<'EOF'
Usage: bash scripts/package-macos-app.sh [--arch x64|arm64|universal] [--skip-build] [--clean]

Build OpenAgent and package a macOS .app application bundle.

Options:
  --arch <arch>    Target CPU arch. Defaults to the current machine arch.
  --skip-build     Skip `pnpm build` and package the existing dist/.
  --clean          Remove release/ before packaging.

Environment:
  OPENAGENT_MAC_ARCH=x64|arm64|universal  Default arch when --arch is not provided.

Output:
  release/**/OpenAgent.app
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
  echo "macOS .app packaging must run on macOS." >&2
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

if [[ ! -x node_modules/electron/dist/Electron.app/Contents/MacOS/Electron ]]; then
  echo "Electron runtime dist not found; installing Electron runtime..."
  node node_modules/electron/install.js
fi

if [[ "$CLEAN" == "1" ]]; then
  rm -rf release
fi

if [[ "$SKIP_BUILD" != "1" ]]; then
  pnpm build
fi

ARCH_FLAG="--${TARGET_ARCH}"

# Keep local/dev packaging unsigned unless the caller provides an explicit signing setup.
export CSC_IDENTITY_AUTO_DISCOVERY="${CSC_IDENTITY_AUTO_DISCOVERY:-false}"

echo "Packaging macOS .app bundle for ${TARGET_ARCH}..."
pnpm exec electron-builder \
  --config electron-builder.config.cjs \
  --mac dir \
  "$ARCH_FLAG" \
  --publish never

APPS=()
while IFS= read -r artifact; do
  APPS+=("$artifact")
done < <(find release -maxdepth 3 -type d -name 'OpenAgent.app' | sort)

if [[ "${#APPS[@]}" -eq 0 ]]; then
  echo "macOS application bundle was not found under release/. Expected release/**/OpenAgent.app" >&2
  exit 1
fi

echo
echo "macOS application bundle artifact(s):"
printf '  %s\n' "${APPS[@]}"
