param(
  [string]$Bundles = 'nsis'
)

$ErrorActionPreference = 'Stop'
$Root = 'D:\something\md-reader'
$VsDev = 'C:\BuildTools\Common7\Tools\VsDevCmd.bat'
if (-not (Test-Path $VsDev)) { throw "VsDevCmd not found: $VsDev" }

$lines = & cmd /c "`"$VsDev`" -arch=x64 >nul && set"
foreach ($line in $lines) {
  $i = $line.IndexOf('=')
  if ($i -gt 0) { Set-Item -Path ("Env:" + $line.Substring(0, $i)) -Value $line.Substring($i + 1) }
}
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"
$env:CARGO_TARGET_DIR = 'C:\Users\xm130812\md-reader-target-shell'

Push-Location (Join-Path $Root 'packages\shell\src-tauri')
try {
  & cargo tauri build --bundles $Bundles
  if ($LASTEXITCODE -ne 0) { throw "tauri build failed: $LASTEXITCODE" }
  Get-ChildItem (Join-Path $env:CARGO_TARGET_DIR 'release\bundle') -Recurse -File |
    Select-Object FullName, Length
} finally { Pop-Location }
