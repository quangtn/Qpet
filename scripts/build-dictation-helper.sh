#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
output_dir="$repo_root/.build"
mkdir -p "$output_dir"

if ! /usr/bin/xcrun --find swiftc >/dev/null 2>&1; then
  echo "QPet requires Xcode Command Line Tools to build Dictation Beta." >&2
  echo "Install them with: xcode-select --install" >&2
  exit 1
fi

/usr/bin/xcrun swiftc \
  -O \
  -framework AVFoundation \
  -framework Speech \
  "$repo_root/resources/dictation-helper.swift" \
  -o "$output_dir/qpet-dictation-helper"

chmod 755 "$output_dir/qpet-dictation-helper"
