# Learning Guide BackOffice — 一键环境安装（Windows / PowerShell）
#
# 本项目为 Node.js 工程：依赖版本由 server/package-lock.json、client/package-lock.json 锁定，
# Node 版本见 .nvmrc 与各 package.json 的 engines；无 Python / venv 概念（JS 依赖就地隔离在 node_modules）。
#
# 用法：
#   .\setup.ps1                 # 校验 Node → 安装 server/client 依赖 → 生成 server/.env
#   .\setup.ps1 -WithDocker     # 额外用 Docker Compose 启动 PostgreSQL 16
#   .\setup.ps1 -SkipClient     # 只装后端（或 -SkipServer 只装前端）
#
# 安全：本脚本不安装、也不写入任何密钥；server/.env 由 .env.example 复制而来，凭据需你自行填写。

[CmdletBinding()]
param(
  [switch]$WithDocker,
  [switch]$SkipServer,
  [switch]$SkipClient,
  [string]$DbUser = 'admin',
  [string]$DbPassword = 'admin',
  [string]$DbName = 'learning_guide_db',
  [int]$DbPort = 5432
)

$ErrorActionPreference = 'Stop'
$MinNodeMajor = 22
$MinNodeMinor = 19

$root = Split-Path -Parent $MyInvocation.MyCommand.Path

function Write-Step([string]$Message) { Write-Host "`n==> $Message" -ForegroundColor Cyan }
function Fail([string]$Message) { Write-Host "x $Message" -ForegroundColor Red; exit 1 }

Write-Host 'Learning Guide BackOffice - 环境安装' -ForegroundColor Green
Write-Host "项目根目录：$root"

# 1) 校验 Node / npm
Write-Step '校验 Node.js 与 npm'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Fail "未检测到 Node.js。请先安装 Node.js（推荐 >= ${MinNodeMajor}.${MinNodeMinor}；可用 nvm 按 .nvmrc 安装）。"
}
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  Fail '未检测到 npm，请随 Node.js 一并安装。'
}
$nodeVer = (node -v).Trim().TrimStart('v')
$nodeParts = $nodeVer.Split('.')
$nodeMajor = [int]$nodeParts[0]
$nodeMinor = if ($nodeParts.Length -gt 1) { [int]$nodeParts[1] } else { 0 }
$npmVer = (npm -v).Trim()
Write-Host "Node $nodeVer / npm $npmVer"
if ($nodeMajor -lt $MinNodeMajor -or ($nodeMajor -eq $MinNodeMajor -and $nodeMinor -lt $MinNodeMinor)) {
  Fail "Node.js 版本过低：需 >= $MinNodeMajor.$MinNodeMinor，当前 $nodeVer。请升级（可参考 .nvmrc）。"
}

# 2) 安装依赖（npm ci：严格按 lock 文件重装，保证版本一致）
if (-not $SkipServer) {
  Write-Step '安装后端依赖（server）：npm ci'
  Push-Location (Join-Path $root 'server')
  npm ci
  if ($LASTEXITCODE -ne 0) { Pop-Location; Fail '后端依赖安装失败。' }
  Pop-Location
}
if (-not $SkipClient) {
  Write-Step '安装前端依赖（client）：npm ci'
  Push-Location (Join-Path $root 'client')
  npm ci
  if ($LASTEXITCODE -ne 0) { Pop-Location; Fail '前端依赖安装失败。' }
  Pop-Location
}

# 3) 初始化 server/.env（不覆盖已存在文件）
Write-Step '初始化 server/.env'
$envPath = Join-Path $root 'server/.env'
$examplePath = Join-Path $root 'server/.env.example'
if (Test-Path $envPath) {
  Write-Host "已存在，跳过：$envPath"
} elseif (Test-Path $examplePath) {
  Copy-Item $examplePath $envPath
  Write-Host "已由 .env.example 生成：$envPath" -ForegroundColor Yellow
  Write-Host '→ 请按需修改 DATABASE_URL，并生成 AI_CONFIG_ENCRYPTION_KEY（密钥不入库）。'
} else {
  Fail '未找到 server/.env.example，无法初始化 .env。'
}

# 4) PostgreSQL
Write-Step 'PostgreSQL'
if ($WithDocker) {
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Fail '未检测到 Docker，无法 -WithDocker 启动 PostgreSQL。'
  }
  Write-Host '使用 Docker Compose 启动 PostgreSQL（pgvector/pgvector:pg16）...'
  Push-Location $root
  $env:POSTGRES_PORT = "$DbPort"
  $env:POSTGRES_USER = $DbUser
  $env:POSTGRES_PASSWORD = $DbPassword
  $env:POSTGRES_DB = $DbName
  docker compose up -d postgres
  if ($LASTEXITCODE -ne 0) { Pop-Location; Fail 'docker compose 启动失败。' }
  Pop-Location
  Write-Host '数据库连接串（请写入 server/.env 的 DATABASE_URL）：' -ForegroundColor Yellow
  Write-Host "  postgresql://${DbUser}:${DbPassword}@localhost:${DbPort}/${DbName}"
} else {
  Write-Host '未使用 Docker。若本机已装 PostgreSQL，请确保 server/.env 的 DATABASE_URL 正确。'
  Write-Host '如需一键起库：.\setup.ps1 -WithDocker'
}

# 5) 后续步骤
Write-Step '后续步骤（数据库迁移与启动）'
Write-Host '  cd server'
Write-Host '  npx prisma migrate dev        # 应用迁移'
Write-Host '  npx prisma db seed            # 种子数据（幂等）'
Write-Host '  npm run start:dev             # 后端 http://localhost:3000'
Write-Host '  cd ..\client ; npm run dev    # 前端 http://localhost:5173'
Write-Host "`n环境安装完成。" -ForegroundColor Green
