<#
.SYNOPSIS
Starts the AutoRush backend and frontend development application.

.EXAMPLE
.\script\windows\start.ps1

.EXAMPLE
.\script\windows\start.ps1 -Mode Electron -ApiHosts "api.example.test" -WebHosts "app.example.test"

.EXAMPLE
.\script\windows\start.ps1 -Install

.EXAMPLE
.\script\windows\start.ps1 -DesktopAutomation:$false

.EXAMPLE
.\scripts\start-local-vision.ps1 -ModelSize 8B
.\script\windows\start.ps1 -WebHosts "127.0.0.1,localhost"
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
    [switch]$DesktopAutomation = $true,
    [ValidateRange(1024, 65535)]
    [int]$BackendPort = 8000,
    [ValidateRange(1024, 65535)]
    [int]$FrontendPort = 5173,
    [switch]$ElectronDevTools,
    [ValidateRange(1024, 65535)]
    [int]$MainInspectorPort,
    [switch]$Install,
    [switch]$NoBrowser,
    [switch]$CheckOnly
)

$ErrorActionPreference = "Stop"
# Keep overrides scoped to this launcher so a restart from the same shell reads fresh settings.
$startupEnvironment = @{}
Get-ChildItem Env: | Where-Object { $_.Name -like 'AUTORUSH_*' -or $_.Name -eq 'PLAYWRIGHT_BROWSERS_PATH' } |
    ForEach-Object { $startupEnvironment[$_.Name] = $_.Value }
