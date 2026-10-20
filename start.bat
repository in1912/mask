@echo off
rem mask launcher (ASCII only: cmd.exe parses this file with the OEM codepage)
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Install Node.js 22.5+ from https://nodejs.org
  pause
  exit /b 1
)

node -e "const v=process.versions.node.split('.').map(Number);process.exit(v[0]>22||(v[0]===22&&v[1]>=5)?0:1)"
if errorlevel 1 (
  echo [ERROR] Node.js 22.5 or newer is required. Current: & node -v
  echo         This app uses the built-in node:sqlite module.
  pause
  exit /b 1
)

if not exist node_modules (
  echo [1/3] Installing server dependencies...
  call npm install --omit=dev --no-audit --no-fund
  if errorlevel 1 ( echo [ERROR] npm install failed. & pause & exit /b 1 )
)

if not exist web\dist (
  echo [ERROR] web\dist is missing. Please use the official package.
  pause
  exit /b 1
)

echo [2/3] Preparing local engines (first run installs them; this can take a while)...
echo       Engine setup failure does not block the server; built-in rules always work.
echo [3/3] Starting mask at http://127.0.0.1:9909 ...
start "mask-open-browser" /min cmd /c "timeout /t 2 /nobreak >nul & start http://127.0.0.1:9909"

node --no-warnings scripts\start.mjs

echo.
echo Server stopped.
pause
