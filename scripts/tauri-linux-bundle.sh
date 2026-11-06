#!/usr/bin/env bash
# 无 root 打 Linux AppImage：GTK/WebKit 来自 ~/gtk-sysroot。
set -uo pipefail
export PATH="$HOME/.cargo/bin:$PATH"
SYS="$HOME/gtk-sysroot"
export PKG_CONFIG_PATH="$SYS/usr/lib/pkgconfig:$SYS/usr/share/pkgconfig"
export PKG_CONFIG_SYSROOT_DIR="$SYS"
export LIBRARY_PATH="$SYS/usr/lib"
export PATH="$SYS/usr/bin:$PATH"
export RUSTFLAGS="-L $SYS/usr/lib -C link-arg=-Wl,-rpath-link,$SYS/usr/lib"
export APPIMAGE_EXTRACT_AND_RUN=1
cd "$(dirname "$0")/../packages/shell/src-tauri"
BUNDLES=("$@")
if [ ${#BUNDLES[@]} -eq 0 ]; then
  BUNDLES=(--bundles appimage)
fi
cargo tauri build --target x86_64-unknown-linux-gnu "${BUNDLES[@]}"
