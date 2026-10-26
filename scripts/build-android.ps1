[CmdletBinding()]
param([switch]$SkipChecks)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskTools = Join-Path $taskRoot 'artifacts\tools'
$taskJava = Get-ChildItem -LiteralPath (Join-Path $taskTools 'jdk') -Filter java.exe -Recurse | Select-Object -First 1
if (-not $taskJava) { throw 'Run scripts/setup-android.ps1 -AcceptSdkLicense first.' }
$env:JAVA_HOME = Split-Path -Parent (Split-Path -Parent $taskJava.FullName)
$env:ANDROID_HOME = Join-Path $taskTools 'android-sdk'
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
$env:GRADLE_USER_HOME = Join-Path $taskTools 'gradle-home'
$env:PATH = "$env:JAVA_HOME\bin;$env:PATH"
$taskGradle = Join-Path $taskTools 'gradle\gradle-8.13\bin\gradle.bat'
if (-not (Test-Path -LiteralPath $taskGradle)) { throw 'Gradle missing; run setup-android.ps1 first.' }
$taskProject = Join-Path $taskRoot 'android\portal'
$taskKeystore = Join-Path $taskTools 'debug.keystore'
if (-not (Test-Path -LiteralPath $taskKeystore)) {
    & "$env:JAVA_HOME\bin\keytool.exe" -genkeypair -keystore $taskKeystore -storepass android -keypass android -alias androiddebugkey -dname 'CN=Android Debug,O=Android,C=US' -keyalg RSA -keysize 2048 -validity 10000
    if ($LASTEXITCODE -ne 0) { throw 'Local debug keystore generation failed.' }
}
[string[]]$taskChecks = if ($SkipChecks) { @('assembleDebug') } else { @('assembleDebug', 'testDebugUnitTest', 'lintDebug') }
if (-not (Test-Path -LiteralPath (Join-Path $taskProject 'gradle\wrapper\gradle-wrapper.jar'))) {
    $taskDistributionHash = (Get-Content -LiteralPath (Join-Path $taskTools 'downloads\gradle-8.13-bin.zip.sha256') -Raw).Trim()
    & $taskGradle --no-daemon --console=plain -p $taskProject wrapper --gradle-version 8.13 --distribution-type bin --gradle-distribution-sha256-sum $taskDistributionHash --no-validate-url
    if ($LASTEXITCODE -ne 0) { throw 'Gradle wrapper generation failed.' }
}
& $taskGradle --no-daemon --console=plain -p $taskProject @taskChecks
if ($LASTEXITCODE -ne 0) { throw 'Android build or checks failed.' }
$taskApkDirectory = Join-Path $taskRoot 'artifacts\apk'
New-Item -ItemType Directory -Path $taskApkDirectory -Force | Out-Null
$taskApk = Join-Path $taskApkDirectory 'autorush-portal-debug.apk'
Copy-Item -LiteralPath (Join-Path $taskProject 'app\build\outputs\apk\debug\app-debug.apk') -Destination $taskApk -Force
& (Join-Path $env:ANDROID_HOME 'build-tools\35.0.0\apksigner.bat') verify --verbose $taskApk
if ($LASTEXITCODE -ne 0) { throw 'APK signature validation failed.' }
$taskPython = Join-Path $taskRoot '.venv-dev\Scripts\python.exe'
if (Test-Path -LiteralPath $taskPython) {
    & $taskPython (Join-Path $PSScriptRoot 'verify-android-apk.py') $taskApk
    if ($LASTEXITCODE -ne 0) { throw 'Scanner runtime class validation failed.' }
}
$taskHash = (Get-FileHash -LiteralPath $taskApk -Algorithm SHA256).Hash.ToLowerInvariant()
Set-Content -LiteralPath "$taskApk.sha256" -Value "$taskHash  autorush-portal-debug.apk" -Encoding utf8
Write-Output "APK=$taskApk"
Write-Output "SHA256=$taskHash"
$taskFixtureApk = Join-Path $taskApkDirectory 'autorush-fixture-debug.apk'
Copy-Item -LiteralPath (Join-Path $taskProject 'fixture\build\outputs\apk\debug\fixture-debug.apk') -Destination $taskFixtureApk -Force
& (Join-Path $env:ANDROID_HOME 'build-tools\35.0.0\apksigner.bat') verify $taskFixtureApk
if ($LASTEXITCODE -ne 0) { throw 'Fixture APK signature validation failed.' }
Write-Output "FixtureAPK=$taskFixtureApk"
