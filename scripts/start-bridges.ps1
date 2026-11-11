# wait for group-chat server, then launch all agent bridges detached
$root = "C:\Users\34288\.openclaw-autoclaw\workspace\group-chat"
$deadline = (Get-Date).AddSeconds(60)
$ok = $false
while ((Get-Date) -lt $deadline) {
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:8787/healthz" -UseBasicParsing -TimeoutSec 3
    if ($r.StatusCode -eq 200) { $ok = $true; break }
  } catch { Start-Sleep -Seconds 3 }
}
if (-not $ok) { Write-Error "group-chat server not reachable"; exit 1 }

Start-Process -FilePath "node" -ArgumentList "agents/start-all.mjs" -WorkingDirectory $root -WindowStyle Hidden
Write-Output "bridges launched"
