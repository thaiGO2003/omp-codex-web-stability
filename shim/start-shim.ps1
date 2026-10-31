Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$settings = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'settings.json') -Raw | ConvertFrom-Json
$port = [int]$settings.shimPort
if ($port -lt 1 -or $port -gt 65535) { throw "Invalid shim port in settings.json: $port" }
$origin = "http://127.0.0.1:$port"
$upstream = [string]$settings.upstreamUrl

function Get-ExistingShim {
    try { return Invoke-RestMethod -Uri "$origin/omp-shim-health" -TimeoutSec 2 -ErrorAction Stop }
    catch { return $null }
}

function Test-LocalPortBusy {
    $client = [Net.Sockets.TcpClient]::new()
    try {
        $connection = $client.BeginConnect('127.0.0.1', $port, $null, $null)
        if (-not $connection.AsyncWaitHandle.WaitOne(300)) { return $false }
        $client.EndConnect($connection)
        return $true
    } catch { return $false }
    finally { $client.Dispose() }
}

function Test-CompatibleShim {
    param($Health)
    # A foreign service can answer on the port with a non-shim body. Strict mode turns a missing
    # property into a terminating error, so inspect the shape before reading it.
    if ($Health -isnot [System.Management.Automation.PSCustomObject]) { return $false }
    $properties = @($Health.PSObject.Properties.Name)
    if ($properties -notcontains 'service' -or $properties -notcontains 'upstreamOrigin') { return $false }
    return ($Health.service -eq 'omp-codex-web-shim' -and $Health.upstreamOrigin -eq $upstream)
}

# A frozen shim still owns its listening socket while refusing connections. Report the exact
# process so the user can close that window instead of guessing which port is stuck.
function Get-PortOwnerDescription {
    param([int]$Port)
    try {
        $owners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop |
            ForEach-Object { [int]$_.OwningProcess } | Sort-Object -Unique)
        $parts = @(foreach ($owner in $owners) {
            $process = Get-Process -Id $owner -ErrorAction SilentlyContinue
            if ($process) { "PID $owner ($($process.ProcessName))" } else { "PID $owner" }
        })
        if ($parts.Count -gt 0) { return ($parts -join ', ') }
    } catch {
        # Get-NetTCPConnection may be unavailable; the caller still gets a useful message.
    }
    return 'an unidentified process'
}

# Hold this mutex for the lifetime of the Bun child to serialize launchers per port.
$mutex = [Threading.Mutex]::new($false, "Local\OMP-Codex-Web-Shim-$port")
$ownsMutex = $false
$exitCode = 0
try {
    try { $ownsMutex = $mutex.WaitOne(0) }
    catch [Threading.AbandonedMutexException] { $ownsMutex = $true }

    if (-not $ownsMutex) {
        $health = Get-ExistingShim
        if (-not (Test-CompatibleShim $health)) {
            throw "Another shim launcher is running on port $port but has not reported compatible health. Check its window before retrying."
        }
        Write-Host "OMP shim already running at $origin; reusing the existing process."
    } else {
        $health = Get-ExistingShim
        if (Test-CompatibleShim $health) {
            Write-Host "OMP shim already running at $origin; no second process started."
        } elseif ($health) {
            throw "Port $port belongs to another shim/service or upstream (owner: $(Get-PortOwnerDescription -Port $port)). Choose a different -ShimPort."
        } elseif (Test-LocalPortBusy) {
            throw "Port $port is occupied by $(Get-PortOwnerDescription -Port $port), which does not respond as the OMP shim. Close that process or its window, or use a different -ShimPort."
        } else {
            if (-not [IO.File]::Exists([string]$settings.bunPath)) {
                throw "Bun not found at the configured path: $($settings.bunPath)"
            }
            $env:OMP_CODEX_WEB_SHIM_PORT = [string]$port
            $env:OMP_CODEX_WEB_UPSTREAM = $upstream
            Write-Host "OMP shim -> $upstream. Keep this window open while using OMP."
            & $settings.bunPath (Join-Path $PSScriptRoot 'server.ts')
            $exitCode = $LASTEXITCODE
        }
    }
} catch {
    [Console]::Error.WriteLine("ERROR: $($_.Exception.Message)")
    $exitCode = 1
} finally {
    if ($ownsMutex) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
exit $exitCode
