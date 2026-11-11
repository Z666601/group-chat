' Boot autostart for group-chat agent bridges - zero window (WScript.Shell Run style 0)
CreateObject("WScript.Shell").Run "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ""C:\Users\34288\.openclaw-autoclaw\workspace\group-chat\scripts\start-bridges.ps1""", 0, False
