@echo off
chcp 65001 >nul
cd /d "%~dp0"
node upload.js %1
echo.
pause
