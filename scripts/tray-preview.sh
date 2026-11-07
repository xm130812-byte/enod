#!/usr/bin/env bash
set -uo pipefail
DATA=/tmp/tray-preview-data
rm -rf "$DATA"; mkdir -p "$DATA"
cd /home/xm130812/md-reader/packages/core
READER_ROOT=/mnt/d/something/md-reader/sample-library \
READER_WEB_DIST=/home/xm130812/md-reader/packages/web/dist \
READER_NO_OPEN=1 \
"$HOME/target/debug/md-reader-core" --data-dir "$DATA" --port 0 >/tmp/tray-preview.log 2>&1 &
PID=$!
for _ in $(seq 1 80); do [ -f "$DATA/run.json" ] && break; sleep 0.2; done
if [ ! -f "$DATA/run.json" ]; then echo "FAIL core"; cat /tmp/tray-preview.log; kill $PID 2>/dev/null; exit 1; fi
PORT=$(python3 -c "import json;print(json.load(open('$DATA/run.json'))['port'])")
echo "port=$PORT"
sleep 1
curl -s "http://127.0.0.1:$PORT/api/v1/health"; echo
cd /home/xm130812/md-reader
PLAYWRIGHT_PATH=/tmp/pw/node_modules/playwright CDP_URL=http://127.0.0.1:9222 \
  SHOT=/mnt/d/something/md-reader/docs/screenshots/tray-preview.png \
  node scripts/tray-preview.cjs "http://127.0.0.1:$PORT/tray.html"
RC=$?
kill $PID 2>/dev/null; wait $PID 2>/dev/null
tail -5 /tmp/tray-preview.log
exit $RC
