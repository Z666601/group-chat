' Boot autostart for group-chat server - zero window (WScript.Shell Run style 0)
CreateObject("WScript.Shell").Run "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ""C:\Users\34288\.openclaw-autoclaw\workspace\group-chat\scripts\start-dev.ps1""", 0, False
