# One-time setup of a portable Android build toolchain (no admin).
# Installs: Temurin JDK 17 -> <tools>\jdk17, Android cmdline-tools +
# platform 34 + build-tools 34 -> <tools>\android-sdk.
#
# Tools dir: $env:RYZA_ANDROID_TOOLS, else gitignored
# config/android-tools.local.txt, else <repo>/.android-tools
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$localTools = Join-Path $Root "config/android-tools.local.txt"
if ($env:RYZA_ANDROID_TOOLS) { $Tools = $env:RYZA_ANDROID_TOOLS }
elseif (Test-Path $localTools) { $Tools = (Get-Content $localTools -Raw).Trim() }
else { $Tools = Join-Path $Root ".android-tools" }
New-Item -ItemType Directory -Force $Tools | Out-Null

function Get-Zip($urls, $dest) {
  foreach ($u in $urls) {
    try {
      "trying $u"
      Invoke-WebRequest -Uri $u -OutFile $dest -UseBasicParsing -TimeoutSec 600
      if ((Get-Item $dest).Length -gt 10MB) { return }
    } catch { "  failed: $($_.Exception.Message)" }
  }
  throw "all sources failed for $dest"
}

# ---- JDK 17 ----------------------------------------------------------------
$jdk = Join-Path $Tools "jdk17"
if (-not (Test-Path (Join-Path $jdk "bin\javac.exe"))) {
  $jdkUrls = @(
    "https://mirrors.tuna.tsinghua.edu.cn/Adoptium/17/jdk/x64/windows/",
    "https://mirrors.huaweicloud.com/java/jdk/17.0.2+8/"
  )
  $zip = Join-Path $Tools "jdk17.zip"
  $done = $false
  foreach ($idx in $jdkUrls) {
    if ($done) { break }
    try {
      $r = Invoke-WebRequest -Uri $idx -UseBasicParsing -TimeoutSec 30
      $file = ($r.Links | ForEach-Object { $_.href } |
               Where-Object { $_ -match 'jdk[^"/]*\.zip$' -or $_ -match '\.zip$' } |
               Select-Object -First 1)
      if ($file) {
        "found $file at $idx"
        Get-Zip @(($idx.TrimEnd('/') + '/' + $file)) $zip
        $done = $true
      }
    } catch { "  index failed: $($_.Exception.Message)" }
  }
  if (-not $done) {
    Get-Zip @("https://api.adoptium.net/v3/binary/latest/17/ga/windows/x64/jdk/hotspot/normal/eclipse") $zip
  }
  Expand-Archive $zip -DestinationPath $Tools -Force
  $inner = Get-ChildItem $Tools -Directory | Where-Object { $_.Name -match '^(jdk|OpenJDK)' -and $_.FullName -ne $jdk } | Select-Object -First 1
  if ($inner) { Move-Item $inner.FullName $jdk -Force }
  Remove-Item $zip -ErrorAction SilentlyContinue
}
& (Join-Path $jdk "bin\java.exe") -version

# ---- Android cmdline-tools -------------------------------------------------
$sdk = Join-Path $Tools "android-sdk"
New-Item -ItemType Directory -Force $sdk | Out-Null
$cmdline = Join-Path $sdk "cmdline-tools\latest"
if (-not (Test-Path (Join-Path $cmdline "bin\sdkmanager.bat"))) {
  $zip = Join-Path $Tools "cmdline-tools.zip"
  Get-Zip @(
    "https://dl.google.com/android/repository/commandlinetools-win-11076708_latest.zip",
    "https://mirrors.cloud.tencent.com/AndroidSDK/commandlinetools-win-11076708_latest.zip"
  ) $zip
  $tmp = Join-Path $Tools "cmdline-tmp"
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  Expand-Archive $zip -DestinationPath $tmp -Force
  New-Item -ItemType Directory -Force (Split-Path $cmdline) | Out-Null
  Move-Item (Join-Path $tmp "cmdline-tools") $cmdline -Force
  Remove-Item -Recurse -Force $tmp, $zip -ErrorAction SilentlyContinue
}

# ---- SDK packages -----------------------------------------------------------
$env:JAVA_HOME = $jdk
$env:Path = "$jdk\bin;$env:Path"
$sm = Join-Path $cmdline "bin\sdkmanager.bat"
"yes" * 200 | & $sm --sdk_root=$sdk --licenses 2>&1 | Select-Object -Last 1
& $sm --sdk_root=$sdk "platform-tools" "platforms;android-34" "build-tools;34.0.0" 2>&1 | Select-Object -Last 4
"toolchain ready: $(Test-Path (Join-Path $sdk 'build-tools\34.0.0\aapt2.exe'))"
