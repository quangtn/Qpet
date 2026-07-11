#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: npm run install:mac -- [--app-dir DIRECTORY] [--no-launch]

Build and install the Apple Silicon QPet app from this source checkout.
The default destination is ~/Applications. This script never changes Codex or
Claude configuration; install integrations from QPet Settings after launch.
EOF
}

app_dir="$HOME/Applications"
launch_app=1

while (($#)); do
  case "$1" in
    --app-dir)
      (($# >= 2)) || { echo "--app-dir requires a directory." >&2; exit 2; }
      app_dir="$2"
      shift 2
      ;;
    --no-launch)
      launch_app=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "QPet's source installer currently supports macOS only." >&2
  exit 1
fi

if [[ "$(uname -m)" != "arm64" ]]; then
  echo "QPet currently ships an Apple Silicon build; this Mac is $(uname -m)." >&2
  exit 1
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source_app="$repo_root/release/mac-arm64/QPet.app"
destination="$app_dir/QPet.app"

cd "$repo_root"
npm run package:mac

[[ -d "$source_app" ]] || { echo "Packaged app was not found: $source_app" >&2; exit 1; }
mkdir -p "$app_dir"

if [[ -d "$destination" ]]; then
  osascript -e 'tell application "QPet" to quit' >/dev/null 2>&1 || true
  rm -rf "$destination"
fi

ditto "$source_app" "$destination"
echo "Installed QPet to $destination"

if ((launch_app)); then
  open "$destination"
fi
