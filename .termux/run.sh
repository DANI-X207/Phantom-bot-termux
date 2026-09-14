#!/data/data/com.termux/files/usr/bin/bash
set -Eeuo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$PROJECT_DIR"

export YOUTUBE_DL_DIR="${PREFIX:-/data/data/com.termux/files/usr}/bin"
export YOUTUBE_DL_SKIP_DOWNLOAD=1

if command -v termux-wake-lock >/dev/null 2>&1; then
    termux-wake-lock
fi

exec node index.js
