@echo off
rem Stops DocuView and the background SOLIDWORKS it started.
rem A SOLIDWORKS you opened yourself is never closed.
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 goto nonode
node "%~dp0tools\launcher.mjs" --stop
timeout /t 3 >nul
exit /b 0

:nonode
echo Node.js is not installed, so DocuView cannot be running.
pause
exit /b 1
