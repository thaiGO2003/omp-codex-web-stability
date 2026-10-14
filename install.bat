@echo off
setlocal EnableExtensions DisableDelayedExpansion
title OMP + Codex Web Stability Installer
set "stability_script=%~dp0install.ps1"
where pwsh.exe >nul 2>nul
if not errorlevel 1 goto use_pwsh
where powershell.exe >nul 2>nul
if not errorlevel 1 goto use_powershell
echo ERROR: Windows PowerShell or PowerShell 7 is required.
set "install_result=1"
goto finish

:use_powershell
set "stability_shell=powershell.exe"
goto check_bundle

:use_pwsh
set "stability_shell=pwsh.exe"
goto check_bundle

:check_bundle
if not exist "%stability_script%" goto download_bundle
"%stability_shell%" -NoProfile -Command "try { if ([IO.File]::ReadAllText($env:stability_script).Contains('# OMP-STABILITY-BUNDLE: 2026-10-14-rebinding-617')) { exit 0 } } catch {}; exit 1"
if errorlevel 1 goto download_bundle
goto run_bundle

:download_bundle
echo Downloading the updated installer from thaiGO2003/omp-codex-web-stability...
"%stability_shell%" -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $target=$env:stability_script; $temp=$target+'.download-'+[guid]::NewGuid().ToString('N'); try { [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -UseBasicParsing -Uri 'https://raw.githubusercontent.com/thaiGO2003/omp-codex-web-stability/main/install.ps1' -OutFile $temp; $text=[IO.File]::ReadAllText($temp); if (-not $text.Contains('# OMP-STABILITY-BUNDLE: 2026-10-14-rebinding-617')) { throw 'Downloaded installer does not contain the required bundle revision.' }; $tokens=$null; $errors=$null; [void][Management.Automation.Language.Parser]::ParseFile($temp,[ref]$tokens,[ref]$errors); if ($errors.Count -gt 0) { throw 'Downloaded installer failed PowerShell syntax validation.' }; if (Test-Path -LiteralPath $target) { Copy-Item -LiteralPath $target -Destination ($target+'.pre-bootstrap-'+[guid]::NewGuid().ToString('N')+'.bak') }; Move-Item -LiteralPath $temp -Destination $target -Force } catch { Write-Error $_; exit 1 } finally { if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Force } }"
if errorlevel 1 goto download_failed

:run_bundle
"%stability_shell%" -NoProfile -ExecutionPolicy Bypass -File "%stability_script%" %*
set "install_result=%errorlevel%"
goto finish

:download_failed
echo ERROR: Could not download a valid updated installer. The existing file was preserved.
echo Download the full repository ZIP, extract it, and run install.bat again.
set "install_result=1"

:finish
if "%install_result%"=="0" echo Setup finished successfully.
if not "%install_result%"=="0" echo Setup failed. Read the error above before retrying.
if "%~1"=="" pause
exit /b %install_result%
