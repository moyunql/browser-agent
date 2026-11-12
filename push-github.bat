@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo ============================================
echo   推送到 GitHub
echo ============================================
echo.
echo 事先要做的一步（只需一次）：
echo   打开 github.com - 右上角 + - New repository
echo   填仓库名（例如 browser-agent）
echo   权限选 Public 或 Private 都行
echo   **不要**勾 "Add a README file" / .gitignore / license
echo   点 Create repository，然后复制它给你的 HTTPS 地址
echo.
echo 地址长这样： https://github.com/你的用户名/browser-agent.git
echo.

set /p REPO=把仓库地址粘贴到这里后回车:

if "%REPO%"=="" (
  echo 没输入地址，已退出。
  pause
  exit /b 1
)

echo.
echo 正在配置远程仓库...
git remote remove origin 2>nul
git remote add origin "%REPO%"

echo 正在推送...
git branch -M main
git push -u origin main

if %errorlevel%==0 (
  echo.
  echo ============================================
  echo   推送成功
  echo ============================================
  echo 打开 %REPO% 就能看到代码了。
) else (
  echo.
  echo 推送失败。常见原因：
  echo   1. 仓库地址打错了
  echo   2. 仓库已存在且非空（建仓库时勾了 README），先删了重建
  echo   3. 认证失败：首次推送会弹出 GitHub 登录窗口，登录授权后会自动重试
  echo      如果还是不行，改用 Personal Access Token：
  echo      https://github.com/settings/tokens  -  Generate new token (classic)
  echo      勾选 repo 权限，生成后把地址换成：
  echo      https://<你的token>@github.com/用户名/仓库名.git
)

echo.
pause
