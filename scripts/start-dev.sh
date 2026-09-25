#!/usr/bin/env bash
# 一键启动（Linux / macOS）
# 用法：bash scripts/start-dev.sh
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ ! -f .env ]; then
  cp .env.example .env
  echo "[init] 已从 .env.example 生成 .env"
fi

set -a
# shellcheck disable=SC1091
. ./.env
set +a

echo "[migrate] 初始化数据库结构 ..."
node --no-warnings scripts/migrate.mjs

PORT="${PORT:-8787}"
echo "[serve] 启动群聊服务 → http://127.0.0.1:${PORT}"
exec node --no-warnings server/index.mjs
