# 一键启动（Windows PowerShell）
# 用法：powershell -ExecutionPolicy Bypass -File scripts\start-dev.ps1
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if (-not (Test-Path ".env")) {
  Copy-Item ".env.example" ".env"
  Write-Host "[init] 已从 .env.example 生成 .env" -ForegroundColor Cyan
}

# 读取 .env 到进程环境
Get-Content ".env" | Where-Object { $_ -match "^\s*[^#\s].*=" } | ForEach-Object {
  $i = $_.IndexOf("=")
  $k = $_.Substring(0, $i).Trim()
  $v = $_.Substring($i + 1).Trim()
  [Environment]::SetEnvironmentVariable($k, $v, "Process")
}

Write-Host "[migrate] 初始化数据库结构 ..." -ForegroundColor Cyan
node --no-warnings scripts/migrate.mjs
if ($LASTEXITCODE -ne 0) { Write-Error "迁移失败"; exit $LASTEXITCODE }

$port = if ($env:PORT) { $env:PORT } else { "8787" }
Write-Host "[serve] 启动群聊服务 → http://127.0.0.1:$port" -ForegroundColor Green
node --no-warnings server/index.mjs
