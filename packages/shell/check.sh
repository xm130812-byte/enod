#!/usr/bin/env bash
set -uo pipefail
export PATH="$HOME/.cargo/bin:$PATH"
cd "$(dirname "$0")/src-tauri"
cargo check > ../check.log 2>&1
echo "rc=$?" >> ../check.log
