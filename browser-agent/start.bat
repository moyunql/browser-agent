@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

set "DIR=%~dp0browser-agent"
if not exist "%DIR%\manifest.json" set "DIR=%~dp0"

echo ============================================
echo   Browser Agent - 安装引导
echo ============================================
echo.
echo 扩展目录：
echo   %DIR%
echo.

set "B2345="
for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "try{(Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\2345Explorer.exe').'(default)'}catch{''}"`) do set "B2345=%%i"

set "BCHROME="
if exist "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" set "BCHROME=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
if not defined BCHROME if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "BCHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not defined BCHROME if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "BCHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"

if defined B2345 (
  echo [检测到] 2345 加速浏览器
  echo          !B2345!
) else (
  echo [未检测到] 2345 加速浏览器
)
if defined BCHROME (
  echo [检测到] Google Chrome
  echo          !BCHROME!
) else (
  echo [未检测到] Google Chrome
)

start "" explorer "%DIR%"

echo.
echo 选择要安装到的浏览器：
echo   1 = 2345 加速浏览器
echo   2 = Google Chrome
echo   0 = 只打开目录，我自己来
echo.
set /p CH=输入序号后回车:

if "%CH%"=="1" (
  if defined B2345 (
    start "" "!B2345!" "chrome://extensions/"
    echo 已尝试在 2345 中打开扩展管理页。
  ) else (
    echo 没找到 2345 的安装路径，请手动打开它。
  )
)
if "%CH%"=="2" (
  if defined BCHROME (
    start "" "!BCHROME!" "chrome://extensions/"
    echo 已尝试在 Chrome 中打开扩展管理页。
  ) else (
    echo 没找到 Chrome 的安装路径，请手动打开它。
  )
)

echo.
echo --------------------------------------------
echo 接下来三步（2345 和 Chrome 完全一样）：
echo   1. 右上角打开「开发者模式」
echo   2. 点「加载已解压的扩展程序」
echo   3. 选中上一步弹出的文件夹（含 manifest.json 的那一层）
echo.
echo 如果 2345 里 chrome://extensions 打不开或被重定向：
echo   - 菜单 - 工具 - 扩展管理
echo   - 或者地址栏试   2345://extensions
echo.
echo 装好后如果工具栏上看不到图标，点地址栏右侧的
echo 扩展（拼图）图标，把 Browser Agent 固定出来。
echo --------------------------------------------
echo.
pause
