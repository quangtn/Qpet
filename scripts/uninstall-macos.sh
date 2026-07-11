#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: npm run uninstall:mac -- [--app-dir DIRECTORY] [--purge-data]

Remove the installed QPet app. The default location is ~/Applications/QPet.app.
This script never changes ~/.codex, ~/.claude, or ~/.cursor. Remove integrations first from
QPet Settings. --purge-data also removes QPet's local activity metadata.
EOF
}

app_dir="$HOME/Applications"
purge_data=0

while (($#)); do
  case "$1" in
    --app-dir)
      (($# >= 2)) || { echo "--app-dir requires a directory." >&2; exit 2; }
      app_dir="$2"
      shift 2
      ;;
    --purge-data)
      purge_data=1
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
  echo "QPet's uninstall script currently supports macOS only." >&2
  exit 1
fi

destination="$app_dir/QPet.app"
osascript -e 'tell application "QPet" to quit' >/dev/null 2>&1 || true

if [[ -d "$destination" ]]; then
  rm -rf "$destination"
  echo "Removed $destination"
else
  echo "No QPet app found at $destination"
fi

if ((purge_data)); then
  data_dir="$HOME/Library/Application Support/QPet"
  rm -rf "$data_dir"
  echo "Removed $data_dir"
fi

echo "Codex and Claude settings were not changed. If QPet integrations remain, remove them from QPet Settings before deleting its data."
