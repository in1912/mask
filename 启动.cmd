@echo off
rem mask - double-click launcher (ASCII only: cmd.exe parses with OEM codepage)
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Please install Node.js 22.5+ from https://nodejs.org
  pause
  exit /b 1
)

if not exist node_modules (
  echo [1/3] Installing server dependencies...
  call npm install --no-audit --no-fund
  if errorlevel 1 ( echo [ERROR] npm install failed. & pause & exit /b 1 )
)

if not exist web\dist\index.html (
  echo [2/3] Building web UI...
  pushd web
  if not exist node_modules call npm install --no-audit --no-fund
  call npm run build
  popd
  if not exist web\dist\index.html ( echo [ERROR] web build failed. & pause & exit /b 1 )
)

echo [3/3] Starting mask at http://127.0.0.1:9909 ...
rem open browser 2s later (server needs a moment to listen)
start "mask-open-browser" /min cmd /c "timeout /t 2 /nobreak >nul & start http://127.0.0.1:9909"

node --no-warnings server\index.js

echo.
echo Server stopped. (Default port 9909; if busy it uses the next free port - see console above)
pause
