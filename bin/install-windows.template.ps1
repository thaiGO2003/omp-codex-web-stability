<#
.SYNOPSIS
Installs the bundled OMP + Codex Web stability fixes and compatibility shim.
.EXAMPLE
.\install.ps1 -DryRun
.EXAMPLE
.\install.ps1 -JudgeBaseUrl http://127.0.0.1:20218
#>
[CmdletBinding()]
param(
    [string]$AgentDirectory,
    [string]$ShimDirectory,
    [string]$UpstreamUrl = 'http://127.0.0.1:17841',
    [ValidateRange(1, 65535)][int]$ShimPort = 17842,
    [string]$JudgeBaseUrl,
    [string]$BunPath,
    [string[]]$HelperPath,
    [switch]$SkipBrowserFixes,
    [switch]$NoStart,
    [switch]$DryRun
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8

# EMBEDDED WINDOWS INSTALL PAYLOAD

function Invoke-BundledScript([string]$Name, [hashtable]$Options) {
    $childArguments = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', (Join-Path $workDirectory $Name))
    foreach ($key in $Options.Keys) {
        $value = $Options[$key]
        if ($value -is [bool]) {
            if ($value) { $childArguments += "-$key" }
        } elseif ($null -ne $value -and [string]$value -ne '') {
            $childArguments += "-$key"
            $childArguments += [string]$value
        }
    }
    & $shellPath @childArguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Name failed (exit $LASTEXITCODE). Earlier completed steps may remain installed; their backups are kept beside the changed files."
    }
}

function Get-InstalledHelpers {
    $paths = @()
    $userDirectory = [Environment]::GetFolderPath('UserProfile')
    $versionRoot = Join-Path $userDirectory '.codex-chatgpt-web/versions'
    if ([IO.Directory]::Exists($versionRoot)) {
        $paths += @(Get-ChildItem -LiteralPath $versionRoot -Filter browser-helper.cjs -Recurse -File |
            Select-Object -ExpandProperty FullName)
    }
    $descriptorPath = Join-Path $userDirectory '.codex-chatgpt-web/runtime/launcher-browser.json'
    if ([IO.File]::Exists($descriptorPath)) {
        try {
            $descriptor = [IO.File]::ReadAllText($descriptorPath, $utf8) | ConvertFrom-Json
            if ($descriptor.PSObject.Properties['helper'] -and $descriptor.helper -and
                $descriptor.helper.PSObject.Properties['script'] -and
                [IO.File]::Exists([string]$descriptor.helper.script)) {
                $paths += [string]$descriptor.helper.script
            }
        } catch { Write-Warning 'Could not read the launcher helper path; using discovered version folders.' }
    }
    return @($paths | Sort-Object -Unique)
}

