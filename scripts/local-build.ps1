param(
  [ValidateSet('core', 'shell', 'all')]
  [string]$Target = 'all'
)

$ErrorActionPreference = 'Stop'
$Root = 'D:\something\md-reader'
$VsDev = 'C:\BuildTools\Common7\Tools\VsDevCmd.bat'
if (-not (Test-Path $VsDev)) { throw "VsDevCmd not found: $VsDev" }

# 把 VsDevCmd 的 MSVC/SDK 环境导入当前 PowerShell
$lines = & cmd /c "`"$VsDev`" -arch=x64 >nul && set"
foreach ($line in $lines) {
  $i = $line.IndexOf('=')
  if ($i -gt 0) {
    $name = $line.Substring(0, $i)
    $value = $line.Substring($i + 1)
    Set-Item -Path "Env:$name" -Value $value
  }
}
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"

function Build-Core {
  $env:CARGO_TARGET_DIR = 'C:\Users\xm130812\md-reader-target-core'
  Push-Location $Root
  try {
    & cargo build --release -p reader-cli --manifest-path packages/core/Cargo.toml
    if ($LASTEXITCODE -ne 0) { throw "core build failed: $LASTEXITCODE" }
    $core = Join-Path $env:CARGO_TARGET_DIR 'release\md-reader-core.exe'
    $side = Join-Path $Root 'packages\shell\src-tauri\binaries\md-reader-core-x86_64-pc-windows-msvc.exe'
    New-Item -ItemType Directory -Force (Split-Path $side) | Out-Null
    Copy-Item $core $side -Force
    Write-Host "core: $((Get-Item $core).Length) bytes"
  } finally { Pop-Location }
}

function Build-Shell {
  $env:CARGO_TARGET_DIR = 'C:\Users\xm130812\md-reader-target-shell'
  Push-Location $Root
  try {
    & cargo build --release --manifest-path packages/shell/src-tauri/Cargo.toml
    if ($LASTEXITCODE -ne 0) { throw "shell build failed: $LASTEXITCODE" }
    $out = Join-Path $Root 'release\debug\bundle'
    New-Item -ItemType Directory -Force (Join-Path $out 'web') | Out-Null
    Copy-Item (Join-Path $env:CARGO_TARGET_DIR 'release\md-reader-shell.exe') $out -Force
    Copy-Item (Join-Path $Root 'packages\shell\src-tauri\binaries\md-reader-core-x86_64-pc-windows-msvc.exe') (Join-Path $out 'md-reader-core.exe') -Force
    Copy-Item (Join-Path $Root 'packages\web\dist\*') (Join-Path $out 'web') -Recurse -Force
    Get-ChildItem $out | Select-Object Name, Length
  } finally { Pop-Location }
}

if ($Target -eq 'core' -or $Target -eq 'all') { Build-Core }
if ($Target -eq 'shell' -or $Target -eq 'all') { Build-Shell }
