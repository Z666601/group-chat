@echo off
rem ASCII-only shim: real logic lives in stop-app.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-app.ps1"
exit /b %errorlevel%
