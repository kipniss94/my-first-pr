@echo off
rem Runs fix-ips-word-addin.ps1 bypassing the PowerShell execution policy.
rem Extra arguments are passed through, e.g.: run-fix.cmd -IpsPath "D:\IPS\10\IPS.Installer.Full"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0fix-ips-word-addin.ps1" %*
echo.
pause
