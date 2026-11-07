#!/usr/bin/env bash
# 冒烟：起 Node 内核，确认契约基线可跑。
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
cd "$ROOT"
DATA=/tmp/mdreader-node-smoke
rm -rf "$DATA"; mkdir -p "$DATA"
READER_ROOT="$ROOT/sample-library" \
READER_NO_OPEN=1 \
node packages/server/src/index.ts --data-dir "$DATA" --port 0 >/tmp/mdreader-node.log 2>&1 &
PID=$!
for _ in $(seq 1 80); do [ -f "$DATA/run.json" ] && break; sleep 0.2; done
if [ ! -f "$DATA/run.json" ]; then echo "node did not start"; cat /tmp/mdreader-node.log; kill $PID 2>/dev/null; exit 1; fi
PORT=$(python3 -c "import json;print(json.load(open('$DATA/run.json'))['port'])")
echo "port=$PORT"
curl -s "http://127.0.0.1:$PORT/api/v1/health"; echo
sleep 3
curl -s "http://127.0.0.1:$PORT/api/v1/library/stats"; echo
curl -s "http://127.0.0.1:$PORT/api/v1/docs?limit=3&sort=title"; echo
kill $PID 2>/dev/null; wait $PID 2>/dev/null
echo "--- log ---"; tail -5 /tmp/mdreader-node.log
