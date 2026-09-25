# Stop group chat: bridges + server. ASCII-only on purpose (no codepage issues).
# Contains NO file deletion.
$ErrorActionPreference = 'Continue'

Write-Host 'Stopping agent bridges...'
$alive = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -match 'bridge.mjs|start-all' })
foreach ($p in $alive) {
  try { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue } catch {}
}
Write-Host ("  stopped " + $alive.Count + " bridge process(es)")

Write-Host 'Stopping group chat server...'
$conns = Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue
if ($conns) {
  foreach ($c in $conns) {
    try { Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue } catch {}
  }
  Write-Host '  stopped listener on 8787'
} else {
  Write-Host '  server was not running'
}

Write-Host ''
Write-Host 'Stopped. Data remains in the data/ folder.'
Start-Sleep -Seconds 2
