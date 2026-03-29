@echo off
setlocal
cd /d "%~dp0"

echo Installing dependencies...
where npm >nul 2>nul
if %errorlevel% neq 0 (
  echo Node.js and npm are required. Install Node.js LTS first.
  pause
  exit /b 1
)

call npm install
if %errorlevel% neq 0 (
  echo npm install failed.
  pause
  exit /b 1
)

if not exist output mkdir output
if not exist temp mkdir temp

echo Setup complete.
echo Next step: run start.bat
pause
