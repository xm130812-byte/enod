#!/usr/bin/env bash
# 剪藏冒烟：真实网络页面 → job 轮询 → 结果落盘。
set -uo pipefail
export PATH="$HOME/.cargo/bin:$PATH"
cd "$(dirname "$0")"
DATA=/tmp/mdreader-clip-data
LIB=/tmp/mdreader-clip-lib
BIN="${CARGO_TARGET_DIR:-$HOME/target}/debug/md-reader-core"
rm -rf "$DATA" "$LIB"; mkdir -p "$DATA" "$LIB"
READER_ROOT="$LIB" READER_NO_OPEN=1 "$BIN" --data-dir "$DATA" --port 0 >/tmp/mdreader-clip.log 2>&1 &
PID=$!
for _ in $(seq 1 60); do [ -f "$DATA/run.json" ] && break; sleep 0.2; done
PORT=$(python3 -c "import json;print(json.load(open('$DATA/run.json'))['port'])")
BASE="http://127.0.0.1:$PORT"
URL="${1:-https://en.wikipedia.org/wiki/Readability}"
RESP=$(curl -s -X POST "$BASE/api/v1/clip" -H 'Content-Type: application/json' -H 'X-Reader-Client: 1' -d "{\"url\":\"$URL\"}")
echo "start: $RESP"
JOB=$(python3 -c "import json,sys;print(json.loads(sys.argv[1])['jobId'])" "$RESP")
for _ in $(seq 1 120); do
  J=$(curl -s "$BASE/api/v1/clip/$JOB")
  ST=$(python3 -c "import json,sys;d=json.loads(sys.argv[1]);print(d.get('status'))" "$J")
  case "$ST" in
    done|error|duplicate) echo "final: $J"; break;;
  esac
  sleep 0.5
done
echo "--- library ---"
curl -s "$BASE/api/v1/docs?status=all&limit=5"; echo
kill $PID 2>/dev/null; wait $PID 2>/dev/null
echo "--- log ---"; tail -5 /tmp/mdreader-clip.log