try {
$workspace = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$frontendDirectory = Join-Path $workspace "frontend"
$python = if ($PythonPath) { $PythonPath } elseif (Test-Path -LiteralPath (Join-Path $workspace '.venv-dev\Scripts\python.exe')) {
    Join-Path $workspace '.venv-dev\Scripts\python.exe'
} else { Join-Path $workspace '.venv\Scripts\python.exe' }
if (-not (Test-Path -LiteralPath $python)) {
    throw "Python virtual environment is missing. Run: py -3 -m venv .venv"
}
$npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
$npm = if ($npmCommand) { $npmCommand.Source } else { $null }
$env:AUTORUSH_LAUNCH_MODE = if ($Mode -eq 'Electron') { 'electron-dev' } else { 'web-dev' }
if (-not $env:AUTORUSH_CONFIG_PATH) { $env:AUTORUSH_CONFIG_PATH = Join-Path $workspace 'autorush.settings.json' }
$settingsJson = & $python (Join-Path $workspace 'backend/src/autorush/config/runtime.py')
if ($LASTEXITCODE -ne 0) { throw 'Could not read AutoRush runtime settings.' }
$savedSettings = $settingsJson | ConvertFrom-Json
foreach ($setting in $savedSettings.PSObject.Properties) {
    if (-not (Test-Path "Env:$($setting.Name)")) { Set-Item "Env:$($setting.Name)" -Value $setting.Value }
}
if (-not $PSBoundParameters.ContainsKey('BackendPort') -and $env:AUTORUSH_BACKEND_PORT) { $BackendPort = [int]$env:AUTORUSH_BACKEND_PORT }
if (-not $PSBoundParameters.ContainsKey('FrontendPort') -and $env:AUTORUSH_FRONTEND_PORT) { $FrontendPort = [int]$env:AUTORUSH_FRONTEND_PORT }
if (-not $PSBoundParameters.ContainsKey('DesktopAutomation') -and (Test-Path Env:AUTORUSH_DESKTOP_ENABLED)) { $DesktopAutomation = $env:AUTORUSH_DESKTOP_ENABLED -eq '1' }
if ($BackendPort -lt 1024 -or $BackendPort -gt 65535 -or $FrontendPort -lt 1024 -or $FrontendPort -gt 65535) { throw 'Ports must be between 1024 and 65535.' }
$logDirectory = if ($env:AUTORUSH_LOG_DIR) { $env:AUTORUSH_LOG_DIR } else { Join-Path $workspace 'artifacts\dev-logs' }
$env:AUTORUSH_LOG_DIR = $logDirectory
if (-not $env:PLAYWRIGHT_BROWSERS_PATH) { $env:PLAYWRIGHT_BROWSERS_PATH = Join-Path $workspace '.playwright-browsers' }
$backendOutput = Join-Path $logDirectory "backend.out.log"
$backendError = Join-Path $logDirectory "backend.err.log"
$frontendOutput = Join-Path $logDirectory "frontend.out.log"
$frontendError = Join-Path $logDirectory "frontend.err.log"
$electronOutput = Join-Path $logDirectory "electron.out.log"
$electronError = Join-Path $logDirectory "electron.err.log"
$backendProcess = $null
$frontendProcess = $null
$electronProcess = $null
$ownsBackend = $false

# Prefix launcher status messages so they stand out from child process output.
function Write-Step([string]$Message) {
    Write-Host "[AutoRush] $Message" -ForegroundColor Cyan
}

# Probe whether an HTTP endpoint is responding successfully.
function Test-Url([string]$Url) {
    try {
        $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2
        return $response.StatusCode -ge 200 -and $response.StatusCode -lt 300
    }
    catch {
        return $false
    }
}

# Verify the AutoRush health payload before reusing an existing backend.
function Test-BackendHealth([string]$Url) {
    try {
        $response = Invoke-RestMethod -Uri $Url -TimeoutSec 2
        return $response.status -eq "ok"
    }
    catch {
        return $false
    }
}

# Wait for startup or surface the child process's error log.
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

# Stop a launcher-owned process tree from the leaves up.
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

if (-not $npm) {
    throw "npm.cmd was not found. Install Node.js 22 or later."
}
if (-not (Test-Path -LiteralPath $frontendDirectory)) {
    throw "Frontend directory is missing: $frontendDirectory"
}
if ($BackendPort -eq $FrontendPort) {
    throw "BackendPort and FrontendPort must be different."
}
if ($Mode -ne 'Electron' -and ($ElectronDevTools -or $MainInspectorPort)) {
    throw 'Electron debug options require -Mode Electron.'
}
if ($MainInspectorPort -and $MainInspectorPort -in @($BackendPort, $FrontendPort)) {
    throw 'The Electron inspector port must differ from the backend and frontend ports.'
}
& $python --version
if ($LASTEXITCODE -ne 0) { throw "Python environment is invalid. Create a new .venv-dev with py -3 -m venv .venv-dev, then use -Install." }
foreach ($secretName in @('AUTORUSH_PORTAL_TOKEN', 'AUTORUSH_OPERATOR_TOKEN')) {
    $configuredSecret = [Environment]::GetEnvironmentVariable($secretName)
    if ($configuredSecret -and $configuredSecret.Length -lt 32) {
        throw "$secretName must contain at least 32 characters when configured. QR pairing does not require a manually configured token."
    }
}

if ($Install) {
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
    $electronBinary = Join-Path $frontendDirectory "node_modules\electron\dist\electron.exe"
    if (-not (Test-Path -LiteralPath $electronBinary)) {
        throw "Electron binary is missing. Run this script again with -Install after confirming npm can download Electron."
    }
    $node = (Get-Command node.exe).Source
}

if ($DesktopAutomation) {
    & $python -c "import importlib.util, sys; sys.exit(0 if sys.platform == 'win32' and all(importlib.util.find_spec(n) for n in ['pyautogui','PIL']) else 1)"
    if ($LASTEXITCODE -ne 0) { throw 'Desktop automation requires Windows and backend[desktop]. Run with -Install to add the dependencies, or use -DesktopAutomation:$false for Web-only startup.' }
}
Write-Step "Environment check passed (mode: $Mode)"
if ($CheckOnly) { return }

New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
if ($PSBoundParameters.ContainsKey('ApiHosts')) {
    $env:AUTORUSH_ALLOWED_API_HOSTS = $ApiHosts
}
if ($PSBoundParameters.ContainsKey('WebHosts')) { $env:AUTORUSH_ALLOWED_WEB_HOSTS = $WebHosts }
if ($PSBoundParameters.ContainsKey('LlmHosts')) { $env:AUTORUSH_ALLOWED_LLM_HOSTS = $LlmHosts }
$env:AUTORUSH_FRONTEND_PORT = "$FrontendPort"
$env:AUTORUSH_BACKEND_PORT = "$BackendPort"
$env:AUTORUSH_DESKTOP_ENABLED = if ($DesktopAutomation) { '1' } else { '0' }
if (-not (Test-Path Env:AUTORUSH_LOCAL_VISION_LAUNCHER) -and
    -not $savedSettings.PSObject.Properties['AUTORUSH_LOCAL_VISION_LAUNCHER'] -and
    (Test-Path -LiteralPath (Join-Path $workspace 'artifacts/tools/llama-vision-runtime/llama-server.exe'))) {
    $env:AUTORUSH_LOCAL_VISION_LAUNCHER = Join-Path $workspace 'scripts/start-local-vision.ps1'
}
$backendUrl = "http://127.0.0.1:$BackendPort"
$frontendUrl = "http://127.0.0.1:$FrontendPort"

try {
    if ($Mode -eq 'Electron' -and (Test-Url $frontendUrl)) {
        throw "The Electron frontend port is already in use at $frontendUrl. Stop the existing frontend before launching."
    }
    if ($MainInspectorPort -and (Test-Url "http://127.0.0.1:$MainInspectorPort/json/list")) {
        throw "The Electron inspector port $MainInspectorPort is already in use."
    }
    if (Test-BackendHealth "$backendUrl/health") {
        if ($DesktopAutomation) { throw 'An existing backend is running. Stop it and rerun this launcher so desktop automation can be enabled.' }
        if ($AndroidBridge -and ($env:AUTORUSH_PORTAL_TOKEN -or $env:AUTORUSH_OPERATOR_TOKEN)) {
            throw 'An existing backend is running. Stop it before starting -AndroidBridge so configured pairing secrets can take effect.'
        }
        Write-Step "Reusing the healthy backend at $backendUrl"
        Write-Warning "The reused backend keeps its current startup settings. Stop it and rerun this launcher to apply changes."
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
        Write-Step "Starting $Mode frontend at $frontendUrl"
        if ($Mode -eq 'Electron') {
            $frontendProcess = Start-Process -FilePath $node `
                -ArgumentList @(('"' + $viteEntry + '"'), '--host', '127.0.0.1', '--port', $FrontendPort, '--strictPort') `
                -WorkingDirectory $frontendDirectory -WindowStyle Hidden `
                -RedirectStandardOutput $frontendOutput -RedirectStandardError $frontendError -PassThru
        } else {
            $frontendProcess = Start-Process -FilePath $npm `
                -ArgumentList @('run', 'dev', '--', '--port', $FrontendPort) `
                -WorkingDirectory $frontendDirectory -WindowStyle Hidden `
                -RedirectStandardOutput $frontendOutput -RedirectStandardError $frontendError -PassThru
        }
        Wait-Url $frontendUrl $frontendProcess $frontendError
        # A stale server on the port can answer while our own process has already failed to bind.
        Start-Sleep -Milliseconds 500
        if ($frontendProcess.HasExited) {
            throw "Frontend process exited although $frontendUrl responds; another server may hold the port. See $frontendError"
        }
    }

    if ($Mode -eq 'Electron') {
        $electronArguments = @()
        if ($MainInspectorPort) { $electronArguments += "--inspect=127.0.0.1:$MainInspectorPort" }
        if ($MainInspectorPort -or $ElectronDevTools) { $electronArguments += '--enable-logging=stderr' }
        $electronArguments += @('.', "--autorush-frontend-port=$FrontendPort")
        if ($ElectronDevTools) { $electronArguments += '--autorush-open-devtools' }
        Write-Step 'Starting the Electron window'
        $electronProcess = Start-Process -FilePath $electronBinary -ArgumentList $electronArguments `
            -WorkingDirectory $frontendDirectory `
            -RedirectStandardOutput $electronOutput -RedirectStandardError $electronError -PassThru
        # Retain the native handle so Windows PowerShell can read the exit code after shutdown.
        $null = $electronProcess.Handle
        if ($MainInspectorPort) { Wait-Url "http://127.0.0.1:$MainInspectorPort/json/list" $electronProcess $electronError }
    }
    if ($Mode -eq "Web" -and -not $NoBrowser) { Start-Process $frontendUrl }

    Write-Host ""
    Write-Host "AutoRush is running." -ForegroundColor Green
    Write-Host "  Console: $frontendUrl"
    Write-Host "  API docs: $backendUrl/docs"
    Write-Host "  Logs: $logDirectory"
    if ($MainInspectorPort) { Write-Host "  Electron main inspector: 127.0.0.1:$MainInspectorPort" }
    if ($AndroidBridge) { Write-Host '  Android: open Devices in the console to create a one-time pairing QR code.' }
    Write-Host "Press Ctrl+C to stop processes started by this script."
    if ($electronProcess) {
        while (-not $electronProcess.HasExited) {
            if ($frontendProcess.HasExited -or ($ownsBackend -and $backendProcess.HasExited)) {
                throw "An Electron development service stopped unexpectedly. See $logDirectory"
            }
            Start-Sleep -Milliseconds 500
        }
        $electronProcess.WaitForExit()
        if ($electronProcess.ExitCode -ne 0) { throw "Electron exited with code $($electronProcess.ExitCode). See $electronError" }
        return
    }
    $supervised = if ($frontendProcess) { $frontendProcess } elseif ($backendProcess) { $backendProcess } else { $null }
    if ($null -eq $supervised) { return }
    while (-not $supervised.HasExited) { Start-Sleep -Milliseconds 500 }
}
finally {
    Stop-OwnedProcess $electronProcess 'Electron'
    Stop-OwnedProcess $frontendProcess "frontend"
    if ($ownsBackend) { Stop-OwnedProcess $backendProcess "backend" }
}
} finally {
    Get-ChildItem Env: | Where-Object { $_.Name -like 'AUTORUSH_*' -or $_.Name -eq 'PLAYWRIGHT_BROWSERS_PATH' } |
        ForEach-Object { if (-not $startupEnvironment.ContainsKey($_.Name)) { Remove-Item -LiteralPath "Env:$($_.Name)" } }
    foreach ($name in $startupEnvironment.Keys) { Set-Item "Env:$name" -Value $startupEnvironment[$name] }
}
