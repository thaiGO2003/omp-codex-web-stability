param([string[]]$HelperPath, [switch]$IncludeSelectorTimeout, [switch]$DryRun)
$ErrorActionPreference = 'Stop'
if (-not $HelperPath) {
    $paths = @()
    $versionRoot = Join-Path $env:USERPROFILE '.codex-chatgpt-web\versions'
    if (Test-Path $versionRoot) {
        $paths += @(Get-ChildItem $versionRoot -Filter browser-helper.cjs -Recurse -File | Select-Object -ExpandProperty FullName)
    }
    $descriptorPath = Join-Path $env:USERPROFILE '.codex-chatgpt-web\runtime\launcher-browser.json'
    if (Test-Path $descriptorPath) {
        $descriptor = Get-Content -Raw $descriptorPath | ConvertFrom-Json
        if ($descriptor.helper.script -and (Test-Path $descriptor.helper.script)) { $paths += $descriptor.helper.script }
    }
    $HelperPath = @($paths | Sort-Object -Unique)
}
if (-not $HelperPath) { throw 'No installed helper found. Use -HelperPath with its full path.' }
$pending = @()
foreach ($path in $HelperPath) {
    $text = [IO.File]::ReadAllText($path)
    $markers = @('send:20000,', 'send:60000,', 'send:120000,')
    $present = @($markers | Where-Object { $text.Contains($_) })
    if ($present.Count -ne 1 -or [regex]::Matches($text, [regex]::Escape($present[0])).Count -ne 1) {
        throw "Unknown or ambiguous ordinary Send timeout: $path"
    }
    $changed = $present[0] -ne 'send:120000,'
    $text = $text.Replace($present[0], 'send:120000,')
    if ($IncludeSelectorTimeout) {
        $selectors = @('selectorTimeoutMs??5000', 'selectorTimeoutMs??30000')
        $selector = @($selectors | Where-Object { $text.Contains($_) })
        if ($selector.Count -gt 1 -or ($selector.Count -eq 1 -and
            [regex]::Matches($text, [regex]::Escape($selector[0])).Count -ne 1)) {
            throw "Ambiguous selector timeout: $path"
        }
        if ($selector.Count -eq 0) { Write-Host "Selector timeout layout not recognized; unchanged: $path" }
        elseif ($selector[0] -eq 'selectorTimeoutMs??5000') {
            $text = $text.Replace($selector[0], 'selectorTimeoutMs??30000')
            $changed = $true
        }
    }
    $pending += [pscustomobject]@{ Path=$path; Text=$text; Changed=$changed }
}
foreach ($item in $pending) {
    if (-not $item.Changed) { Write-Host "Requested browser timeouts already installed: $($item.Path)"; continue }
    if ($DryRun) { Write-Host "Would update browser timeouts (Send 120s): $($item.Path)"; continue }
    $backup = "$($item.Path).pre-send-budget-$(Get-Date -Format yyyyMMdd-HHmmss-fffffff).bak"
    Copy-Item -LiteralPath $item.Path -Destination $backup
    $temporary = "$($item.Path).$([guid]::NewGuid().ToString('N')).tmp"
    try {
        [IO.File]::WriteAllText($temporary, $item.Text, [Text.UTF8Encoding]::new($false))
        Move-Item -LiteralPath $temporary -Destination $item.Path -Force
    } finally { if (Test-Path $temporary) { Remove-Item -LiteralPath $temporary } }
    Write-Host "Browser timeouts updated (Send 120s): $($item.Path)"
    Write-Host "Backup: $backup"
}
Write-Host 'Reload Codex Web while idle to load the patched helper.'
