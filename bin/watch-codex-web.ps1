<#
.SYNOPSIS
Keeps the local Codex Web (ChatGPT Web bridge) running for OMP.

It auto-updates Codex Web from the upstream GitHub releases when a newer
version is available, closes a running-but-stuck daemon, and relaunches the
launcher whenever the local Responses port is down. This prevents the OMP
"Unable to connect ... ConnectionRefused" failures at the Codex Web origin.
.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File .\bin\watch-codex-web.ps1
.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File .\bin\watch-codex-web.ps1 -InstallTask
.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File .\bin\watch-codex-web.ps1 -Once -DryRun
#>
[CmdletBinding()]
param(
    [string]$UpstreamUrl = 'http://127.0.0.1:17841',
    [string]$HomeDirectory,
    [string]$LauncherPath,
    [string]$Repository = 'miuuyy/codex-chatgpt-web',
    [ValidateRange(5, 3600)][int]$IntervalSeconds = 15,
    [ValidateRange(15, 3600)][int]$StartTimeoutSeconds = 120,
    [ValidateRange(15, 86400)][int]$StuckSeconds = 90,
    [ValidateRange(60, 86400)][int]$UpdateCheckSeconds = 900,
    [switch]$NoAutoUpdate,
    [switch]$InstallTask,
    [switch]$UninstallTask,
    [switch]$Once,
    [switch]$DryRun,
    [switch]$Quiet
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
try { [Console]::OutputEncoding = $utf8 } catch {}

$taskName = 'OMP Codex Web Watchdog'

function Write-WatchdogLog {
    param([string]$Message)
    $line = "{0} {1}" -f (Get-Date).ToString('yyyy-MM-ddTHH:mm:ss'), $Message
    if (-not $script:Quiet) { Write-Host "[watchdog] $Message" }
    if (-not $script:logPath) { return }
    try {
        [void][IO.Directory]::CreateDirectory((Split-Path -Parent $script:logPath))
        Add-Content -LiteralPath $script:logPath -Value $line -Encoding UTF8
        $info = New-Object IO.FileInfo($script:logPath)
        if ($info.Exists -and $info.Length -gt 2MB) {
            $archive = "$($script:logPath).1"
            if ([IO.File]::Exists($archive)) { [IO.File]::Delete($archive) }
            [IO.File]::Move($script:logPath, $archive)
        }
    } catch {}
}

function Resolve-CodexWebHome {
    param([string]$Override)
    if ($Override) { return [IO.Path]::GetFullPath($Override) }
    if ($env:CODEX_CHATGPT_WEB_HOME) { return [IO.Path]::GetFullPath($env:CODEX_CHATGPT_WEB_HOME) }
    return (Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex-chatgpt-web')
}

function Resolve-LauncherPath {
    param([string]$Override)
    $candidates = @()
    if ($Override) { $candidates += $Override }
    if ($env:CODEX_WEB_GPT_LAUNCHER_EXECUTABLE) { $candidates += $env:CODEX_WEB_GPT_LAUNCHER_EXECUTABLE }
    try {
        $registry = Get-ItemProperty -Path 'HKCU:\Software\d1a6026a-6210-588e-9a2b-da3936f94e02' -Name InstallLocation -ErrorAction SilentlyContinue
        if ($registry -and $registry.InstallLocation) { $candidates += (Join-Path $registry.InstallLocation 'Codex Web GPT.exe') }
    } catch {}
    if ($env:LOCALAPPDATA) { $candidates += (Join-Path $env:LOCALAPPDATA 'Programs\Codex Web GPT\Codex Web GPT.exe') }
    $candidates += 'C:\Program Files\Codex Web GPT\Codex Web GPT.exe'
    foreach ($candidate in $candidates) {
        if ($candidate -and [IO.File]::Exists($candidate)) { return [IO.Path]::GetFullPath($candidate) }
    }
    return $null
}

function Get-CodexWebHealth {
    param([string]$BaseUrl, [int]$TimeoutSeconds = 4)
    try {
        $health = Invoke-RestMethod -Uri ($BaseUrl.TrimEnd('/') + '/healthz') -TimeoutSec $TimeoutSeconds -ErrorAction Stop
        if ($health -and $health.service -eq 'codex-chatgpt-web') { return $health }
        return $null
    } catch {
        return $null
    }
}

function Test-CodexWebHealthy {
    param($Health)
    if (-not $Health) { return $false }
    return ($Health.status -eq 'ok' -and $Health.accepting_turns -eq $true)
}

function Test-UpstreamPort {
    param([string]$BaseUrl, [int]$TimeoutMs = 1000)
    try {
        $uri = [uri]$BaseUrl
        $client = New-Object System.Net.Sockets.TcpClient
        try {
            $async = $client.BeginConnect($uri.Host, $uri.Port, $null, $null)
            if (-not $async.AsyncWaitHandle.WaitOne($TimeoutMs)) { return $false }
            $client.EndConnect($async)
            return $true
        } finally { $client.Close() }
    } catch {
        return $false
    }
}

function ConvertTo-ReleaseParts {
    param([string]$Value)
    if (-not $Value) { return $null }
    $match = [regex]::Match(([string]$Value).Trim(), '^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$')
    if (-not $match.Success) { return $null }
    return @{
        Major = [int]$match.Groups[1].Value
        Minor = [int]$match.Groups[2].Value
        Patch = [int]$match.Groups[3].Value
        Pre = $match.Groups[4].Value
    }
}

function Compare-ReleaseVersion {
    param([string]$Left, [string]$Right)
    $a = ConvertTo-ReleaseParts $Left
    $b = ConvertTo-ReleaseParts $Right
    if (-not $a -or -not $b) { throw "Invalid release version comparison: $Left / $Right" }
    foreach ($key in @('Major', 'Minor', 'Patch')) {
        if ($a[$key] -ne $b[$key]) { if ($a[$key] -gt $b[$key]) { return 1 } else { return -1 } }
    }
    if ($a.Pre -eq $b.Pre) { return 0 }
    if (-not $a.Pre) { return 1 }
    if (-not $b.Pre) { return -1 }
    return [string]::Compare($a.Pre, $b.Pre, [StringComparison]::OrdinalIgnoreCase)
}

function Get-InstalledCodexWebVersion {
    param([string]$CodexHome, [string]$Launcher)
    if ($Launcher) {
        $manifest = Join-Path (Split-Path -Parent $Launcher) 'resources\runtime\manifest.json'
        if ([IO.File]::Exists($manifest)) {
            try { return [string]([IO.File]::ReadAllText($manifest, $utf8) | ConvertFrom-Json).appVersion } catch {}
        }
    }
    $config = Join-Path $CodexHome 'config.json'
    if ([IO.File]::Exists($config)) {
        try { return [string]([IO.File]::ReadAllText($config, $utf8) | ConvertFrom-Json).releaseVersion } catch {}
    }
    return $null
}

function Get-LauncherProcesses {
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { return @() }
    try { return @(Get-Process -Name 'Codex Web GPT' -ErrorAction SilentlyContinue) } catch { return @() }
}

function Get-DaemonProcesses {
    param([string]$CodexHome)
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { return @() }
    $ids = @()
    try {
        $processes = Get-CimInstance Win32_Process -Filter "Name = 'bun.exe'" -ErrorAction SilentlyContinue
        foreach ($process in @($processes)) {
            $commandLine = [string]$process.CommandLine
            if ($commandLine -match 'codex-chatgpt-web' -and $commandLine -match 'cli\.js') { $ids += [int]$process.ProcessId }
        }
    } catch {}
    return $ids
}

function Start-CodexWebLauncher {
    param([string]$Launcher)
    if (-not $Launcher -or -not [IO.File]::Exists($Launcher)) {
        Write-WatchdogLog 'Codex Web GPT launcher was not found; cannot start it.'
        return $false
    }
    if ($DryRun) {
        Write-WatchdogLog "Would start: $Launcher"
        return $true
    }
    Write-WatchdogLog "Starting Codex Web GPT: $Launcher"
    try {
        Start-Process -FilePath $Launcher -WorkingDirectory (Split-Path -Parent $Launcher) | Out-Null
        return $true
    } catch {
        Write-WatchdogLog "Could not start the launcher: $($_.Exception.Message)"
        return $false
    }
}

function Stop-CodexWeb {
    param([string]$CodexHome)
    if ($DryRun) {
        Write-WatchdogLog 'Would close the running Codex Web processes.'
        return
    }
    $pids = @()
    $pids += @(Get-LauncherProcesses | ForEach-Object { [int]$_.Id })
    $pids += @(Get-DaemonProcesses -CodexHome $CodexHome)
    $pids = @($pids | Sort-Object -Unique)
    if ($pids.Count -eq 0) { Write-WatchdogLog 'No Codex Web process was running.'; return }
    Write-WatchdogLog ("Closing Codex Web processes: " + ($pids -join ', '))
    foreach ($processId in $pids) {
        try { Stop-Process -Id $processId -Force -ErrorAction Stop } catch {}
    }
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    while ([DateTime]::UtcNow -lt $deadline) {
        if (-not (Test-UpstreamPort -BaseUrl $UpstreamUrl)) { return }
        Start-Sleep -Milliseconds 250
    }
}

function Wait-CodexWebHealthy {
    param([int]$TimeoutSeconds)
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        $health = Get-CodexWebHealth -BaseUrl $UpstreamUrl
        if (Test-CodexWebHealthy -Health $health) { return $health }
        Start-Sleep -Seconds 2
    }
    return $null
}

function Restart-CodexWeb {
    param([string]$CodexHome, [string]$Launcher)
    Write-WatchdogLog 'Restarting Codex Web.'
    Stop-CodexWeb -CodexHome $CodexHome
    if (-not (Start-CodexWebLauncher -Launcher $Launcher)) { return $null }
    $health = Wait-CodexWebHealthy -TimeoutSeconds $StartTimeoutSeconds
    if ($health) { Write-WatchdogLog "Codex Web is ready (v$($health.version))." } else { Write-WatchdogLog "Codex Web did not become ready within $StartTimeoutSeconds seconds." }
    return $health
}

function Get-LatestRelease {
    $headers = @{ 'User-Agent' = 'omp-codex-web-stability-watchdog'; 'Accept' = 'application/vnd.github+json' }
    return Invoke-RestMethod -Uri "https://api.github.com/repos/$Repository/releases/latest" -Headers $headers -TimeoutSec 20 -ErrorAction Stop
}

function Invoke-CodexWebUpdate {
    param([string]$CodexHome, [string]$Launcher)
    try { $release = Get-LatestRelease } catch { Write-WatchdogLog "Update check failed: $($_.Exception.Message)"; return 'failed' }
    $latest = ([string]$release.tag_name).TrimStart('v')
    if (-not (ConvertTo-ReleaseParts $latest)) { Write-WatchdogLog "Upstream returned an invalid release tag: $($release.tag_name)"; return 'failed' }
    $installed = Get-InstalledCodexWebVersion -CodexHome $codexHome -Launcher $Launcher
    if (-not $installed -or -not (ConvertTo-ReleaseParts $installed)) { Write-WatchdogLog 'Installed Codex Web version is unknown; skipping auto-update.'; return 'skipped' }
    if ((Compare-ReleaseVersion -Left $latest -Right $installed) -le 0) { return 'current' }
    $assetName = "codex-web-gpt-$latest-win-x64.exe"
    $asset = @($release.assets | Where-Object { $_.name -eq $assetName }) | Select-Object -First 1
    $checksums = @($release.assets | Where-Object { $_.name -eq 'checksums.txt' }) | Select-Object -First 1
    if (-not $asset) { Write-WatchdogLog "Release $latest has no $assetName asset."; return 'failed' }
    if (-not $checksums) { Write-WatchdogLog "Release $latest has no checksums.txt asset."; return 'failed' }
    if ($DryRun) { Write-WatchdogLog "Would update Codex Web $installed -> $latest."; return 'dry-run' }
    $temp = Join-Path ([IO.Path]::GetTempPath()) ('codex-web-update-' + [guid]::NewGuid().ToString('N'))
    [void][IO.Directory]::CreateDirectory($temp)
    try {
        $installer = Join-Path $temp $assetName
        $checksumsFile = Join-Path $temp 'checksums.txt'
        Invoke-WebRequest -UseBasicParsing -Uri $asset.browser_download_url -OutFile $installer -TimeoutSec 1200
        Invoke-WebRequest -UseBasicParsing -Uri $checksums.browser_download_url -OutFile $checksumsFile -TimeoutSec 60
        $expected = $null
        foreach ($line in (Get-Content -LiteralPath $checksumsFile)) {
            $match = [regex]::Match(([string]$line).Trim(), '^([a-fA-F0-9]{64})\s+(.+)$')
            if ($match.Success -and $match.Groups[2].Value -eq $assetName) { $expected = $match.Groups[1].Value.ToLowerInvariant(); break }
        }
        if (-not $expected) { Write-WatchdogLog "checksums.txt has no entry for $assetName."; return 'failed' }
        $actual = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actual -ne $expected) { Write-WatchdogLog "Checksum mismatch for $assetName; refusing to install."; return 'failed' }
        Write-WatchdogLog "Installing Codex Web $latest (silent)..."
        $process = Start-Process -FilePath $installer -ArgumentList '/S' -Wait -PassThru
        if ($process.ExitCode -ne 0) { Write-WatchdogLog "Codex Web installer exited with code $($process.ExitCode)."; return 'failed' }
        Write-WatchdogLog "Codex Web updated to $latest."
        return 'updated'
    } catch {
        Write-WatchdogLog "Update failed: $($_.Exception.Message)"
        return 'failed'
    } finally {
        Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Restore-SendBudget {
    param([string]$CodexHome)
    $versions = Join-Path $CodexHome 'versions'
    if (-not [IO.Directory]::Exists($versions)) { return }
    $latest = @(Get-ChildItem -LiteralPath $versions -Directory | Sort-Object Name -Descending) | Select-Object -First 1
    if (-not $latest) { return }
    $helper = Join-Path $latest.FullName 'app\browser-helper.cjs'
    if (-not [IO.File]::Exists($helper)) { return }
    $manifestPath = Join-Path $latest.FullName 'manifest.json'
    if ([IO.File]::Exists($manifestPath)) {
        try {
            $manifest = [IO.File]::ReadAllText($manifestPath, $utf8) | ConvertFrom-Json
            if (@($manifest.files | Where-Object { $_.path -eq 'app/browser-helper.cjs' }).Count -gt 0) {
                Write-WatchdogLog "Runtime $($latest.Name) records browser-helper.cjs integrity; run install-and-run.bat / apply-send-timeout.ps1 to re-apply browser fixes."
                return
            }
        } catch {}
    }
    try {
        $text = [IO.File]::ReadAllText($helper, $utf8)
        $changed = $false
        if (-not $text.Contains('send:120000,')) {
            foreach ($marker in @('send:20000,', 'send:60000,')) {
                if ($text.Contains($marker)) { $text = $text.Replace($marker, 'send:120000,'); $changed = $true }
            }
        }
        if ($text.Contains('selectorTimeoutMs??5000')) { $text = $text.Replace('selectorTimeoutMs??5000', 'selectorTimeoutMs??30000'); $changed = $true }
        if ($changed) { [IO.File]::WriteAllText($helper, $text, $utf8); Write-WatchdogLog "Re-applied the Send budget to $($latest.Name)." }
    } catch { Write-WatchdogLog "Could not re-apply the Send budget: $($_.Exception.Message)" }
}

function Install-WatchdogTask {
    param([string]$ScriptPath)
    $argumentList = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $ScriptPath + '"' +
        ' -UpstreamUrl "' + $UpstreamUrl + '"' + ' -IntervalSeconds ' + $IntervalSeconds + ' -StuckSeconds ' + $StuckSeconds
    if ($DryRun) { Write-Host "Would register scheduled task '$taskName': powershell.exe $argumentList"; return }
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'Scheduled tasks are only supported on Windows.' }
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $argumentList
    $trigger = New-ScheduledTaskTrigger -AtLogOn
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
        -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Force `
        -Description 'Keeps Codex Web GPT running: auto-updates, restarts a stuck daemon, relaunches when down.' | Out-Null
    Start-ScheduledTask -TaskName $taskName
    Write-Host "Scheduled task '$taskName' registered and started."
}

function Uninstall-WatchdogTask {
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { return }
    try {
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction Stop
        Write-Host "Scheduled task '$taskName' removed."
    } catch { Write-Host "No scheduled task '$taskName' was registered." }
}

$codexHome = Resolve-CodexWebHome -Override $HomeDirectory
$logPath = Join-Path $codexHome 'diagnostics\omp-watchdog\watchdog.log'

if ($UninstallTask) { Uninstall-WatchdogTask; exit 0 }

$scriptPath = $MyInvocation.MyCommand.Path
if (-not $scriptPath) { $scriptPath = $PSCommandPath }
if ($InstallTask) {
    if (-not $scriptPath) { throw 'Cannot register the scheduled task from a piped script; save watch-codex-web.ps1 first.' }
    Install-WatchdogTask -ScriptPath ([IO.Path]::GetFullPath($scriptPath))
    if (-not $Once) { exit 0 }
}

$launcher = Resolve-LauncherPath -Override $LauncherPath
if (-not $launcher) { Write-WatchdogLog 'Codex Web GPT launcher was not found. Install Codex Web GPT or pass -LauncherPath.' }
else { Write-WatchdogLog "Supervising Codex Web at $UpstreamUrl (launcher: $launcher)." }

$downSince = $null
$degradedSince = $null
$nextUpdateCheck = [DateTime]::UtcNow
$everUp = $false

while ($true) {
    $health = Get-CodexWebHealth -BaseUrl $UpstreamUrl
    if ($health -and (Test-CodexWebHealthy -Health $health)) {
        if (-not $everUp) { Write-WatchdogLog "Codex Web is healthy (v$($health.version), pid $($health.pid))."; $everUp = $true }
        $downSince = $null
        $degradedSince = $null
        if (-not $NoAutoUpdate -and [DateTime]::UtcNow -ge $nextUpdateCheck) {
            $nextUpdateCheck = [DateTime]::UtcNow.AddSeconds($UpdateCheckSeconds)
            $idle = ([int]$health.active_http_turns -eq 0 -and [int]$health.active_browser_turns -eq 0)
            if ($idle) {
                $result = Invoke-CodexWebUpdate -CodexHome $codexHome -Launcher $launcher
                if ($result -eq 'updated') {
                    Restore-SendBudget -CodexHome $codexHome
                    $everUp = $false
                    $deadline = [DateTime]::UtcNow.AddSeconds($StartTimeoutSeconds)
                    while ([DateTime]::UtcNow -lt $deadline -and -not (Get-CodexWebHealth -BaseUrl $UpstreamUrl)) { Start-Sleep -Seconds 2 }
                }
            } else {
                Write-WatchdogLog 'Deferring the auto-update until Codex Web is idle.'
            }
        }
    } elseif ($health) {
        $downSince = $null
        if (-not $degradedSince) {
            $degradedSince = [DateTime]::UtcNow
            Write-WatchdogLog "Codex Web is not accepting turns (status: $($health.status)); watching for a stall."
        } elseif (([DateTime]::UtcNow - $degradedSince).TotalSeconds -ge $StuckSeconds) {
            Write-WatchdogLog "Codex Web stayed stuck for $StuckSeconds seconds."
            $degradedSince = $null
            if (-not (Restart-CodexWeb -CodexHome $codexHome -Launcher $launcher)) { $downSince = [DateTime]::UtcNow }
        }
    } else {
        $degradedSince = $null
        if (-not $downSince) {
            $downSince = [DateTime]::UtcNow
            Write-WatchdogLog "Codex Web is not reachable at $UpstreamUrl."
            if (@(Get-LauncherProcesses).Count -eq 0) {
                [void](Start-CodexWebLauncher -Launcher $launcher)
            }
        } elseif (([DateTime]::UtcNow - $downSince).TotalSeconds -ge $StuckSeconds) {
            Write-WatchdogLog "Codex Web stayed down for $StuckSeconds seconds; relaunching."
            if (-not (Restart-CodexWeb -CodexHome $codexHome -Launcher $launcher)) { $downSince = [DateTime]::UtcNow }
        }
    }

    if ($Once) { break }
    Start-Sleep -Seconds $IntervalSeconds
}
