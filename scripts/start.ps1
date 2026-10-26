<#
.SYNOPSIS
Starts the AutoRush backend and frontend development application.

.EXAMPLE
.\scripts\start.ps1

.EXAMPLE
.\scripts\start.ps1 -Mode Electron -ApiHosts "api.example.test" -WebHosts "app.example.test"

.EXAMPLE
.\scripts\start.ps1 -Install

.EXAMPLE
.\scripts\start-local-vision.ps1 -ModelSize 8B
.\scripts\start.ps1 -WebHosts "127.0.0.1,localhost" -DesktopAutomation
# The loopback model service has an independent lifecycle; discover it in System Settings.
#>
[CmdletBinding()]
param(
    [ValidateSet("Web", "Electron")]
    [string]$Mode = "Web",
    [string]$ApiHosts = "",
    [string]$WebHosts = "",
    [string]$LlmHosts = "",
    [string]$PythonPath = "",
    [switch]$AndroidBridge,
    [switch]$DesktopAutomation,
    [ValidateRange(1024, 65535)]
    [int]$BackendPort = 8000,
    [ValidateRange(1024, 65535)]
    [int]$FrontendPort = 5173,
    [switch]$Install,
    [switch]$NoBrowser,
    [switch]$CheckOnly
)

$ErrorActionPreference = "Stop"
$workspace = Split-Path -Parent $PSScriptRoot
$frontendDirectory = Join-Path $workspace "frontend"
$python = if ($PythonPath) { $PythonPath } elseif (Test-Path -LiteralPath (Join-Path $workspace '.venv-dev\Scripts\python.exe')) {
    Join-Path $workspace '.venv-dev\Scripts\python.exe'
} else { Join-Path $workspace '.venv\Scripts\python.exe' }
$npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
$npm = if ($npmCommand) { $npmCommand.Source } else { $null }
$logDirectory = Join-Path $workspace "artifacts\dev-logs"
$backendOutput = Join-Path $logDirectory "backend.out.log"
$backendError = Join-Path $logDirectory "backend.err.log"
$frontendOutput = Join-Path $logDirectory "frontend.out.log"
$frontendError = Join-Path $logDirectory "frontend.err.log"
$backendProcess = $null
$frontendProcess = $null
$ownsBackend = $false

function Write-Step([string]$Message) {
    Write-Host "[AutoRush] $Message" -ForegroundColor Cyan
}

function Test-Url([string]$Url) {
    try {
        $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2
        return $response.StatusCode -ge 200 -and $response.StatusCode -lt 300
    }
    catch {
        return $false
    }
}

function Test-BackendHealth([string]$Url) {
    try {
        $response = Invoke-RestMethod -Uri $Url -TimeoutSec 2
        return $response.status -eq "ok"
    }
    catch {
        return $false
    }
}

function Wait-Url([string]$Url, [System.Diagnostics.Process]$Process, [string]$ErrorLog) {
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
        if (Test-Url $Url) { return }
        if ($Process.HasExited) {
            $details = if (Test-Path -LiteralPath $ErrorLog) {
                (Get-Content -LiteralPath $ErrorLog -Tail 30) -join [Environment]::NewLine
            } else {
                "No error log was created."
            }
            throw "Process exited before $Url became available.`n$details"
        }
        Start-Sleep -Milliseconds 500
    }
    throw "Timed out waiting for $Url. See $ErrorLog"
}

function Stop-OwnedProcess([System.Diagnostics.Process]$Process, [string]$Name) {
    if ($null -eq $Process -or $Process.HasExited) { return }
    Write-Step "Stopping $Name (PID $($Process.Id))"
    $owned = [System.Collections.Generic.Dictionary[int, int]]::new()
    $owned.Add($Process.Id, 0)
    $allProcesses = @(Get-Process)
    $changed = $true
    while ($changed) {
        $changed = $false
        foreach ($candidate in $allProcesses) {
            if ($owned.ContainsKey($candidate.Id)) { continue }
            try { $parent = $candidate.Parent } catch { continue }
            if ($null -ne $parent -and $owned.ContainsKey($parent.Id)) {
                $owned.Add($candidate.Id, $owned[$parent.Id] + 1)
                $changed = $true
            }
        }
    }
    foreach ($entry in ($owned.GetEnumerator() | Sort-Object Value -Descending)) {
        try { Stop-Process -Id $entry.Key -Force -ErrorAction Stop }
        catch { Write-Warning "Could not stop $Name process $($entry.Key): $($_.Exception.Message)" }
    }
}

