@echo off
setlocal
cd /d "%~dp0"

echo Starting URL to EXE builder...
start "" http://localhost:3000
call npm start
