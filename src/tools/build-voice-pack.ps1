param(
  [string]$SourceZip = ""
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
if (-not $SourceZip) { $SourceZip = Join-Path $root "gsd-pet-1.0.zip" }
if (-not (Test-Path -LiteralPath $SourceZip)) { throw "Source zip not found: $SourceZip" }
$stage = Join-Path $root ".build\voice-pack"
$dist = Join-Path $root "dist"
$rootFull = [System.IO.Path]::GetFullPath($root)
$stageFull = [System.IO.Path]::GetFullPath($stage)
if (-not $stageFull.StartsWith($rootFull, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to clean a staging path outside the workspace."
}
if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
New-Item -ItemType Directory -Force -Path $stage, $dist | Out-Null

Push-Location $stage
try {
  & tar.exe -xf $SourceZip --exclude "app/pet-voice/logs/*" --exclude "app/pet-voice/state/*" --exclude "app/pet-voice/repos/OpenVoice/.git/*" runtime/python app/pet-voice
  if ($LASTEXITCODE -ne 0) { throw "tar failed with exit code $LASTEXITCODE" }
} finally {
  Pop-Location
}

Copy-Item -LiteralPath (Join-Path $root "src\voice\server.py") -Destination (Join-Path $stage "app\pet-voice\server.py") -Force
Copy-Item -LiteralPath (Join-Path $root "src\voice\ear.py") -Destination (Join-Path $stage "app\pet-voice\ear.py") -Force
Copy-Item -LiteralPath (Join-Path $root "src\install\install-voice-pack.ps1") -Destination (Join-Path $stage "install-voice-pack.ps1") -Force

$zipOut = Join-Path $dist "gsd-pet-voice-pack-1.1.zip"
if (Test-Path -LiteralPath $zipOut) { Remove-Item -LiteralPath $zipOut -Force }
Compress-Archive -LiteralPath $stage -DestinationPath $zipOut -CompressionLevel Optimal
Write-Host "Built: $zipOut"
Write-Host ("Size: {0:N1} MB" -f ((Get-Item -LiteralPath $zipOut).Length / 1MB))
