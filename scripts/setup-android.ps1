[CmdletBinding()]
param([switch]$AcceptSdkLicense)
$ErrorActionPreference = 'Stop'
if (-not $AcceptSdkLicense) { throw 'Review https://developer.android.com/studio#downloads and pass -AcceptSdkLicense only after accepting the Android SDK license.' }
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskTools = Join-Path $taskRoot 'artifacts\tools'
$taskDownloads = Join-Path $taskTools 'downloads'
New-Item -ItemType Directory -Path $taskDownloads -Force | Out-Null

function Get-OfficialFile([string]$Url, [string]$Destination) {
    & curl.exe --silent --show-error --fail --location --retry 2 --connect-timeout 20 --max-time 900 --output $Destination $Url
    if ($LASTEXITCODE -ne 0) { throw "Download failed: $Url" }
}

function Get-VerifiedArchive([string]$Url, [string]$Name, [string]$ChecksumUrl) {
    $archive = Join-Path $taskDownloads $Name
    $checksumFile = "$archive.sha256"
    Get-OfficialFile $ChecksumUrl $checksumFile
    $expected = [regex]::Match((Get-Content -LiteralPath $checksumFile -Raw), '[a-fA-F0-9]{64}').Value.ToLowerInvariant()
    if (-not $expected) { throw "Invalid official checksum: $ChecksumUrl" }
    if (-not (Test-Path -LiteralPath $archive)) { Get-OfficialFile $Url $archive }
    if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) { throw "Checksum mismatch: $archive" }
    return $archive
}

$taskJdkDirectory = Join-Path $taskTools 'jdk'
if (-not (Test-Path -LiteralPath $taskJdkDirectory)) {
    $taskJdkPage = Join-Path $taskDownloads 'jdk-downloads.html'
    Get-OfficialFile 'https://learn.microsoft.com/en-us/java/openjdk/download' $taskJdkPage
    $taskJdkMatch = [regex]::Match((Get-Content -LiteralPath $taskJdkPage -Raw), 'href="([^"]*microsoft-jdk-21\.[^"]*-windows-x64\.zip)"')
    if (-not $taskJdkMatch.Success) { throw 'Cannot resolve official Windows x64 JDK 21 download.' }
    $taskJdkUrl = $taskJdkMatch.Groups[1].Value
    $archive = Get-VerifiedArchive $taskJdkUrl 'jdk21.zip' "$taskJdkUrl.sha256sum.txt"
    Expand-Archive -LiteralPath $archive -DestinationPath $taskJdkDirectory
}
$taskJava = Get-ChildItem -LiteralPath $taskJdkDirectory -Filter java.exe -Recurse | Select-Object -First 1
if (-not $taskJava) { throw 'Portable JDK extraction failed.' }
$env:JAVA_HOME = Split-Path -Parent (Split-Path -Parent $taskJava.FullName)
$env:PATH = "$env:JAVA_HOME\bin;$env:PATH"

$taskSdk = Join-Path $taskTools 'android-sdk'
$taskSdkManager = Join-Path $taskSdk 'cmdline-tools\latest\bin\sdkmanager.bat'
if (-not (Test-Path -LiteralPath $taskSdkManager)) {
    # Pinned together from https://developer.android.com/studio, 2026-10-11.
    $taskSdkArchive = 'commandlinetools-win-15859902_latest.zip'
    $taskSdkHash = '90ae805d20434428bffcb699c290860f19bb5f66a67e6b330067e3de801fb04a'
    $archive = Join-Path $taskDownloads $taskSdkArchive
    if (-not (Test-Path -LiteralPath $archive)) { Get-OfficialFile "https://dl.google.com/android/repository/$taskSdkArchive" $archive }
    if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $taskSdkHash) { throw 'Android command-line tools checksum mismatch.' }
    $taskExtract = Join-Path $taskTools 'sdk-extract'
    Expand-Archive -LiteralPath $archive -DestinationPath $taskExtract -Force
    New-Item -ItemType Directory -Path (Join-Path $taskSdk 'cmdline-tools\latest') -Force | Out-Null
    Copy-Item -Path (Join-Path $taskExtract 'cmdline-tools\*') -Destination (Join-Path $taskSdk 'cmdline-tools\latest') -Recurse -Force
}
$env:ANDROID_HOME = $taskSdk
$env:ANDROID_SDK_ROOT = $taskSdk
@('y') * 100 | & $taskSdkManager "--sdk_root=$taskSdk" 'platform-tools' 'platforms;android-35' 'build-tools;35.0.0'
if ($LASTEXITCODE -ne 0) { throw 'SDK component installation failed.' }

$taskGradle = Join-Path $taskTools 'gradle\gradle-8.13\bin\gradle.bat'
if (-not (Test-Path -LiteralPath $taskGradle)) {
    $archive = Get-VerifiedArchive 'https://services.gradle.org/distributions/gradle-8.13-bin.zip' 'gradle-8.13-bin.zip' 'https://services.gradle.org/distributions/gradle-8.13-bin.zip.sha256'
    Expand-Archive -LiteralPath $archive -DestinationPath (Join-Path $taskTools 'gradle') -Force
}
Write-Output "JAVA_HOME=$env:JAVA_HOME"
Write-Output "ANDROID_HOME=$taskSdk"
Write-Output "Gradle=$taskGradle"
