[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$RuntimePath, [string]$BunPath, [switch]$DryRun)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
# EMBEDDED REBINDING 617 PAYLOAD
$temporaryScript = $null
try {
    if (-not $BunPath) {
        $command = Get-Command bun -ErrorAction SilentlyContinue
        if ($command) { $BunPath = $command.Source }
        else { $BunPath = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.bun/bin/bun.exe' }
    }
    if (-not [IO.File]::Exists($BunPath)) { throw 'Bun not found. Supply -BunPath pointing to bun.exe.' }
    $payload = $payloadJson | ConvertFrom-Json
    $temporaryScript = Join-Path ([IO.Path]::GetTempPath()) ('rebinding617-' + [guid]::NewGuid().ToString('N') + '.ts')
    [IO.File]::WriteAllText($temporaryScript, [string]$payload.module, $utf8)
    & $BunPath $temporaryScript ([IO.Path]::GetFullPath($RuntimePath)) ([string][bool]$DryRun)
    if ($LASTEXITCODE -ne 0) { throw "6.1.7 rebinding failed (exit $LASTEXITCODE)." }
    Write-Host 'Finish active turns, then close/reopen Codex Web to load the updated browser helper.'
} catch {
    [Console]::Error.WriteLine("ERROR: $($_.Exception.Message)")
    exit 1
} finally {
    if ($temporaryScript -and [IO.File]::Exists($temporaryScript)) { [IO.File]::Delete($temporaryScript) }
}
