[CmdletBinding()]
param([string[]]$HelperPath, [switch]$DryRun)
$ErrorActionPreference = "Stop"
$manifest = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("ewogICJ2ZXJzaW9uIjogMSwKICAidXBzdHJlYW1WZXJzaW9uIjogIjYuMS40IiwKICAicGF0Y2hlcyI6IFsKICAgIHsKICAgICAgIm5hbWUiOiAibWF0Y2ggc3VibWl0dGVkIGNvbm5lY3RvciBhbmQgY29tcGxldGUgcHJvbXB0IiwKICAgICAgIm9sZCI6ICJtLmV2YWx1YXRlKChULGIpPT57bGV0IHg9VC5xdWVyeVNlbGVjdG9yQWxsKFwiW2RhdGEtdXNlci1tZXNzYWdlLWJ1YmJsZV1cIiksQT14Lmxlbmd0aD09PTE/eFswXS5xdWVyeVNlbGVjdG9yQWxsKFwiW2RhdGEtc2VhcmNoLXJlc3VsdC10YXJnZXRdXCIpOltdLEM9KFMpPT5TLnJlcGxhY2UoL1xcclxcbj8vZyxgXG5gKTtyZXR1cm4gQS5sZW5ndGg9PT0xJiZDKEFbMF0uaW5uZXJUZXh0KT09PUMoYil9LHQuc3VibWl0dGVkVGV4dCkiLAogICAgICAibmV3IjogIm0uZXZhbHVhdGUoKGdyb3VwLCBzdWJtaXR0ZWQpID0+IHtcbiAgY29uc3QgYnViYmxlcyA9IGdyb3VwLnF1ZXJ5U2VsZWN0b3JBbGwoXCJbZGF0YS11c2VyLW1lc3NhZ2UtYnViYmxlXVwiKTtcbiAgY29uc3QgY29udGVudHMgPSBidWJibGVzLmxlbmd0aCA9PT0gMSA/IGJ1YmJsZXNbMF0ucXVlcnlTZWxlY3RvckFsbChcIltkYXRhLXNlYXJjaC1yZXN1bHQtdGFyZ2V0XVwiKSA6IFtdO1xuICBjb25zdCBub3JtYWxpemUgPSAodGV4dCkgPT4gdGV4dC5yZXBsYWNlKC9cXHJcXG4/L2csIGBcbmApO1xuICBpZiAoY29udGVudHMubGVuZ3RoICE9PSAxKVxuICAgIHJldHVybiBmYWxzZTtcbiAgY29uc3QgY29udGVudCA9IGNvbnRlbnRzWzBdO1xuICBjb25zdCBvYnNlcnZlZCA9IG5vcm1hbGl6ZShjb250ZW50LmlubmVyVGV4dCk7XG4gIGNvbnN0IGV4cGVjdGVkID0gbm9ybWFsaXplKHN1Ym1pdHRlZC50ZXh0KTtcbiAgY29uc3QgZXF1aXZhbGVudCA9IChhY3R1YWwpID0+IHtcbiAgICBpZiAoYWN0dWFsLmxlbmd0aCAhPT0gZXhwZWN0ZWQubGVuZ3RoKVxuICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIGZvciAobGV0IGluZGV4ID0gMDtpbmRleCA8IGV4cGVjdGVkLmxlbmd0aDsgaW5kZXgrKykge1xuICAgICAgaWYgKGFjdHVhbFtpbmRleF0gPT09IGV4cGVjdGVkW2luZGV4XSlcbiAgICAgICAgY29udGludWU7XG4gICAgICBpZiAoZXhwZWN0ZWRbaW5kZXhdICE9PSBcIiBcIiB8fCBhY3R1YWxbaW5kZXhdICE9PSBcIsKgXCIgfHwgZXhwZWN0ZWRbaW5kZXggLSAxXSAhPT0gXCIgXCIgJiYgZXhwZWN0ZWRbaW5kZXggKyAxXSAhPT0gXCIgXCIpXG4gICAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG4gICAgcmV0dXJuIHRydWU7XG4gIH07XG4gIGlmIChlcXVpdmFsZW50KG9ic2VydmVkKSlcbiAgICByZXR1cm4gdHJ1ZTtcbiAgaWYgKCFzdWJtaXR0ZWQuYXBwTWVudGlvbkhyZWYpXG4gICAgcmV0dXJuIGZhbHNlO1xuICBjb25zdCBtZW50aW9ucyA9IGNvbnRlbnQucXVlcnlTZWxlY3RvckFsbCgnW2RhdGEtcHJvbXB0LWxpbmstaHJlZl49XCJhcHA6Ly9cIl0nKTtcbiAgaWYgKG1lbnRpb25zLmxlbmd0aCA9PT0gMSAmJiBtZW50aW9uc1swXS5nZXRBdHRyaWJ1dGUoXCJkYXRhLXByb21wdC1saW5rLWhyZWZcIikgPT09IHN1Ym1pdHRlZC5hcHBNZW50aW9uSHJlZikge1xuICAgIGNvbnN0IGxhYmVsID0gbm9ybWFsaXplKG1lbnRpb25zWzBdLmlubmVyVGV4dCk7XG4gICAgaWYgKCFsYWJlbCB8fCAhb2JzZXJ2ZWQuc3RhcnRzV2l0aChsYWJlbCkpXG4gICAgICByZXR1cm4gZmFsc2U7XG4gICAgcmV0dXJuIFsxLCAyXS5zb21lKChzaXplKSA9PiAvXlsgXFx1MDBhMF0rJC8udGVzdChvYnNlcnZlZC5zbGljZShsYWJlbC5sZW5ndGgsIGxhYmVsLmxlbmd0aCArIHNpemUpKSAmJiBlcXVpdmFsZW50KG9ic2VydmVkLnNsaWNlKGxhYmVsLmxlbmd0aCArIHNpemUpKSk7XG4gIH1cbiAgaWYgKG1lbnRpb25zLmxlbmd0aCA9PT0gMCAmJiAvXlxcJFtcXHctXSsgezEsMn0vLnRlc3Qob2JzZXJ2ZWQpKVxuICAgIHJldHVybiBcInBlbmRpbmdcIjtcbiAgcmV0dXJuIGZhbHNlO1xufSx7dGV4dDp0LnN1Ym1pdHRlZFRleHQsYXBwTWVudGlvbkhyZWY6dC5zdWJtaXR0ZWRBcHBNZW50aW9uSHJlZn0pIgogICAgfSwKICAgIHsKICAgICAgIm5hbWUiOiAid2FpdCBmb3IgY29ubmVjdG9yIGh5ZHJhdGlvbiIsCiAgICAgICJvbGQiOiAiaWYoIWYpdGhyb3cgRXJyb3IoXCJDaGF0R1BUIG9wZW5lZCBhbm90aGVyIHVzZXIgdHVybiB3aGlsZSB0aGUgYm91bmQgYXNzaXN0YW50IHJlc3BvbnNlIHdhcyBkZXRhY2hlZFwiKSIsCiAgICAgICJuZXciOiAiaWYoZj09PVwicGVuZGluZ1wiKXJldHVybiByO2lmKCFmKXRocm93IEVycm9yKFwiQ2hhdEdQVCBvcGVuZWQgYW5vdGhlciB1c2VyIHR1cm4gd2hpbGUgdGhlIGJvdW5kIGFzc2lzdGFudCByZXNwb25zZSB3YXMgZGV0YWNoZWRcIikiCiAgICB9LAogICAgewogICAgICAibmFtZSI6ICJjYXB0dXJlIHNlbGVjdGVkIGFwcCBpZGVudGl0eSBiZWZvcmUgU2VuZCIsCiAgICAgICJvbGQiOiAiYXN5bmMgc2VuZEF0dGFjaGVkUHJvbXB0KGUsdCxyLG4sbyxpLHMsYSl7bGV0IGw9KGF3YWl0IHRoaXMuYWN0aXZlQ29tcG9zZXIoZSkpLmxvY2F0b3IoXCJ4cGF0aD1hbmNlc3Rvcjo6Zm9ybVsxXVwiKS5sb2NhdG9yKGhyKTsiLAogICAgICAibmV3IjogImFzeW5jIHNlbmRBdHRhY2hlZFByb21wdChlLHQscixuLG8saSxzLGEpe2xldCBjb21wb3Nlcj1hd2FpdCB0aGlzLmFjdGl2ZUNvbXBvc2VyKGUpO3Quc3VibWl0dGVkQXBwTWVudGlvbkhyZWY9YXdhaXQgeGUoaihjb21wb3Nlci5ldmFsdWF0ZSgoZWxlbWVudCwgYXBwTmFtZSkgPT4ge1xuICBjb25zdCBtZW50aW9ucyA9IFsuLi5lbGVtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJ1thcHAtbWVudGlvbi1wYXRoXj1cImFwcDovL1wiXVthcHAtbWVudGlvbi1kaXNwbGF5LW5hbWVdW2NvbnRlbnRlZGl0YWJsZT1cImZhbHNlXCJdJyldLmZpbHRlcigobm9kZSkgPT4gbm9kZS5nZXRBdHRyaWJ1dGUoXCJhcHAtbWVudGlvbi1kaXNwbGF5LW5hbWVcIikgPT09IGFwcE5hbWUpO1xuICByZXR1cm4gbWVudGlvbnMubGVuZ3RoID09PSAxID8gbWVudGlvbnNbMF0uZ2V0QXR0cmlidXRlKFwiYXBwLW1lbnRpb24tcGF0aFwiKSA/PyB1bmRlZmluZWQgOiB1bmRlZmluZWQ7XG59LHRoaXMuY29uZmlnLmFwcE5hbWUpLG4pKTtsZXQgbD1jb21wb3Nlci5sb2NhdG9yKFwieHBhdGg9YW5jZXN0b3I6OmZvcm1bMV1cIikubG9jYXRvcihocik7IgogICAgfQogIF0KfQo=")) | ConvertFrom-Json
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
if (-not $HelperPath) { throw 'No installed browser-helper.cjs found. Use -HelperPath with its full path.' }
$pending = @()
foreach ($path in $HelperPath) {
    $text = [IO.File]::ReadAllText($path)
    $already = $true
    foreach ($patch in $manifest.patches) {
        if ([regex]::Matches($text, [regex]::Escape($patch.new)).Count -ne 1) { $already = $false }
    }
    if (-not $already) {
        foreach ($patch in $manifest.patches) {
            if ([regex]::Matches($text, [regex]::Escape($patch.old)).Count -ne 1 -or $text.Contains($patch.new)) {
                throw "Unknown or partially patched helper layout: $path ($($patch.name))"
            }
        }
        foreach ($patch in $manifest.patches) { $text = $text.Replace($patch.old, $patch.new) }
    }
    $pending += [pscustomobject]@{ Path=$path; Text=$text; Changed=(-not $already) }
}
foreach ($item in $pending) {
    if (-not $item.Changed) { Write-Host "Already patched: $($item.Path)"; continue }
    if ($DryRun) { Write-Host "Would patch: $($item.Path)"; continue }
    $backup = "$($item.Path).pre-connector-rebinding-$(Get-Date -Format yyyyMMdd-HHmmss-fffffff).bak"
    Copy-Item -LiteralPath $item.Path -Destination $backup
    $temporary = "$($item.Path).$([guid]::NewGuid().ToString('N')).tmp"
    try {
        [IO.File]::WriteAllText($temporary, $item.Text, [Text.UTF8Encoding]::new($false))
        Move-Item -LiteralPath $temporary -Destination $item.Path -Force
    } finally { if (Test-Path $temporary) { Remove-Item -LiteralPath $temporary } }
    Write-Host "Patched: $($item.Path)"
    Write-Host "Backup: $backup"
}
Write-Host 'Close and reopen Codex Web when no turn is running to load the new helper.'
