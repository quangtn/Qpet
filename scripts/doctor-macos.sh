#!/usr/bin/env bash
set -u -o pipefail

# Read-only preflight for source installs. It intentionally never starts QPet,
# changes hook configuration, or prints configuration contents.

print_result() {
  printf '%-22s %-8s %s\n' "$1" "$2" "$3"
}

overall=0
home_dir="${HOME:?HOME is required}"
app_path="$home_dir/Applications/QPet.app"
support_dir="$home_dir/Library/Application Support/QPet"
codex_hooks="$home_dir/.codex/hooks.json"
claude_settings="$home_dir/.claude/settings.json"
cursor_hooks="$home_dir/.cursor/hooks.json"

echo "QPet doctor (read-only)"
echo

if [[ "$(uname -s)" == "Darwin" ]]; then
  print_result "macOS" "OK" "$(sw_vers -productVersion 2>/dev/null || echo 'detected')"
else
  print_result "macOS" "ERROR" "QPet currently supports macOS only."
  overall=1
fi

if [[ "$(uname -m)" == "arm64" ]]; then
  print_result "Apple Silicon" "OK" "arm64"
else
  print_result "Apple Silicon" "ERROR" "This Mac is $(uname -m); QPet currently ships arm64 only."
  overall=1
fi

if command -v node >/dev/null 2>&1; then
  node_version="$(node --version)"
  node_major="${node_version#v}"
  node_major="${node_major%%.*}"
  if [[ "$node_major" =~ ^[0-9]+$ ]] && ((node_major >= 22)); then
    print_result "Node.js" "OK" "$node_version"
  else
    print_result "Node.js" "ERROR" "$node_version found; Node.js 22 or newer is required."
    overall=1
  fi
else
  print_result "Node.js" "ERROR" "Not found; install Node.js 22 or newer."
  overall=1
fi

if command -v npm >/dev/null 2>&1; then
  print_result "npm" "OK" "$(npm --version)"
else
  print_result "npm" "ERROR" "Not found; reinstall Node.js with npm."
  overall=1
fi

for provider in codex claude cursor; do
  if provider_path="$(command -v "$provider" 2>/dev/null)"; then
    print_result "$provider CLI" "FOUND" "$provider_path"
  else
    print_result "$provider CLI" "OPTIONAL" "Not found; QPet can still install without it."
  fi
done

if [[ -d "$app_path" ]]; then
  print_result "Installed app" "FOUND" "$app_path"
else
  print_result "Installed app" "MISSING" "Run npm run install:mac after this check."
fi

if [[ -f "$cursor_hooks" ]] && grep -Fq 'QPET_HOOK_TAG=qpet-v1' "$cursor_hooks"; then
  print_result "Cursor hooks" "FOUND" "QPet-owned handler detected."
else
  print_result "Cursor hooks" "NOT SET" "Use QPet Settings > Install integrations."
fi

if [[ -d "$support_dir" ]]; then
  print_result "QPet data" "FOUND" "$support_dir"
else
  print_result "QPet data" "MISSING" "Created on QPet's first launch."
fi

if [[ -f "$codex_hooks" ]] && grep -Fq 'QPET_HOOK_TAG=qpet-v1' "$codex_hooks"; then
  print_result "Codex hooks" "FOUND" "QPet-owned handler detected."
else
  print_result "Codex hooks" "NOT SET" "Use QPet Settings > Install integrations."
fi

if [[ -f "$claude_settings" ]] && grep -Fq 'QPET_HOOK_TAG=qpet-v1' "$claude_settings"; then
  print_result "Claude hooks" "FOUND" "QPet-owned handler detected."
else
  print_result "Claude hooks" "NOT SET" "Use QPet Settings > Install integrations."
fi

echo
if ((overall)); then
  echo "Next action: resolve each ERROR above, then run npm run doctor again."
else
  echo "Next action: run npm ci, then npm run install:mac."
  echo "After first launch, install integrations in QPet Settings and trust QPet with /hooks in a new Codex CLI session."
fi

exit "$overall"
