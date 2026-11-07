#!/usr/bin/env bash
set -euo pipefail
export PATH="$HOME/.cargo/bin:$PATH"
S=/mnt/d/something/md-reader
D=/home/xm130812/md-reader
cp "$S/packages/shell/src-tauri/src/main.rs" "$D/packages/shell/src-tauri/src/main.rs"
cp "$S/packages/core/crates/reader-core/src/http/routes.rs" "$D/packages/core/crates/reader-core/src/http/routes.rs"
cp "$S/packages/web/public/tray.html" "$D/packages/web/public/tray.html"
cp "$S/scripts/local-build.ps1" "$D/scripts/local-build.ps1"
cp "$S/docs/PLAN-v4-remaining.md" "$D/docs/PLAN-v4-remaining.md"
cp "$S/scripts/overview-"*.cjs "$D/scripts/" 2>/dev/null || true
cd "$D"
pnpm build >/tmp/webbuild.log 2>&1
tail -1 /tmp/webbuild.log
cd packages/core
cargo test -p reader-core
cd ../../scripts
bash tauri-linux-build.sh
