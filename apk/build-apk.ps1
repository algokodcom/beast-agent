# Beast Mobile APK build (ASCII only)
#   powershell -ExecutionPolicy Bypass -File .\build-apk.ps1

$ErrorActionPreference = 'Stop'
$Sdk = "$env:LOCALAPPDATA\Android\Sdk"
$Zip = "$env:TEMP\opencode\cmdtools.zip"
$Proj = $PSScriptRoot

# ---------- 0) ZIP check ----------
if (-not (Test-Path $Zip)) {
  Write-Output 'cmdline-tools zip missing - downloading...'
  New-Item -ItemType Directory -Force -Path (Split-Path $Zip) | Out-Null
  curl.exe -L -C - --retry 8 --retry-delay 3 -o $Zip 'https://dl.google.com/android/repository/commandlinetools-win-11076708_latest.zip'
  if (-not (Test-Path $Zip)) { throw 'download failed' }
}
Write-Output ("zip available: {0:N0} bytes" -f (Get-Item $Zip).Length)

# ---------- 1) unzip into SDK layout ----------
$CliDir = "$Sdk\cmdline-tools\latest"
if (-not (Test-Path "$CliDir\bin\sdkmanager.bat")) {
  Write-Output 'installing sdkmanager...'
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  if (Test-Path "$Sdk\cmdline-tools\_unzip") { Remove-Item "$Sdk\cmdline-tools\_unzip" -Recurse -Force }
  [System.IO.Compression.ZipFile]::ExtractToDirectory($Zip, "$Sdk\cmdline-tools\_unzip")
  $inner = Get-ChildItem "$Sdk\cmdline-tools\_unzip" -Directory | Select-Object -First 1
  New-Item -ItemType Directory -Force -Path $CliDir | Out-Null
  Move-Item "$($inner.FullName)\*" $CliDir -Force
  Remove-Item "$Sdk\cmdline-tools\_unzip" -Recurse -Force
}
$env:ANDROID_HOME = $Sdk
$env:ANDROID_SDK_ROOT = $Sdk

# ---------- 2) JDK 21 preferred (Capacitor 8 needs source release 21) ----------
$JavaHome = "$env:LOCALAPPDATA\Android\jdk21-temurin"
if (-not (Test-Path "$JavaHome\bin\javac.exe")) {
  $Javac = Get-Command javac -ErrorAction SilentlyContinue
  if (-not $Javac) { throw 'javac missing - JDK 21 required' }
  $JavaHome = Split-Path (Split-Path $Javac.Source)
}
$env:JAVA_HOME = $JavaHome
Write-Output ("JAVA_HOME set: " + $JavaHome)

# ---------- 3) licenses (files first - bulletproof, no stdin games) + packages ----------
$Sdm = "$CliDir\bin\sdkmanager.bat"
$Lic = "$Sdk\licenses"
New-Item -ItemType Directory -Force -Path $Lic | Out-Null
Set-Content -Path "$Lic\android-sdk-license" -Value '8933bad161af4178b1185d1e378f759d','d56f5187479451eabf01fb78af6dfcb131a6481b','24333f8a63b6825ea9c5514f83c2829b004d1fee' -Encoding ASCII
Set-Content -Path "$Lic\android-sdk-preview-license" -Value '84831b9409646a918e30568bab4c99431d067f62' -Encoding ASCII

# sdkmanager stderr uyarilari PowerShell'i dusurmesin diye ErrorActionPreference gecici kapatilir
$Need = (-not (Test-Path "$Sdk\build-tools\36.0.0\aapt2.exe")) -or
        (-not (Test-Path "$Sdk\platforms\android-36")) -or
        (-not (Test-Path "$Sdk\platform-tools"))
if ($Need) {
  Write-Output 'installing platform-tools / android-36 / build-tools (a few minutes)...'
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  (1..40 | ForEach-Object { 'y' }) | & $Sdm 'platform-tools' 'platforms;android-36' 'build-tools;36.0.0' 2>&1 | Select-Object -Last 3
  $ErrorActionPreference = $prev
} else {
  Write-Output 'SDK packages already installed - skipping sdkmanager'
}
if (-not (Test-Path "$Sdk\build-tools\36.0.0\aapt2.exe")) { throw 'SDK packages missing after install (check output above)' }

# ---------- 4) local.properties (forward slashes are fine for properties) ----------
$SdkFwd = $Sdk -replace '\\', '/'
Set-Content -Path "$Proj\android\local.properties" -Value ("sdk.dir=" + $SdkFwd) -Encoding ASCII

# ---------- 5) web assets -> android (www klasoru) ----------
Write-Output 'copying www -> android assets...'
Push-Location $Proj
& npx cap copy android 2>&1 | Select-Object -Last 4
Pop-Location

# ---------- 6) gradle build ----------
$env:JAVA_HOME = $JavaHome
Write-Output 'gradle assembleDebug (first build ~10 min, deps download)...'
Push-Location "$Proj\android"
$prev = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
& .\gradlew.bat assembleDebug --no-daemon 2>&1 | Select-Object -Last 14
$gradleCode = $LASTEXITCODE
$ErrorActionPreference = $prev
Pop-Location

$Apk = "$Proj\android\app\build\outputs\apk\debug\app-debug.apk"
if ($gradleCode -ne 0) { Write-Output ("gradle exited with code " + $gradleCode) }
if (Test-Path $Apk) {
  Write-Output ("APK READY: " + $Apk)
  Write-Output ("  size KB: {0:N0}" -f ((Get-Item $Apk).Length / 1KB))
  Write-Output ("  time: " + (Get-Item $Apk).LastWriteTime)
} else {
  Write-Output 'APK BUILD FAILED - see gradle output above'
  exit 1
}
