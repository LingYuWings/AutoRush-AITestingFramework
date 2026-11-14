<#
.SYNOPSIS
Starts AutoRush in Electron development mode with renderer DevTools.

.PARAMETER MainInspectorPort
Optionally exposes the Electron main-process Node inspector on 127.0.0.1.

.PARAMETER NoDevTools
Leaves renderer DevTools closed at startup.

.EXAMPLE
.\script\windows\start-electron.ps1 -MainInspectorPort 9229
#>
[CmdletBinding()]
param(
    [switch]$Install,
    [switch]$CheckOnly,
    [switch]$NoDevTools,
    [ValidateRange(1024, 65535)]
    [int]$MainInspectorPort,
    [ValidateRange(1024, 65535)]
    [int]$BackendPort,
    [ValidateRange(1024, 65535)]
    [int]$FrontendPort,
    [string]$PythonPath,
    [string]$ApiHosts,
    [string]$WebHosts,
    [string]$LlmHosts,
    [switch]$AndroidBridge,
    [switch]$DesktopAutomation
)

$ErrorActionPreference = 'Stop'
$launchOptions = @{}
foreach ($entry in $PSBoundParameters.GetEnumerator()) {
    if ($entry.Key -ne 'NoDevTools') { $launchOptions[$entry.Key] = $entry.Value }
}
& (Join-Path $PSScriptRoot 'start.ps1') -Mode Electron -ElectronDevTools:(-not $NoDevTools) @launchOptions
