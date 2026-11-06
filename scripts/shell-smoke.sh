#!/usr/bin/env bash
# 在无 root 的 WSL 里跑 Tauri Linux 壳：Broadway 后端 + 假 Chrome，验证 core 拉起与 --app 调用。
set -uo pipefail
SYS="$HOME/gtk-sysroot"
DEB=/mnt/d/something/md-reader/release/md-reader_0.1.0_amd64.deb
ROOT=/tmp/shell-deb
HOME_DIR=/tmp/shell-home
rm -rf "$ROOT" "$HOME_DIR" /tmp/fakebin /tmp/fake-chrome.log /tmp/shell.log /tmp/runtime-md
mkdir -p "$ROOT" "$HOME_DIR" /tmp/fakebin /tmp/runtime-md
chmod 700 /tmp/runtime-md
ar p "$DEB" data.tar.gz | tar -xz -C "$ROOT"

cat > /tmp/fakebin/google-chrome <<'SH'
#!/usr/bin/env bash
echo "$@" >> /tmp/fake-chrome.log
exit 0
SH
chmod +x /tmp/fakebin/google-chrome

export LD_LIBRARY_PATH="$SYS/usr/lib"
export PATH="/tmp/fakebin:$SYS/usr/bin:$PATH"
export XDG_RUNTIME_DIR=/tmp/runtime-md
export GDK_BACKEND=broadway
export BROADWAY_DISPLAY=:5
export HOME="$HOME_DIR"
export XDG_DATA_HOME="$HOME_DIR/.local/share"
export XDG_CONFIG_HOME="$HOME_DIR/.config"

broadwayd :5 >/tmp/broadway.log 2>&1 &
BD_PID=$!
sleep 1

dbus-run-session -- "$ROOT/usr/bin/md-reader-shell" >/tmp/shell.log 2>&1 &
SHELL_PID=$!
for _ in $(seq 1 80); do
  [ -f /tmp/fake-chrome.log ] && break
  sleep 0.25
done
if [ ! -f /tmp/fake-chrome.log ]; then
  echo "FAIL: shell did not launch chrome"
  echo "--- shell.log ---"; tail -25 /tmp/shell.log
  echo "--- broadway.log ---"; tail -10 /tmp/broadway.log
  kill $SHELL_PID $BD_PID 2>/dev/null
  exit 1
fi
ARGS=$(cat /tmp/fake-chrome.log)
echo "chrome args: $ARGS"
URL=$(printf '%s' "$ARGS" | sed -n 's/.*--app=\(http[^ ]*\).*/\1/p')
echo "url: $URL"
CODE=$(curl -s -o /tmp/health.json -w '%{http_code}' "$URL/api/v1/health")
echo "health: $CODE $(cat /tmp/health.json)"
kill $SHELL_PID 2>/dev/null
wait $SHELL_PID 2>/dev/null
kill $BD_PID 2>/dev/null
if [ "$CODE" = "200" ]; then echo "SHELL SMOKE PASS"; else echo "SHELL SMOKE FAIL"; tail -20 /tmp/shell.log; exit 1; fi
