@echo off
cd /d "%~dp0"
if not exist node_modules\electron\dist\electron.exe (
  echo Installing desktop dependencies...
  call npm install
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
set ELECTRON_RUN_AS_NODE=
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
