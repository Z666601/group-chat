@echo off
rem ASCII-only shim: real logic lives in start.ps1 (UTF-8 BOM) to avoid cmd codepage issues
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1"
exit /b %errorlevel%
