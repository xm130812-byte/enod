#!/usr/bin/env bash
set -euo pipefail
S=/home/xm130812/md-reader
D=/mnt/d/something/md-reader
cp "$S/packages/shell/src-tauri/src/main.rs" "$D/packages/shell/src-tauri/src/main.rs"
cp "$S/packages/shell/src-tauri/src/prefs.rs" "$D/packages/shell/src-tauri/src/prefs.rs"
cp "$S/packages/core/crates/reader-core/src/config.rs" "$D/packages/core/crates/reader-core/src/config.rs"
cp "$S/packages/core/crates/reader-core/src/http/routes.rs" "$D/packages/core/crates/reader-core/src/http/routes.rs"
cp "$S/packages/core/crates/reader-cli/src/main.rs" "$D/packages/core/crates/reader-cli/src/main.rs"
mkdir -p "$D/packages/web/public"
cp "$S/packages/web/public/tray.html" "$D/packages/web/public/tray.html"
rm -rf "$D/packages/web/dist"
cp -a "$S/packages/web/dist" "$D/packages/web/dist"
echo copied
ls "$D/packages/web/dist/tray.html"