if (-not (Test-Path -LiteralPath $python)) {
    throw "Python virtual environment is missing. Run: py -3 -m venv .venv"
}
if (-not $npm) {
    throw "npm.cmd was not found. Install Node.js 22 or later."
}
if (-not (Test-Path -LiteralPath $frontendDirectory)) {
    throw "Frontend directory is missing: $frontendDirectory"
}
if ($BackendPort -eq $FrontendPort) {
    throw "BackendPort and FrontendPort must be different."
}
& $python --version
if ($LASTEXITCODE -ne 0) { throw "Python environment is invalid. Create a new .venv-dev with py -3 -m venv .venv-dev, then use -Install." }
if ($Mode -eq 'Electron' -and $BackendPort -ne 8000) { throw 'Electron currently requires -BackendPort 8000.' }
foreach ($secretName in @('AUTORUSH_PORTAL_TOKEN', 'AUTORUSH_OPERATOR_TOKEN')) {
    $configuredSecret = [Environment]::GetEnvironmentVariable($secretName)
    if ($configuredSecret -and $configuredSecret.Length -lt 32) {
        throw "$secretName must contain at least 32 characters when configured. QR pairing does not require a manually configured token."
    }
}

if ($Install) {
    $env:PLAYWRIGHT_BROWSERS_PATH = Join-Path $workspace ".playwright-browsers"
    Write-Step "Installing Python development and Web dependencies"
    $pythonExtras = if ($DesktopAutomation) { 'dev,web,desktop' } else { 'dev,web' }
    & $python -m pip install -e "$workspace\backend[$pythonExtras]"
    if ($LASTEXITCODE -ne 0) { throw "Python dependency installation failed." }

    Write-Step "Installing Playwright Chromium (headed and headless)"
    & $python -m playwright install chromium
    if ($LASTEXITCODE -ne 0) { throw "Playwright browser installation failed." }

    Write-Step "Installing frontend and Electron dependencies"
    Push-Location $frontendDirectory
    try {
        & $npm install
        if ($LASTEXITCODE -ne 0) { throw "npm install failed." }
    }
    finally {
        Pop-Location
    }
}

$viteEntry = Join-Path $frontendDirectory "node_modules\vite\bin\vite.js"
if (-not (Test-Path -LiteralPath $viteEntry)) {
    throw "Frontend dependencies are missing. Run this script again with -Install."
}
if ($Mode -eq "Electron") {
    if ($FrontendPort -ne 5173) {
        throw "Electron development mode currently requires -FrontendPort 5173."
    }
    $electronBinary = Join-Path $frontendDirectory "node_modules\electron\dist\electron.exe"
    if (-not (Test-Path -LiteralPath $electronBinary)) {
        throw "Electron binary is missing. Run this script again with -Install after confirming npm can download Electron."
    }
}

if ($DesktopAutomation) {
    & $python -c "import importlib.util, sys; sys.exit(0 if sys.platform == 'win32' and all(importlib.util.find_spec(n) for n in ['pyautogui','PIL']) else 1)"
    if ($LASTEXITCODE -ne 0) { throw 'Desktop automation requires Windows and backend[desktop]; use -Install -DesktopAutomation.' }
}
Write-Step "Environment check passed (mode: $Mode)"
if ($CheckOnly) { return }

