<#
.SYNOPSIS
Reduce 1DevTool background work and keep its UI responsive under CPU/RAM pressure.
.DESCRIPTION
Backs up and changes only two documented preference fields, and adjusts only
1DevTool's own UI process priorities. Does not stop agents or terminals.
.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File .\bin\repair-1devtool-pressure.ps1
.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File .\bin\repair-1devtool-pressure.ps1 -DryRun
#>
[CmdletBinding()]
param([switch]$DryRun)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$configPath = Join-Path $env:APPDATA '1devtool\1devtool.json'

if (-not [IO.File]::Exists($configPath)) { throw "1DevTool preferences are missing: $configPath" }

$original = [IO.File]::ReadAllText($configPath, [Text.Encoding]::UTF8)
$preferences = ($original | ConvertFrom-Json).preferences
if ($null -eq $preferences.browser -or $null -eq $preferences.terminal) {
    throw 'Unrecognized 1DevTool preferences; refusing to edit'
}

$changes = @(
    [pscustomobject]@{ Name = 'sleepInactiveTabsAfterMinutes'; Old = $preferences.browser.sleepInactiveTabsAfterMinutes; New = 5 },
    [pscustomobject]@{ Name = 'dashboardPollSeconds'; Old = $preferences.terminal.dashboardPollSeconds; New = 30 }
)
$updated = $original
foreach ($change in $changes) {
    if ($change.Old -isnot [ValueType] -or [double]$change.Old -le 0) {
        throw "Unexpected value for $($change.Name); refusing to edit"
    }
    $pattern = '("' + [regex]::Escape($change.Name) + '"\s*:\s*)(\d+)'
    if ([regex]::Matches($updated, $pattern).Count -ne 1) {
        throw "Unable to update $($change.Name) safely"
    }
    $updated = [regex]::Replace($updated, $pattern, { param($match) $match.Groups[1].Value + [string]$change.New })
    Write-Output ("{0}: {1} -> {2}" -f $change.Name, $change.Old, $change.New)
}

if ($updated -ne $original -and -not $DryRun) {
    $json = $updated | ConvertFrom-Json
    if ([int]$json.preferences.browser.sleepInactiveTabsAfterMinutes -ne 5 -or
        [int]$json.preferences.terminal.dashboardPollSeconds -ne 30) {
        throw 'Preferences verification failed'
    }
    $backup = "$configPath.pre-pressure-fix-$(Get-Date -Format 'yyyyMMdd-HHmmss').bak"
    $temp = "$configPath.tmp-$([guid]::NewGuid().ToString('N'))"
    try {
        [IO.File]::WriteAllText($temp, $updated, [Text.UTF8Encoding]::new($false))
        # Never overwrite concurrent changes from an open 1DevTool window.
        if ([IO.File]::ReadAllText($configPath, [Text.Encoding]::UTF8) -cne $original) {
            throw '1DevTool changed its preferences during the update; retry later'
        }
        [IO.File]::Replace($temp, $configPath, $backup)
        Write-Output "Preferences updated; backup: $backup"
    } finally {
        if ([IO.File]::Exists($temp)) { [IO.File]::Delete($temp) }
    }
} elseif ($DryRun) {
    Write-Output 'Dry run: preferences and priorities unchanged.'
} else {
    Write-Output 'Preferences are already optimized.'
}

$main = @(Get-Process '1DevTool' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 })
foreach ($proc in $main) {
    $oldClass = $proc.PriorityClass
    if ($oldClass -in @([Diagnostics.ProcessPriorityClass]::Normal, [Diagnostics.ProcessPriorityClass]::BelowNormal, [Diagnostics.ProcessPriorityClass]::Idle)) {
        if (-not $DryRun) { $proc.PriorityClass = [Diagnostics.ProcessPriorityClass]::AboveNormal }
        Write-Output "Main UI PID $($proc.Id): $oldClass -> AboveNormal"
    }
}

# The largest renderer normally hosts the working UI. Restore scheduling
# fairness if Windows/Electron left it at Idle priority. Leave other tabs alone.
$renderers = @(Get-CimInstance Win32_Process -Filter "Name='1DevTool.exe'" |
    Where-Object { $_.CommandLine -match '--type=renderer' } |
    Sort-Object WorkingSetSize -Descending)
if ($renderers.Count -gt 0) {
    $largest = Get-Process -Id $renderers[0].ProcessId -ErrorAction SilentlyContinue
    if ($largest -and $largest.PriorityClass -eq [Diagnostics.ProcessPriorityClass]::Idle) {
        if (-not $DryRun) { $largest.PriorityClass = [Diagnostics.ProcessPriorityClass]::Normal }
        Write-Output "Largest renderer PID $($largest.Id): Idle -> Normal"
    }
}
if ($DryRun) { Write-Output 'Dry run complete; nothing was changed.' }
else { Write-Output 'Optimization applied to the running UI. Preference changes take full effect on the next normal 1DevTool launch.' }
