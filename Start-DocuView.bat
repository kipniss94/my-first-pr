@echo off
rem ---------------------------------------------------------------------------
rem  DocuView - one-click start. Double-click this file.
rem
rem  Installs what is missing, builds when the sources changed, connects the
rem  SOLIDWORKS installed on this PC, starts everything in the background and
rem  opens the viewer in the browser. The logic lives in tools\launcher.mjs.
rem
rem  Plain ASCII on purpose: cmd.exe reads batch files in the OEM code page, and
rem  Cyrillic text inside a .bat is a classic cause of a launcher that breaks.
rem ---------------------------------------------------------------------------
setlocal
title DocuView
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto nonode

node "%~dp0tools\launcher.mjs" %*
if errorlevel 1 goto failed
exit /b 0

:nonode
echo.
echo   Node.js is not installed on this PC.
echo.
echo   1. The download page opens now.
echo   2. Install the LTS version with the default options.
echo   3. Double-click Start-DocuView.bat again.
echo.
start "" "https://nodejs.org/en/download"
pause
exit /b 1

:failed
echo.
echo   DocuView stopped with an error - the reason is shown above.
echo   Full logs are in the "logs" folder next to this file.
echo.
pause
exit /b 1
