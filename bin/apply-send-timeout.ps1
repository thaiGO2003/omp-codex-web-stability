param([string[]]$HelperPath, [switch]$DryRun)
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
    $pending += [pscustomobject]@{ Path=$path; Text=$text.Replace($present[0], 'send:120000,'); Changed=$changed }
}
foreach ($item in $pending) {
    if (-not $item.Changed) { Write-Host "Already 120s: $($item.Path)"; continue }
    if ($DryRun) { Write-Host "Would set Send to 120s: $($item.Path)"; continue }
    $backup = "$($item.Path).pre-send-budget-$(Get-Date -Format yyyyMMdd-HHmmss-fffffff).bak"
    Copy-Item -LiteralPath $item.Path -Destination $backup
    $temporary = "$($item.Path).$([guid]::NewGuid().ToString('N')).tmp"
    try {
        [IO.File]::WriteAllText($temporary, $item.Text, [Text.UTF8Encoding]::new($false))
        Move-Item -LiteralPath $temporary -Destination $item.Path -Force
    } finally { if (Test-Path $temporary) { Remove-Item -LiteralPath $temporary } }
    Write-Host "Send budget set to 120s: $($item.Path)"
    Write-Host "Backup: $backup"
}
Write-Host 'Reload Codex Web while idle to load the patched helper.'
