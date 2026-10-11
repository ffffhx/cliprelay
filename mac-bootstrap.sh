#!/bin/bash
# Build and install the Electron Mac app from a checkout or a built .app / ZIP.
set -euo pipefail
if [[ "$(uname -s)" != Darwin ]]; then
  echo 'Run this installer on macOS.' >&2
  exit 1
fi
source_path="${1:-}"
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -z "$source_path" ]]; then
  command -v node >/dev/null || { echo 'Install Node.js 22.12 or newer first.' >&2; exit 1; }
  command -v npm >/dev/null || { echo 'Install npm first.' >&2; exit 1; }
  xcode-select -p >/dev/null || { echo 'Run xcode-select --install first.' >&2; exit 1; }
  npm --prefix "$repo/windows/electron" ci --ignore-scripts
  node "$repo/windows/electron/build-macos.cjs"
  architecture="$(node -p process.arch)"
  source_path="$repo/.tools/mac-electron/ClipRelay-darwin-$architecture/ClipRelay.app"
fi
staging="$(mktemp -d "${TMPDIR:-/tmp}/cliprelay-install.XXXXXX")"
cleanup() {
  case "$staging" in "${TMPDIR:-/tmp}"/cliprelay-install.*) rm -rf -- "$staging" ;; esac
}
trap cleanup EXIT
if [[ "$source_path" == *.zip ]]; then
  /usr/bin/ditto -x -k "$source_path" "$staging"
  source_path="$staging/ClipRelay.app"
fi
if [[ ! -x "$source_path/Contents/MacOS/ClipRelay" ]]; then
  echo 'Provide the built ClipRelay.app or its ZIP archive.' >&2
  exit 1
fi
destination="$HOME/Applications/ClipRelay.app"
mkdir -p "$HOME/Applications"
if [[ -d "$destination" ]]; then
  /usr/bin/osascript -e 'tell application id "com.cliprelay.desktop" to quit' >/dev/null 2>&1 || true
  backup="$HOME/Applications/ClipRelay.previous.$(date +%Y%m%d%H%M%S).app"
  mv -- "$destination" "$backup"
  echo "Previous application kept at $backup"
fi
/usr/bin/ditto "$source_path" "$destination"
echo 'Installed ClipRelay. Before first launch, disable the old ClipRelay in Hammerspoon and Reload.'
echo 'Keep the old init.lua file so its settings can be imported. Grant ClipRelay Accessibility access when prompted.'
/usr/bin/open "$destination"
