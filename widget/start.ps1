$root = "C:\Users\34288\.openclaw-autoclaw\workspace\group-chat"
$widget = Join-Path $root 'widget'
$electron = "C:\Users\34288\AppData\Local\hermes\hermes-agent\node_modules\electron\dist\electron.exe"

$running = Get-CimInstance Win32_Process | Where-Object {
  $_.Name -eq 'electron.exe' -and $_.CommandLine -match 'group-chat\\widget'
}
if ($running) { exit 0 }

Start-Process -FilePath $electron -ArgumentList $widget -WindowStyle Hidden
