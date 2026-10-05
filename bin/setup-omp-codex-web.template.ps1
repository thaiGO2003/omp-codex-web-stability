<#
.SYNOPSIS
Configures OMP Web model roles and installs the full compatibility shim.
.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File .\setup-omp-codex-web.ps1
#>
[CmdletBinding()]
param(
    [string]$AgentDirectory,
    [string]$ShimDirectory,
    [string]$UpstreamUrl = 'http://127.0.0.1:17841',
    [ValidateRange(1, 65535)][int]$ShimPort = 17842,
    [string]$JudgeBaseUrl,
    [string]$BunPath,
    [switch]$NoStart,
    [switch]$DryRun
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8

# EMBEDDED WEB SETUP PAYLOAD

function Get-ConfigPath([string]$Directory, [string]$Name) {
    $path = Join-Path $Directory "$Name.yml"
    $alternate = Join-Path $Directory "$Name.yaml"
    if (-not [IO.File]::Exists($path) -and [IO.File]::Exists($alternate)) { return $alternate }
    return $path
}

function Get-ShimHealth([string]$Url) {
    try { return Invoke-RestMethod -Uri "$Url/omp-shim-health" -TimeoutSec 1 }
    catch { return $null }
}

try {
    if (-not $BunPath) {
        $command = Get-Command bun -ErrorAction SilentlyContinue
        if ($command) { $BunPath = $command.Source }
        else { $BunPath = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.bun/bin/bun.exe' }
    }
    if (-not [IO.File]::Exists($BunPath)) { throw 'Bun not found. Install Bun or supply -BunPath pointing to bun.exe.' }
    $BunPath = [IO.Path]::GetFullPath($BunPath)
    if (-not $AgentDirectory) {
        $AgentDirectory = [Environment]::GetEnvironmentVariable('PI_CODING_AGENT_DIR')
        if (-not $AgentDirectory) { $AgentDirectory = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.omp/agent' }
    }
    if (-not $ShimDirectory) { $ShimDirectory = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.local/share/codex-chatgpt-web-omp-shim' }
    $AgentDirectory = [IO.Path]::GetFullPath($AgentDirectory)
    $ShimDirectory = [IO.Path]::GetFullPath($ShimDirectory)
    $upstream = [uri]$UpstreamUrl
    if (-not $upstream.IsAbsoluteUri -or $upstream.Scheme -notin @('http', 'https') -or
        -not $upstream.IsLoopback -or $upstream.UserInfo -or $upstream.Query -or $upstream.Fragment -or
        $upstream.AbsolutePath -notin @('/', '/v1', '/v1/')) {
        throw 'UpstreamUrl must be the local Codex Web HTTP origin, for example http://127.0.0.1:17841.'
    }
    $UpstreamUrl = $upstream.GetLeftPart([UriPartial]::Authority)
    $shimOrigin = "http://127.0.0.1:$ShimPort"
    if ($upstream.Port -eq $ShimPort) { throw 'ShimPort must differ from the Codex Web upstream port.' }
    if ($JudgeBaseUrl) {
        $judge = [uri]$JudgeBaseUrl
        if (-not $judge.IsAbsoluteUri -or $judge.Scheme -notin @('http', 'https') -or $judge.UserInfo) { throw 'JudgeBaseUrl must be an HTTP URL without credentials.' }
    }

    $payload = $payloadJson | ConvertFrom-Json
    $configPath = Get-ConfigPath $AgentDirectory 'config'
    $modelsPath = Get-ConfigPath $AgentDirectory 'models'
    $temporaryScript = Join-Path ([IO.Path]::GetTempPath()) ('omp-web-config-' + [guid]::NewGuid().ToString('N') + '.ts')
    try {
        [IO.File]::WriteAllText($temporaryScript, [string]$payload.configModule, $utf8)
        $arguments = @($temporaryScript, $configPath, $modelsPath, "$shimOrigin/v1")
        if ($JudgeBaseUrl) { $arguments += $JudgeBaseUrl }
        $preparedOutput = & $BunPath @arguments
        if ($LASTEXITCODE -ne 0) { throw 'Invalid OMP config or models. No installation files changed.' }
        $prepared = ($preparedOutput -join "`n") | ConvertFrom-Json
    } finally {
        if ([IO.File]::Exists($temporaryScript)) { [IO.File]::Delete($temporaryScript) }
    }
    $changes = @($prepared.changes)
    foreach ($file in $payload.files.PSObject.Properties) {
        $path = Join-Path $ShimDirectory $file.Name
        $text = [string]$file.Value
        if (-not [IO.File]::Exists($path) -or [IO.File]::ReadAllText($path, $utf8) -cne $text) {
            $changes += [pscustomobject]@{ path = $path; text = $text }
        }
    }
    $extensionPath = Join-Path $AgentDirectory 'extensions/codex-chatgpt-web-compat.ts'
    $settingsPath = Join-Path $ShimDirectory 'settings.json'
    $settingsText = ([ordered]@{ bunPath = $BunPath; upstreamUrl = $UpstreamUrl; shimPort = $ShimPort } | ConvertTo-Json) + "`n"
    foreach ($entry in @(
        [pscustomobject]@{ path = $extensionPath; text = [string]$payload.extension },
        [pscustomobject]@{ path = $settingsPath; text = $settingsText }
    )) {
        if (-not [IO.File]::Exists($entry.path) -or [IO.File]::ReadAllText($entry.path, $utf8) -cne $entry.text) { $changes += $entry }
    }
    if ($DryRun) {
        foreach ($change in $changes) { Write-Output "Would write: $($change.path)" }
        Write-Output "OMP -> $shimOrigin/v1 -> $UpstreamUrl"
        exit 0
    }

    $existingHealth = Get-ShimHealth $shimOrigin
    if ($existingHealth -and ($existingHealth.service -ne 'omp-codex-web-shim' -or $existingHealth.upstreamOrigin -ne $UpstreamUrl)) {
        throw 'ShimPort is already used by a different shim. Choose a different -ShimPort.'
    }
    $snapshots = @()
    foreach ($change in $changes) {
        $exists = [IO.File]::Exists($change.path)
        $bytes = $null
        if ($exists) { $bytes = [IO.File]::ReadAllBytes($change.path) }
        $snapshots += [pscustomobject]@{ path = $change.path; existed = $exists; bytes = $bytes }
    }
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fffffff'
    try {
        foreach ($change in $changes) {
            if ([IO.File]::Exists($change.path)) {
                $backup = "$($change.path).pre-web-setup-$stamp.bak"
                [IO.File]::Copy($change.path, $backup, $false)
                Write-Output "Backup: $backup"
            }
            [void][IO.Directory]::CreateDirectory((Split-Path -Parent $change.path))
            [IO.File]::WriteAllText($change.path, $change.text, $utf8)
        }
    } catch {
        $writeError = $_
        foreach ($snapshot in $snapshots) {
            if ($snapshot.existed) { [IO.File]::WriteAllBytes($snapshot.path, $snapshot.bytes) }
            elseif ([IO.File]::Exists($snapshot.path)) { [IO.File]::Delete($snapshot.path) }
        }
        throw $writeError
    }
    Write-Output "OMP roles and provider configured: $modelsPath"
    Write-Output 'default/vision/plan/task/web: GPT-5.6 Sol Web high; commit: Instant auto.'
    Write-Output 'Other roles and compaction settings preserved. Restart OMP after setup.'
    $launcher = Join-Path $ShimDirectory 'start-shim.ps1'
    if ($existingHealth) {
        Write-Output 'Shim is already running. If files changed, restart its launcher after active turns finish.'
    } elseif (-not $NoStart -and [Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT) {
        $shell = (Get-Command powershell -ErrorAction SilentlyContinue)
        if (-not $shell) { $shell = Get-Command pwsh }
        [void](Start-Process -FilePath $shell.Source -ArgumentList @('-NoProfile', '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $launcher + '"')) -PassThru)
        $deadline = [DateTime]::UtcNow.AddSeconds(8)
        do {
            Start-Sleep -Milliseconds 250
            $started = Get-ShimHealth $shimOrigin
        } while (-not $started -and [DateTime]::UtcNow -lt $deadline)
        if (-not $started) { Write-Warning 'Shim did not report ready. Check the new PowerShell window; config and shim files were installed.' }
        else { Write-Output "Shim ready: $shimOrigin" }
    } else {
        Write-Output ('Start shim: powershell -NoProfile -ExecutionPolicy Bypass -File "' + $launcher + '"')
    }
    try {
        $catalog = Invoke-RestMethod -Uri "$UpstreamUrl/v1/models" -TimeoutSec 3
        $ids = @($catalog.data | ForEach-Object { $_.id })
        if ($ids -contains 'chatgpt-web/gpt-5.6-sol') { Write-Output 'Codex Web model API reachable; Sol is listed.' }
        else { Write-Warning 'Codex Web responded but Sol is not listed. Check login and available models in Codex Web.' }
    } catch {
        Write-Warning "Codex Web API is not reachable at $UpstreamUrl. Start Codex Web and log in before using OMP; this script does not install Codex Web."
    }
    if ($JudgeBaseUrl) { Write-Output 'Judge: 9router/oc/jev-1.13-free. Supply NINE_ROUTER_API_KEY if your router requires authentication.' }
} catch {
    [Console]::Error.WriteLine("ERROR: $($_.Exception.Message)")
    exit 1
}