New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
$env:AUTORUSH_ALLOWED_API_HOSTS = $ApiHosts
$env:AUTORUSH_ALLOWED_WEB_HOSTS = $WebHosts
$env:AUTORUSH_ALLOWED_LLM_HOSTS = $LlmHosts
$env:AUTORUSH_FRONTEND_PORT = "$FrontendPort"
$env:AUTORUSH_BACKEND_PORT = "$BackendPort"
$env:AUTORUSH_DESKTOP_ENABLED = if ($DesktopAutomation) { '1' } else { '0' }
$env:PLAYWRIGHT_BROWSERS_PATH = Join-Path $workspace ".playwright-browsers"
$backendUrl = "http://127.0.0.1:$BackendPort"
$frontendUrl = "http://127.0.0.1:$FrontendPort"

try {
    if (Test-BackendHealth "$backendUrl/health") {
        if ($DesktopAutomation) { throw 'An existing backend is running. Restart it with -DesktopAutomation to enable this capability.' }
        if ($AndroidBridge -and ($env:AUTORUSH_PORTAL_TOKEN -or $env:AUTORUSH_OPERATOR_TOKEN)) {
            throw 'An existing backend is running. Stop it before starting -AndroidBridge so configured pairing secrets can take effect.'
        }
        Write-Step "Reusing the healthy backend at $backendUrl"
        if ($ApiHosts -or $WebHosts -or $LlmHosts) {
            Write-Warning "The reused backend keeps its existing host allowlists; command-line allowlists only apply to a newly started backend."
        }
    }
    else {
        Write-Step "Starting backend at $backendUrl"
        $backendProcess = Start-Process -FilePath $python `
            -ArgumentList @("-m", "uvicorn", "autorush.api.app:app", "--host", "127.0.0.1", "--port", $BackendPort, "--ws", "websockets") `
            -WorkingDirectory $workspace -WindowStyle Hidden `
            -RedirectStandardOutput $backendOutput -RedirectStandardError $backendError -PassThru
        $ownsBackend = $true
        Wait-Url "$backendUrl/health" $backendProcess $backendError
    }

    $reuseFrontend = $Mode -eq "Web" -and (Test-Url $frontendUrl)
    if ($reuseFrontend) {
        Write-Step "Reusing the frontend already serving $frontendUrl"
    }
    else {
        $frontendScript = if ($Mode -eq "Electron") { "electron:dev" } else { "dev" }
        Write-Step "Starting $Mode frontend at $frontendUrl"
        $frontendArguments = if ($Mode -eq "Electron") {
            @("run", $frontendScript)
        } else {
            @("run", $frontendScript, "--", "--port", $FrontendPort)
        }
        $frontendProcess = Start-Process -FilePath $npm `
            -ArgumentList $frontendArguments `
            -WorkingDirectory $frontendDirectory -WindowStyle Hidden `
            -RedirectStandardOutput $frontendOutput -RedirectStandardError $frontendError -PassThru
        Wait-Url $frontendUrl $frontendProcess $frontendError
        # A stale server on the port can answer while our own process has already failed to bind.
        Start-Sleep -Milliseconds 500
        if ($frontendProcess.HasExited) {
            throw "Frontend process exited although $frontendUrl responds; another server may hold the port. See $frontendError"
        }
    }

    if ($Mode -eq "Web" -and -not $NoBrowser) { Start-Process $frontendUrl }

    Write-Host ""
    Write-Host "AutoRush is running." -ForegroundColor Green
    Write-Host "  Console: $frontendUrl"
    Write-Host "  API docs: $backendUrl/docs"
    Write-Host "  Logs: $logDirectory"
    if ($AndroidBridge) { Write-Host '  Android: open Devices in the console to create a one-time pairing QR code.' }
    Write-Host "Press Ctrl+C to stop processes started by this script."
    $supervised = if ($frontendProcess) { $frontendProcess } elseif ($backendProcess) { $backendProcess } else { $null }
    if ($null -eq $supervised) { return }
    while (-not $supervised.HasExited) { Start-Sleep -Milliseconds 500 }
}
finally {
    Stop-OwnedProcess $frontendProcess "frontend"
    if ($ownsBackend) { Stop-OwnedProcess $backendProcess "backend" }
}
