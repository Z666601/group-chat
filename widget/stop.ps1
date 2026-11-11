$widget = "C:\Users\34288\.openclaw-autoclaw\workspace\group-chat\widget"

Get-CimInstance Win32_Process | Where-Object {
  ($_.Name -eq 'electron.exe' -or $_.Name -eq 'pythonw.exe') -and $_.CommandLine -match 'group-chat\\widget'
} | ForEach-Object {
  Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}
Remove-Item -ErrorAction SilentlyContinue (Join-Path $widget '.hwnd')
