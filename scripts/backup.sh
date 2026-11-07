#!/usr/bin/env bash
# 把 WSL 主副本备份到 Windows 侧：git bundle + 未提交 diff + release 产物。
# 用法：bash scripts/backup.sh [目标目录]
set -euo pipefail
REPO=$(cd "$(dirname "$0")/.." && pwd)
if [ $# -ge 1 ]; then
  DEST="$1"
elif [ -d /mnt/d/something ]; then
  DEST=/mnt/d/something/md-reader-backup
else
  DEST="$HOME/md-reader-backup"
fi
STAMP=$(date +%Y%m%d-%H%M%S)
mkdir -p "$DEST"
git -C "$REPO" bundle create "$DEST/source-$STAMP.bundle" --all
git -C "$REPO" diff --binary > "$DEST/uncommitted-$STAMP.patch" || true
if [ -d "$REPO/release" ]; then
  mkdir -p "$DEST/release-$STAMP"
  cp -a "$REPO/release/." "$DEST/release-$STAMP/" 2>/dev/null || true
fi
echo "backup: $DEST"
echo "  source-$STAMP.bundle"
echo "  uncommitted-$STAMP.patch"
[ -d "$REPO/release" ] && echo "  release-$STAMP/"
