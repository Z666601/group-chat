' Stop group chat desktop widget (no console window)
CreateObject("WScript.Shell").Run "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ""C:\Users\34288\.openclaw-autoclaw\workspace\group-chat\widget\stop.ps1""", 0, False
