#!/usr/bin/env bash
# WSL 构建入口：避免通过 wsl.exe 传递 | > 等 shell 元字符。
set -uo pipefail
export PATH="$HOME/.cargo/bin:$PATH"
cd "$(dirname "$0")"
cargo "$@"
