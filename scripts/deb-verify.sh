#!/usr/bin/env bash
set -euo pipefail
DEB=/mnt/d/something/md-reader/release/md-reader_0.1.0_amd64.deb
rm -rf /tmp/debroot
mkdir -p /tmp/debroot
ar p "$DEB" data.tar.gz | tar -xz -C /tmp/debroot
find /tmp/debroot/usr -maxdepth 3 -type f | sed 's#/tmp/debroot##' | sort | head -20
echo "--- core executable ---"
ls -l /tmp/debroot/usr/bin/md-reader-core /tmp/debroot/usr/bin/md-reader-shell
