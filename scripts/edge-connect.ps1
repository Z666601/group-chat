# 直接控制用户的 Edge 浏览器，访问群聊页面并走一遍登录流程
# 使用 Edge DevTools Protocol (CDP) 连接已有的 Edge 实例
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# 先检查 Edge 是否已有调试端口
$debugPort = $null
foreach ($p in @(9222, 9223)) {
  try {
    $r = Invoke-WebRequest "http://127.0.0.1:$p/json/version" -UseBasicParsing -TimeoutSec 2
    $debugPort = $p
    Write-Host "Edge 已在调试端口 $p 运行"
    break
  } catch { }
}

if (-not $debugPort) {
  # 需要带 --remote-debugging-port 重启 Edge
  # 先优雅关闭 Edge
  Write-Host "Edge 未开启调试端口，正在重启 Edge（带调试端口）..."
  Get-Process -Name msedge -ErrorAction SilentlyContinue | ForEach-Object { try { $_.CloseMainWindow() | Out-Null } catch {} }
  Start-Sleep -Seconds 2
  Get-Process -Name msedge -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 1

  $edgePath = "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
  if (-not (Test-Path $edgePath)) { $edgePath = "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe" }
  $userData = "$env:LOCALAPPDATA\Microsoft\Edge\User Data"
  Start-Process -FilePath $edgePath -ArgumentList "--remote-debugging-port=9222", "--restore-last-session", "`"$userData`""
  Start-Sleep -Seconds 4
  $debugPort = 9222
  Write-Host "Edge 已重启，调试端口 $debugPort"
}

# 获取所有页面
$pages = Invoke-WebRequest "http://127.0.0.1:$debugPort/json/list" -UseBasicParsing -TimeoutSec 5 | ForEach-Object { $_.Content } | ConvertFrom-Json
Write-Host ("当前打开页面数: " + $pages.Count)
foreach ($pg in $pages) {
  if ($pg.type -eq 'page') {
    Write-Host ("  [" + $pg.type + "] " + $pg.title.Substring(0, [Math]::Min(60, $pg.title.Length)) + " → " + $pg.url.Substring(0, [Math]::Min(80, $pg.url.Length)))
  }
}
