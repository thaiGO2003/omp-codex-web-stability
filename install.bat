@echo off
setlocal EnableExtensions DisableDelayedExpansion
title OMP + Codex Web Stability Installer
if not exist "%~dp0install.ps1" goto missing_script
where powershell.exe >nul 2>nul
if not errorlevel 1 goto use_powershell
where pwsh.exe >nul 2>nul
if not errorlevel 1 goto use_pwsh
echo ERROR: Windows PowerShell or PowerShell 7 is required.
set "install_result=1"
goto finish

:use_powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
set "install_result=%errorlevel%"
goto finish

:use_pwsh
pwsh.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
set "install_result=%errorlevel%"
goto finish

:missing_script
echo ERROR: install.ps1 is missing. Extract the entire repository ZIP first,
echo or download install.ps1 and install.bat into the same folder.
set "install_result=1"

:finish
if "%install_result%"=="0" echo Setup finished successfully.
if not "%install_result%"=="0" echo Setup failed. Read the error above before retrying.
if "%~1"=="" pause
exit /b %install_result%
