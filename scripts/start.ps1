# Compatibility entry point. The Windows launcher lives under script/windows.
[CmdletBinding()]
param(
    [string]$Mode,
    [string]$ApiHosts,
    [string]$WebHosts,
    [string]$LlmHosts,
    [string]$PythonPath,
    [switch]$AndroidBridge,
    [switch]$DesktopAutomation,
    [int]$BackendPort,
    [int]$FrontendPort,
    [switch]$Install,
    [switch]$NoBrowser,
    [switch]$CheckOnly
)

& (Join-Path $PSScriptRoot '../script/windows/start.ps1') @PSBoundParameters
