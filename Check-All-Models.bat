@echo off
rem ---------------------------------------------------------------------------
rem  Checks that every SOLIDWORKS part in a folder opens as 3D in DocuView,
rem  and writes a report (HTML + CSV) to the logs folder.
rem
rem    Check-All-Models.bat                      checks C:\User\3D\SW
rem    Check-All-Models.bat "D:\Models"          checks another folder
rem    Check-All-Models.bat "D:\Models" --assemblies   also .SLDASM
rem
rem  DocuView must be running first: Start-DocuView.bat.
rem ---------------------------------------------------------------------------
setlocal
title DocuView - model check
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 goto nonode
node "%~dp0scripts\verify-models.mjs" %*
echo.
pause
exit /b 0

:nonode
echo Node.js is not installed. Run Start-DocuView.bat first.
pause
exit /b 1
