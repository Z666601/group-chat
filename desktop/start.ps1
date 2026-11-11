# 群聊 · 一键启动（逻辑主体）
# 由 desktop\启动群聊.cmd 调用；也可直接：powershell -ExecutionPolicy Bypass -File desktop\start.ps1
$ErrorActionPreference = 'Continue'
$ROOT = Split-Path -Parent $PSScriptRoot
$DATA = Join-Path $ROOT 'data'
$LOG = Join-Path $DATA 'launcher.log'
New-Item -ItemType Directory -Force -Path $DATA | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $ROOT 'agents') | Out-Null

function Log([string]$m) {
  $line = "[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $m
  try { Add-Content -Path $LOG -Value $line -Encoding UTF8 } catch {}
  Write-Host $line
}

function Test-Health {
  try {
    $r = Invoke-WebRequest -Uri 'http://127.0.0.1:8787/healthz' -UseBasicParsing -TimeoutSec 3
    return ($r.StatusCode -eq 200)
  } catch { return $false }
}

Log '=========================================='
Log '  多智能体群聊 · 一键启动'
Log '=========================================='

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Log '错误：找不到 node。请先安装 Node.js 22+ 并确保在 PATH 中。'
  Log '（按任意键关闭）'
  $null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')
  exit 1
}

$adminFile = Join-Path $ROOT 'agents\.admin.token'
# 令牌单一来源：.env 里有 ADMIN_TOKEN 就以它为准（与 start-dev 启动链一致），两条链不再各持一把锁
$envFile = Join-Path $ROOT '.env'
$envAdmin = $null
if (Test-Path $envFile) {
  $hit = Select-String -Path $envFile -Pattern '^\s*ADMIN_TOKEN\s*=\s*(.+?)\s*$' | Select-Object -First 1
  if ($hit) { $envAdmin = $hit.Matches[0].Groups[1].Value }
}
if ($envAdmin) {
  $cur = if (Test-Path $adminFile) { (Get-Content $adminFile -Raw).Trim() } else { '' }
  if ($cur -ne $envAdmin) {
    Set-Content -Path $adminFile -Value $envAdmin -NoNewline -Encoding UTF8
    Log '已将 .env 的 ADMIN_TOKEN 同步到 agents\.admin.token（启动链令牌统一）'
  }
} elseif (-not (Test-Path $adminFile)) {
  node --no-warnings -e "const c=require('crypto');require('fs').writeFileSync('agents/.admin.token',c.randomBytes(24).toString('base64url'))"
  Log '已生成管理令牌文件 agents\.admin.token'
}
if (-not (Test-Path (Join-Path $ROOT '.env'))) {
  Copy-Item (Join-Path $ROOT '.env.example') (Join-Path $ROOT '.env') -Force
  Log '已从 .env.example 生成 .env'
}

# ── 1/4 服务 ────────────────────────────────────────
if (Test-Health) {
  Log '[1/4] 群聊服务已在运行'
} else {
  Log '[1/4] 启动群聊服务...'
  $env:DATA_DIR = $DATA
  $env:PORT = '8787'
  $env:HOST = '127.0.0.1'
  $env:ADMIN_TOKEN_FILE = $adminFile
  $env:LOG_LEVEL = 'info'
  $serverLog = Join-Path $DATA 'server.log'
  Start-Process -FilePath 'node' -ArgumentList '--no-warnings','server/index.mjs' `
    -WorkingDirectory $ROOT -WindowStyle Hidden `
    -RedirectStandardOutput $serverLog -RedirectStandardError (Join-Path $DATA 'server.err.log')
}

# ── 2/4 等待就绪 ────────────────────────────────────
Log '[2/4] 等待服务就绪...'
$ok = $false
for ($i = 0; $i -lt 30; $i++) {
  if (Test-Health) { $ok = $true; break }
  Start-Sleep -Milliseconds 800
}
if (-not $ok) {
  Log '服务启动失败。请查看 data\server.log 与 data\launcher.log'
  Log '（按任意键关闭）'
  $null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')
  exit 1
}
Log '    服务已就绪 → http://127.0.0.1:8787'

# ── 3/4 讨论组与 Agent 令牌（幂等）──────────────────
Log '[3/4] 准备多智能体讨论组...'
$env:ADMIN_TOKEN_FILE = $adminFile
$prov = & node --no-warnings (Join-Path $ROOT 'agents/provision.mjs') --group='深蓝四席' 2>&1
$prov | ForEach-Object { Log ('    ' + $_) }

# ── 4/4 Agent 桥接器 ────────────────────────────────
$running = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -match 'agents/bridge.mjs|agents\\bridge.mjs' })
if ($running.Count -gt 0) {
  Log ('[4/4] Agent 桥接器已在运行（' + $running.Count + ' 个）')
} else {
  Log '[4/4] 启动 Agent 桥接器（后台）...'
  Start-Process -FilePath 'node' -ArgumentList '--no-warnings','agents/start-all.mjs' `
    -WorkingDirectory $ROOT -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $DATA 'agents.log') -RedirectStandardError (Join-Path $DATA 'agents.err.log')
}

# ── 打开应用窗口 ────────────────────────────────────
Log '正在打开应用窗口...'
$url = 'http://127.0.0.1:8787'
$chrome = Join-Path ${env:ProgramFiles} 'Google\Chrome\Application\chrome.exe'
$chrome86 = Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'
$edge = Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'
if (Test-Path $chrome) {
  Start-Process -FilePath $chrome -ArgumentList "--app=$url",'--window-size=1280,880'
} elseif (Test-Path $chrome86) {
  Start-Process -FilePath $chrome86 -ArgumentList "--app=$url",'--window-size=1280,880'
} elseif (Test-Path $edge) {
  Start-Process -FilePath $edge -ArgumentList "--app=$url",'--window-size=1280,880'
} else {
  Start-Process $url
}

Log ''
Log '已启动完成。默认账号：app_owner / app_owner_pass_123'
Log '关闭本窗口不会停止服务；需要停止请运行「停止群聊」。'
Log '日志：data\launcher.log / data\server.log / data\agents.log'
Start-Sleep -Seconds 2
