# Windows-only regression test for the standalone installer's Bun bootstrap.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$installer = Join-Path (Split-Path -Parent $PSScriptRoot) 'install.ps1'
$tokens = $null
$errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($installer, [ref]$tokens, [ref]$errors)
if ($errors.Count -gt 0) { throw 'Installer has PowerShell syntax errors.' }
$functionAst = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Resolve-BunPath' }, $true)
if (-not $functionAst) { throw 'Resolve-BunPath function is missing.' }
. ([scriptblock]::Create($functionAst.Extent.Text))
$invokerAst = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Invoke-BundledScript' }, $true)
if (-not $invokerAst) { throw 'Invoke-BundledScript function is missing.' }
. ([scriptblock]::Create($invokerAst.Extent.Text))

$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('omp-bun-test-' + [guid]::NewGuid().ToString('N'))
$oldBunInstall = $env:BUN_INSTALL
$oldPath = $env:PATH
$shellPath = (Get-Process -Id $PID).Path
try {
    [void][IO.Directory]::CreateDirectory($testRoot)
    $env:BUN_INSTALL = Join-Path $testRoot 'Bun home with spaces'
    $env:PATH = Join-Path $env:WINDIR 'System32'

    try {
        [void](Resolve-BunPath (Join-Path $testRoot 'missing.exe') $false)
        throw 'Explicit missing Bun path was accepted.'
    } catch {
        if ($_.Exception.Message -notmatch 'Bun not found at -BunPath') { throw }
    }
    try {
        [void](Resolve-BunPath $null $true)
        throw 'DryRun attempted to install Bun.'
    } catch {
        if ($_.Exception.Message -notmatch 'DryRun does not install') { throw }
    }

    # Stub the HTTPS download with a local installer. curl.exe is a harmless
    # Windows executable that supports --version, allowing runtime validation.
    $script:fixtureInstaller = Join-Path $testRoot 'fake-install.ps1'
    [IO.File]::WriteAllText($script:fixtureInstaller, @'
[void][IO.Directory]::CreateDirectory((Join-Path $env:BUN_INSTALL 'bin'))
Copy-Item (Join-Path $env:WINDIR 'System32/curl.exe') (Join-Path $env:BUN_INSTALL 'bin/bun.exe')
'@)
    function Invoke-WebRequest {
        param([switch]$UseBasicParsing, [string]$Uri, [string]$OutFile, [int]$TimeoutSec)
        if ($Uri -ne 'https://bun.sh/install.ps1') { throw 'Unexpected installer URL.' }
        Copy-Item -LiteralPath $script:fixtureInstaller -Destination $OutFile
    }

    $expected = Join-Path $env:BUN_INSTALL 'bin/bun.exe'
    $resolved = Resolve-BunPath $null $false
    if ($resolved -ne $expected -or -not [IO.File]::Exists($expected)) { throw 'Automatic Bun bootstrap did not resolve the installed binary.' }
    $workDirectory = $testRoot
    [IO.File]::WriteAllText((Join-Path $workDirectory 'child.ps1'), @'
param([string]$BunPath, [switch]$DryRun)
if (-not $DryRun -or -not [IO.File]::Exists($BunPath)) { throw 'BunPath was not passed to the child.' }
if ($env:OMP_CODEX_WEB_BUN_PATH -ne $BunPath) { throw 'Child did not inherit the resolved Bun path.' }
$command = Get-Command bun.exe -ErrorAction SilentlyContinue
if (-not $command -or $command.Source -ne $BunPath) { throw 'New Bun directory is not available in child PATH.' }
'@)
    Invoke-BundledScript 'child.ps1' @{ BunPath = $expected; DryRun = $true }
    function Invoke-WebRequest { throw 'Already installed Bun was downloaded again.' }
    if ((Resolve-BunPath $null $false) -ne $expected) { throw 'Second run failed to reuse installed Bun.' }
    Write-Host 'Bun bootstrap tests passed.'
} finally {
    $env:BUN_INSTALL = $oldBunInstall
    $env:PATH = $oldPath
    if ([IO.Directory]::Exists($testRoot)) { Remove-Item -LiteralPath $testRoot -Recurse -Force }
}
