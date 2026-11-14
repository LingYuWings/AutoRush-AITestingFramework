<#
.SYNOPSIS
Builds the Windows x64 installer with its own backend and Playwright browser.
#>
[CmdletBinding()]
param(
    [string]$PythonPath,
    [string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'
$workspace = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
if (-not $PythonPath) { $PythonPath = Join-Path $workspace '.venv-dev/Scripts/python.exe' }
$python = (Resolve-Path -LiteralPath $PythonPath).Path
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $workspace 'frontend/release' }
$output = [IO.Path]::GetFullPath($OutputDirectory)
$staging = Join-Path $workspace ('artifacts/windows-release-' + [guid]::NewGuid().ToString('N'))
$frontend = Join-Path $workspace 'frontend'
$browserRoot = if ($env:PLAYWRIGHT_BROWSERS_PATH) { $env:PLAYWRIGHT_BROWSERS_PATH } else { Join-Path $workspace '.playwright-browsers' }
$browserRoot = (Resolve-Path -LiteralPath $browserRoot).Path

# Stop immediately when a native build tool reports a failure.
function Invoke-ReleaseCommand([string]$Command, [string[]]$Arguments) {
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Command failed with exit code $LASTEXITCODE" }
}

New-Item -ItemType Directory -Path $staging -Force | Out-Null
$oldPyPath = $env:PYTHONPATH
$env:PYTHONPATH = (@((Join-Path $workspace 'backend/src'), $oldPyPath) | Where-Object { $_ }) -join [IO.Path]::PathSeparator
try {
    $source = Join-Path $workspace 'backend/src'
    Invoke-ReleaseCommand $python @('-m', 'PyInstaller', '--noconfirm', '--onedir', '--name', 'autorush-backend',
        '--paths', $source, '--distpath', (Join-Path $staging 'dist'), '--workpath', (Join-Path $staging 'work'),
        '--specpath', $staging, '--collect-data', 'autorush.case_imports', '--collect-all', 'playwright',
        '--hidden-import', 'uvicorn.logging', '--hidden-import', 'uvicorn.loops.asyncio',
        '--hidden-import', 'uvicorn.protocols.http.auto', '--hidden-import', 'uvicorn.protocols.http.h11_impl',
        '--hidden-import', 'uvicorn.protocols.websockets.websockets_impl', '--hidden-import', 'uvicorn.lifespan.on',
        (Join-Path $PSScriptRoot 'release_backend.py'))

    $config = [ordered]@{
        extends = $null
        appId = 'com.autorush.console'
        productName = 'AutoRush AITester'
        artifactName = 'AutoRush-AITester-${version}-win-${arch}-setup.${ext}'
        directories = @{ output = $output }
        files = @('dist/**/*', 'electron/**/*', 'package.json')
        asar = $true
        electronDist = (Join-Path $frontend 'node_modules/electron/dist')
        win = @{ target = 'nsis'; signAndEditExecutable = $false }
        nsis = @{ oneClick = $false; perMachine = $false; runAfterFinish = $false; packElevateHelper = $false; differentialPackage = $false }
        extraResources = @(
            @{ from = (Join-Path $staging 'dist/autorush-backend'); to = 'backend' },
            @{ from = $browserRoot; to = 'playwright-browsers'; filter = @('chromium-*/**/*', 'chromium_headless_shell-*/**/*', 'ffmpeg-*/**/*') }
        )
    }
    $configPath = Join-Path $staging 'builder.json'
    [IO.File]::WriteAllText($configPath, ($config | ConvertTo-Json -Depth 12))
    Push-Location $frontend
    try {
        Invoke-ReleaseCommand 'npm.cmd' @('run', 'build')
        Invoke-ReleaseCommand 'node' @('node_modules/electron-builder/cli.js', '--win', 'nsis', '--x64', '--config', $configPath)
    } finally { Pop-Location }
} finally { $env:PYTHONPATH = $oldPyPath }
