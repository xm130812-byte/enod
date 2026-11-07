#!/usr/bin/env bash
# 冒烟：起 Rust 内核，打 health / stats / docs / search，再退出。
set -uo pipefail
export PATH="$HOME/.cargo/bin:$PATH"
cd "$(dirname "$0")"
ROOT=$(cd ../.. && pwd)
DATA=/tmp/mdreader-smoke
BIN="${READER_BIN:-${CARGO_TARGET_DIR:-$HOME/target}/debug/md-reader-core}"
rm -rf "$DATA"
mkdir -p "$DATA"
READER_ROOT="$ROOT/sample-library" \
READER_NO_OPEN=1 \
"$BIN" --data-dir "$DATA" --port 0 >/tmp/mdreader-smoke.log 2>&1 &
PID=$!
for _ in $(seq 1 60); do
  [ -f "$DATA/run.json" ] && break
  sleep 0.2
done
if [ ! -f "$DATA/run.json" ]; then
  echo "server did not start"; cat /tmp/mdreader-smoke.log; kill $PID 2>/dev/null; exit 1
fi
PORT=$(python3 -c "import json;print(json.load(open('$DATA/run.json'))['port'])")
echo "port=$PORT"
curl -s "http://127.0.0.1:$PORT/api/v1/health"; echo
sleep 3
curl -s "http://127.0.0.1:$PORT/api/v1/library/stats"; echo
curl -s "http://127.0.0.1:$PORT/api/v1/docs?limit=3&sort=title"; echo
curl -s "http://127.0.0.1:$PORT/api/v1/search?q=SQLite&limit=3"; echo
kill $PID 2>/dev/null
wait $PID 2>/dev/null
echo "--- log ---"
cat /tmp/mdreader-smoke.log
