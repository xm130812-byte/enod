#!/usr/bin/env bash
# 便携包（Linux x64）：内核 + web + 启动脚本。Tauri 安装包见 packages/shell。
set -euo pipefail
cd "$(dirname "$0")"
ROOT=$(cd ../.. && pwd)
OUT="$ROOT/release/md-reader-linux-x64"
BIN="$ROOT/release/md-reader-core-linux-x64"

if [ ! -x "$BIN" ]; then
  echo "先跑 packages/core/release.sh 生成 $BIN" >&2
  exit 1
fi
rm -rf "$OUT"
mkdir -p "$OUT/web"
cp "$BIN" "$OUT/md-reader-core"
chmod +x "$OUT/md-reader-core"
cp -r "$ROOT/packages/web/dist/." "$OUT/web/"
cat > "$OUT/md-reader" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
export READER_WEB_DIST="$DIR/web"
exec "$DIR/md-reader-core" "$@"
SH
chmod +x "$OUT/md-reader"
cat > "$OUT/README.txt" <<'TXT'
md-reader v4 portable (Linux x64)

运行： ./md-reader
数据目录：$XDG_DATA_HOME/md-reader（或 ~/.config/md-reader，若已存在）
界面依赖：Chrome / Chromium（没有时退回默认浏览器）
TXT

cd "$ROOT/release"
tar -czf md-reader-linux-x64.tar.gz md-reader-linux-x64
echo "bundle: $OUT"
echo "tar.gz bytes: $(stat -c %s md-reader-linux-x64.tar.gz)"
