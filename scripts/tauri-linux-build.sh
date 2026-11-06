#!/usr/bin/env bash
# 无 root 的 Tauri 壳构建：使用 ~/gtk-sysroot 里的 GTK/WebKit 开发文件。
set -uo pipefail
export PATH="$HOME/.cargo/bin:$PATH"
SYS="$HOME/gtk-sysroot"
export PKG_CONFIG_PATH="$SYS/usr/lib/pkgconfig:$SYS/usr/share/pkgconfig"
export PKG_CONFIG_SYSROOT_DIR="$SYS"
export LIBRARY_PATH="$SYS/usr/lib"
export PATH="$SYS/usr/bin:$PATH"
export RUSTFLAGS="-L $SYS/usr/lib -C link-arg=-Wl,-rpath-link,$SYS/usr/lib"
cd "$(dirname "$0")/../packages/shell/src-tauri"
echo "pkg-config gtk3: $(pkg-config --modversion gtk+-3.0 2>&1)"
echo "pkg-config webkit: $(pkg-config --modversion webkit2gtk-4.1 2>&1)"
cargo check "$@"