$workDirectory = $null
try {
    $shellPath = (Get-Process -Id $PID).Path
    if (-not $AgentDirectory) {
        $AgentDirectory = [Environment]::GetEnvironmentVariable('PI_CODING_AGENT_DIR')
        if (-not $AgentDirectory) { $AgentDirectory = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.omp/agent' }
    }
    $AgentDirectory = [IO.Path]::GetFullPath($AgentDirectory)
    if (-not $ShimDirectory) { $ShimDirectory = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.local/share/codex-chatgpt-web-omp-shim' }
    $ShimDirectory = [IO.Path]::GetFullPath($ShimDirectory)
    if (-not $BunPath) {
        $command = Get-Command bun -ErrorAction SilentlyContinue
        if ($command) { $BunPath = $command.Source }
        else { $BunPath = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.bun/bin/bun.exe' }
    }
    if (-not [IO.File]::Exists($BunPath)) { throw 'Bun not found. Install Bun, then rerun install.bat; or supply -BunPath C:\path\bun.exe. Codex Web and OMP must also be installed.' }
    $BunPath = [IO.Path]::GetFullPath($BunPath)
    $workDirectory = Join-Path ([IO.Path]::GetTempPath()) ('omp-stability-' + [guid]::NewGuid().ToString('N'))
    [void][IO.Directory]::CreateDirectory($workDirectory)
    $payload = $payloadJson | ConvertFrom-Json
    foreach ($script in $payload.scripts.PSObject.Properties) {
        [IO.File]::WriteAllText((Join-Path $workDirectory $script.Name), [string]$script.Value, $utf8)
    }

    $setupOptions = @{ AgentDirectory = $AgentDirectory; ShimDirectory = $ShimDirectory;
        UpstreamUrl = $UpstreamUrl; ShimPort = $ShimPort; BunPath = $BunPath; JudgeBaseUrl = $JudgeBaseUrl }
    $configPath = Join-Path $AgentDirectory 'config.yml'
    $alternate = Join-Path $AgentDirectory 'config.yaml'
    if (-not [IO.File]::Exists($configPath) -and [IO.File]::Exists($alternate)) { $configPath = $alternate }
    $compactionOptions = @{ OmpConfigPath = $configPath; BunPath = $BunPath; ConfigOnly = $true }

    Write-Host 'Checking OMP configuration and bundled fixes before installation...'
    $previewSetup = $setupOptions.Clone(); $previewSetup.DryRun = $true; $previewSetup.NoStart = $true
    Invoke-BundledScript 'setup-omp-codex-web.ps1' $previewSetup
    $previewCompaction = $compactionOptions.Clone(); $previewCompaction.DryRun = $true
    Invoke-BundledScript 'apply-sse-watchdog.ps1' $previewCompaction

    $helpers = @()
    $rebindingHelpers = @()
    if (-not $SkipBrowserFixes) {
        if (-not $HelperPath) { $HelperPath = @(Get-InstalledHelpers) }
        foreach ($path in @($HelperPath | Sort-Object -Unique)) {
            if (-not [IO.File]::Exists($path)) { throw "Browser helper not found: $path" }
            $text = [IO.File]::ReadAllText($path, $utf8)
            if (-not ($text.Contains('send:20000,') -or $text.Contains('send:60000,') -or $text.Contains('send:120000,'))) {
                Write-Warning "Unsupported Send timeout layout; browser helper unchanged: $path"
                continue
            }
            Invoke-BundledScript 'apply-send-timeout.ps1' @{ HelperPath = $path; IncludeSelectorTimeout = $true; DryRun = $true }
            $helpers += $path
            # The saved-turn rebinding patch is specific to 6.1.4. Never force it into 6.1.6 or newer.
            if ($path -match '[/\\]6\.1\.4-[^/\\]+[/\\]app[/\\]browser-helper\.cjs$') {
                Invoke-BundledScript 'apply-browser-rebinding.ps1' @{ HelperPath = $path; DryRun = $true }
                $rebindingHelpers += $path
            } else { Write-Host "Saved-turn rebinding patch is only for 6.1.4; skipped: $path" }
        }
        if ($helpers.Count -eq 0) { Write-Warning 'No supported browser helper found. Connection and shim setup can still proceed. To patch another install, use -HelperPath C:\path\browser-helper.cjs.' }
    }
    if ($DryRun) { Write-Host 'Preview finished. No installation files changed; no shim was started.'; exit 0 }

    foreach ($path in $rebindingHelpers) {
        Invoke-BundledScript 'apply-browser-rebinding.ps1' @{ HelperPath = $path }
    }
    foreach ($path in $helpers) {
        Invoke-BundledScript 'apply-send-timeout.ps1' @{ HelperPath = $path; IncludeSelectorTimeout = $true }
    }
    $installSetup = $setupOptions.Clone(); $installSetup.NoStart = $true
    Invoke-BundledScript 'setup-omp-codex-web.ps1' $installSetup
    Invoke-BundledScript 'apply-sse-watchdog.ps1' $compactionOptions
    if (-not $NoStart) { Invoke-BundledScript 'setup-omp-codex-web.ps1' $setupOptions }

    Write-Host ''
    Write-Host 'Installation complete: model roles, full shim with SSE recovery, compaction shake -> handoff, and supported browser fixes.'
    Write-Host 'Once active turns finish, close/reopen Codex Web and restart OMP. If the shim was already running, restart its window too.'
    Write-Host ('Start shim later: powershell -NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $ShimDirectory 'start-shim.ps1') + '"')
} catch {
    [Console]::Error.WriteLine("ERROR: $($_.Exception.Message)")
    exit 1
} finally {
    if ($workDirectory -and [IO.Directory]::Exists($workDirectory)) {
        Remove-Item -LiteralPath $workDirectory -Recurse -Force
    }
}
