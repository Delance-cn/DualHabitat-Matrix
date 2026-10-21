@echo off
setlocal
cd /d "%~dp0"

if not exist node_modules (
  echo Installing dependencies for the first run, this may take a few minutes...
  call npm install
  if errorlevel 1 (
    echo.
    echo npm install failed. Check your network or run it manually.
    pause
    exit /b 1
  )
)

start "" "node_modules\.bin\electron.cmd" .
endlocal
