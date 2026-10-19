# Run on Windows with PowerShell 7 or Windows PowerShell and Bun installed.
[CmdletBinding()]
param([string]$BunPath = "$env:USERPROFILE\.bun\bin\bun.exe")

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$shell = (Get-Process -Id $PID).Path
$root = Join-Path ([IO.Path]::GetTempPath()) ('shim-singleton-' + [guid]::NewGuid().ToString('N'))
$scriptPath = Join-Path $root 'start-shim.ps1'
$launcher = $null
$listener = $null
try {
    [void][IO.Directory]::CreateDirectory($root)
    Copy-Item (Join-Path $PSScriptRoot '../shim/start-shim.ps1') $scriptPath
    $settingsPath = Join-Path $root 'settings.json'
    $serverPath = Join-Path $root 'server.ts'
    [IO.File]::WriteAllText($serverPath, @'
Bun.serve({ hostname: '127.0.0.1', port: Number(process.env.OMP_CODEX_WEB_SHIM_PORT), fetch(req) {
  return Response.json({ service: 'omp-codex-web-shim', upstreamOrigin: process.env.OMP_CODEX_WEB_UPSTREAM });
}});
'@)

    # A foreign listening process cannot be treated as the existing shim.
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    $listener.Start()
    $occupiedPort = ([Net.IPEndPoint]$listener.LocalEndpoint).Port
    [IO.File]::WriteAllText($settingsPath, (@{bunPath=$BunPath;shimPort=$occupiedPort;upstreamUrl='http://127.0.0.1:17841'} | ConvertTo-Json))
    # Windows PowerShell promotes native stderr to NativeCommandError under Stop.
    $ErrorActionPreference = 'Continue'
    try { $errorOutput = & $shell -NoProfile -NonInteractive -File $scriptPath 2>&1 | Out-String }
    finally { $ErrorActionPreference = 'Stop' }
    if ($LASTEXITCODE -ne 1 -or $errorOutput -notmatch 'occupied') {
        throw "Foreign-port test failed: $errorOutput"
    }
    $agentPath = Join-Path $root 'agent'
    $shimPath = Join-Path $root 'installed-shim'
    $setup = Join-Path $PSScriptRoot '../bin/setup-omp-codex-web.ps1'
    $ErrorActionPreference = 'Continue'
    try {
        $setupError = & $shell -NoProfile -NonInteractive -File $setup -BunPath $BunPath `
            -AgentDirectory $agentPath -ShimDirectory $shimPath -UpstreamUrl 'http://127.0.0.1:1' `
            -ShimPort $occupiedPort -NoStart 2>&1 | Out-String
    } finally { $ErrorActionPreference = 'Stop' }
    if ($LASTEXITCODE -ne 1 -or $setupError -notmatch 'already occupied' -or
        [IO.Directory]::Exists($agentPath) -or [IO.Directory]::Exists($shimPath)) {
        throw "Setup changed files before rejecting the occupied port: $setupError"
    }
    $listener.Stop()
    $listener = $null

    # Start the fake shim with the real launcher and try a second copy.
    $portProbe = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    $portProbe.Start()
    $port = ([Net.IPEndPoint]$portProbe.LocalEndpoint).Port
    $portProbe.Stop()
    [IO.File]::WriteAllText($settingsPath, (@{bunPath=$BunPath;shimPort=$port;upstreamUrl='http://127.0.0.1:17841'} | ConvertTo-Json))
    $launcher = Start-Process -FilePath $shell -ArgumentList @('-NoProfile','-NonInteractive','-File',('"' + $scriptPath + '"')) -PassThru `
        -RedirectStandardOutput (Join-Path $root 'out.log') -RedirectStandardError (Join-Path $root 'err.log')
    $origin = "http://127.0.0.1:$port"
    $healthy = $false
    foreach ($attempt in 1..60) {
        try {
            $health = Invoke-RestMethod -Uri "$origin/omp-shim-health" -TimeoutSec 1
            if ($health.service -eq 'omp-codex-web-shim') { $healthy = $true; break }
        } catch { Start-Sleep -Milliseconds 100 }
    }
    if (-not $healthy) { throw 'First shim did not become healthy' }

    $duplicateOutput = & $shell -NoProfile -NonInteractive -File $scriptPath 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0 -or $duplicateOutput -notmatch 'already running') {
        throw "Second launcher failed to reuse the first: $duplicateOutput"
    }
    if ($launcher.HasExited) { throw 'First launcher exited while checking duplication' }
    Write-Host 'PASS: occupied port rejected before setup changes; duplicate shim reused existing instance.'
} finally {
    if ($listener) { $listener.Stop() }
    if ($launcher -and -not $launcher.HasExited) {
        # Kill only the test fixture process tree, never a user's existing shim.
        & taskkill.exe /PID $launcher.Id /T /F | Out-Null
    }
    if ([IO.Directory]::Exists($root)) { [IO.Directory]::Delete($root, $true) }
}
