#!/usr/bin/env bash
# Learning Guide BackOffice — 一键环境安装（macOS / Linux / WSL）
#
# 本项目为 Node.js 工程：依赖版本由 server/package-lock.json、client/package-lock.json 锁定，
# Node 版本见 .nvmrc 与各 package.json 的 engines；无 Python / venv 概念（JS 依赖就地隔离在 node_modules）。
#
# 用法：
#   ./setup.sh                 # 校验 Node → 安装 server/client 依赖 → 生成 server/.env
#   ./setup.sh --with-docker   # 额外用 Docker Compose 启动 PostgreSQL 16
#   ./setup.sh --skip-client   # 只装后端（或 --skip-server 只装前端）
#
# 安全：本脚本不安装、也不写入任何密钥；server/.env 由 .env.example 复制而来，凭据需你自行填写。

set -euo pipefail

MIN_NODE_MAJOR=22
MIN_NODE_MINOR=19
WITH_DOCKER=0
SKIP_SERVER=0
SKIP_CLIENT=0
DB_USER="${DB_USER:-admin}"
DB_PASSWORD="${DB_PASSWORD:-admin}"
DB_NAME="${DB_NAME:-learning_guide_db}"
DB_PORT="${DB_PORT:-5432}"

for arg in "$@"; do
  case "$arg" in
    --with-docker) WITH_DOCKER=1 ;;
    --skip-server) SKIP_SERVER=1 ;;
    --skip-client) SKIP_CLIENT=1 ;;
    -h|--help)
      grep '^# \{0,1\}' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "未知参数：$arg（-h 查看用法）" >&2; exit 2 ;;
  esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

step() { printf '\n==> %s\n' "$1"; }
fail() { printf 'x %s\n' "$1" >&2; exit 1; }

printf 'Learning Guide BackOffice - 环境安装\n项目根目录：%s\n' "$ROOT"

# 1) 校验 Node / npm
step '校验 Node.js 与 npm'
command -v node >/dev/null 2>&1 || fail "未检测到 Node.js。请先安装（推荐 >= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}；可用 nvm 按 .nvmrc 安装）。"
command -v npm >/dev/null 2>&1 || fail '未检测到 npm，请随 Node.js 一并安装。'
NODE_VER="$(node -v | sed 's/^v//')"
NODE_MAJOR="${NODE_VER%%.*}"
NODE_MINOR="${NODE_VER#*.}"; NODE_MINOR="${NODE_MINOR%%.*}"
printf 'Node %s / npm %s\n' "$NODE_VER" "$(npm -v)"
if [ "$NODE_MAJOR" -lt "$MIN_NODE_MAJOR" ] || { [ "$NODE_MAJOR" -eq "$MIN_NODE_MAJOR" ] && [ "$NODE_MINOR" -lt "$MIN_NODE_MINOR" ]; }; then
  fail "Node.js 版本过低：需 >= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}，当前 ${NODE_VER}。请升级（可参考 .nvmrc）。"
fi

# 2) 安装依赖（npm ci：严格按 lock 文件重装，保证版本一致）
if [ "$SKIP_SERVER" -eq 0 ]; then
  step '安装后端依赖（server）：npm ci'
  ( cd "$ROOT/server" && npm ci )
fi
if [ "$SKIP_CLIENT" -eq 0 ]; then
  step '安装前端依赖（client）：npm ci'
  ( cd "$ROOT/client" && npm ci )
fi

# 3) 初始化 server/.env（不覆盖已存在文件）
step '初始化 server/.env'
if [ -f "$ROOT/server/.env" ]; then
  echo "已存在，跳过：$ROOT/server/.env"
elif [ -f "$ROOT/server/.env.example" ]; then
  cp "$ROOT/server/.env.example" "$ROOT/server/.env"
  echo "已由 .env.example 生成：$ROOT/server/.env"
  echo '→ 请按需修改 DATABASE_URL，并生成 AI_CONFIG_ENCRYPTION_KEY（密钥不入库）。'
else
  fail '未找到 server/.env.example，无法初始化 .env。'
fi

# 4) PostgreSQL
step 'PostgreSQL'
if [ "$WITH_DOCKER" -eq 1 ]; then
  command -v docker >/dev/null 2>&1 || fail '未检测到 Docker，无法 --with-docker 启动 PostgreSQL。'
  echo '使用 Docker Compose 启动 PostgreSQL（pgvector/pgvector:pg16）...'
  ( cd "$ROOT" && POSTGRES_PORT="$DB_PORT" POSTGRES_USER="$DB_USER" POSTGRES_PASSWORD="$DB_PASSWORD" POSTGRES_DB="$DB_NAME" docker compose up -d postgres )
  printf '数据库连接串（请写入 server/.env 的 DATABASE_URL）：\n  postgresql://%s:%s@localhost:%s/%s\n' \
    "$DB_USER" "$DB_PASSWORD" "$DB_PORT" "$DB_NAME"
else
  echo '未使用 Docker。若本机已装 PostgreSQL，请确保 server/.env 的 DATABASE_URL 正确。'
  echo '如需一键起库：./setup.sh --with-docker'
fi

# 5) 后续步骤
step '后续步骤（数据库迁移与启动）'
cat <<'EOF'
  cd server
  npx prisma migrate dev        # 应用迁移
  npx prisma db seed            # 种子数据（幂等）
  npm run start:dev             # 后端 http://localhost:3000
  cd ../client && npm run dev   # 前端 http://localhost:5173
EOF
printf '\n环境安装完成。\n'
