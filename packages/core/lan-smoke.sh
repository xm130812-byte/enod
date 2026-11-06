#!/usr/bin/env bash
# M11 token 冒烟：0.0.0.0 绑定必须带 token；?t= 首次访问种 Cookie。
set -uo pipefail
cd "$(dirname "$0")"
BIN="${CARGO_TARGET_DIR:-$HOME/target}/debug/md-reader-core"
DATA=/tmp/mdreader-lan-data
LIB=/tmp/mdreader-lan-lib
rm -rf "$DATA" "$LIB"; mkdir -p "$DATA" "$LIB"
READER_ROOT="$LIB" READER_NO_OPEN=1 "$BIN" --data-dir "$DATA" --port 0 --host 0.0.0.0 >/tmp/mdreader-lan.log 2>&1 &
PID=$!
for _ in $(seq 1 60); do [ -f "$DATA/run.json" ] && break; sleep 0.2; done
PORT=$(python3 -c "import json;print(json.load(open('$DATA/run.json'))['port'])")
TOKEN=$(cat "$DATA/token")
BASE="http://127.0.0.1:$PORT"
echo "port=$PORT token=$TOKEN"
echo -n "no-token: "; curl -s -o /dev/null -w "%{http_code}\n" "$BASE/api/v1/health"
echo -n "bad-token: "; curl -s -o /dev/null -w "%{http_code}\n" "$BASE/api/v1/health?t=wrong"
echo -n "query-token: "; curl -s -o /dev/null -w "%{http_code}\n" "$BASE/api/v1/health?t=$TOKEN"
echo -n "index+set-cookie: "; curl -s -D /tmp/lan-headers -o /dev/null -w "%{http_code}\n" "$BASE/?t=$TOKEN"
grep -i "set-cookie" /tmp/lan-headers
COOKIE=$(grep -i "set-cookie" /tmp/lan-headers | sed 's/^[Ss]et-[Cc]ookie: //' | cut -d';' -f1 | tr -d '\r')
echo -n "cookie: "; curl -s -o /dev/null -w "%{http_code}\n" -H "Cookie: $COOKIE" "$BASE/api/v1/library/stats"
echo -n "read-only write: "; curl -s -o /dev/null -w "%{http_code}\n" -X POST "$BASE/api/v1/docs?t=$TOKEN" -H 'Content-Type: application/json' -H 'X-Reader-Client: 1' -d '{"title":"lan-write"}'
kill $PID 2>/dev/null; wait $PID 2>/dev/null
tail -3 /tmp/mdreader-lan.log
