Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$settings = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'settings.json') -Raw | ConvertFrom-Json
$env:OMP_CODEX_WEB_SHIM_PORT = [string]$settings.shimPort
$env:OMP_CODEX_WEB_UPSTREAM = [string]$settings.upstreamUrl
Write-Host "OMP shim -> $($settings.upstreamUrl). Keep this window open while using OMP."
& $settings.bunPath (Join-Path $PSScriptRoot 'server.ts')
exit $LASTEXITCODE
