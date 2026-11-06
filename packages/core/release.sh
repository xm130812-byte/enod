#!/usr/bin/env bash
# M10 体积核对：release 构建 + 去 eh_frame + 报告二进制 / web / 压缩后体积。
set -uo pipefail
export PATH="$HOME/.cargo/bin:$PATH"
cd "$(dirname "$0")"
cargo build --release -p reader-cli || exit 1
BIN="$HOME/target/release/md-reader-core"
ROOT=$(cd ../.. && pwd)
OUT="$ROOT/release"
mkdir -p "$OUT"
cp "$BIN" "$OUT/md-reader-core-linux-x64"
if command -v objcopy >/dev/null 2>&1; then
  objcopy --remove-section=.eh_frame --remove-section=.eh_frame_hdr "$OUT/md-reader-core-linux-x64" 2>/dev/null || true
fi
if command -v strip >/dev/null 2>&1; then strip "$OUT/md-reader-core-linux-x64" 2>/dev/null || true; fi
echo "--- binary ---"
ls -l "$OUT/md-reader-core-linux-x64"
echo "bytes: $(stat -c %s "$OUT/md-reader-core-linux-x64")"
echo "--- web ---"
du -sb "$ROOT/packages/web/dist"
echo "--- compressed (xz -9, installer 近似) ---"
xz -9 -k -f -c "$OUT/md-reader-core-linux-x64" | wc -c
