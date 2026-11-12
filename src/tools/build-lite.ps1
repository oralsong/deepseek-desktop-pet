param(
  [string]$SourceZip = "",
  [switch]$BuildInstaller
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
if (-not $SourceZip) { $SourceZip = Join-Path $root "gsd-pet-1.0.zip" }
if (-not (Test-Path -LiteralPath $SourceZip)) { throw "Source zip not found: $SourceZip" }

$build = Join-Path $root ".build"
$stage = Join-Path $build "gsd-pet-lite"
$dist = Join-Path $root "dist"
$rootFull = [System.IO.Path]::GetFullPath($root)
$stageFull = [System.IO.Path]::GetFullPath($stage)
if (-not $stageFull.StartsWith($rootFull, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to clean a staging path outside the workspace."
}
if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
New-Item -ItemType Directory -Force -Path $stage, $dist | Out-Null

function Invoke-ArchiveExtract([string[]]$Patterns, [string[]]$Excludes = @()) {
  $args = @("-xf", $SourceZip)
  foreach ($pattern in $Excludes) { $args += @("--exclude", $pattern) }
  $args += $Patterns
  & tar.exe @args
  if ($LASTEXITCODE -ne 0) { throw "tar failed with exit code $LASTEXITCODE" }
}

Push-Location $stage
try {
  Invoke-ArchiveExtract @(
    "app/dsh-pet",
    "runtime/electron",
    "runtime/node.exe",
    "pet.ico"
  ) @("app/dsh-pet/node_modules/*", "app/dsh-pet/node_modules/node_modules/*")

} finally {
  Pop-Location
}

# Apply this repository's patches to the pristine standalone package.
$patchRunner = Join-Path $root "src\patch\apply-release-patches.mjs"
& node $patchRunner --pkg (Join-Path $stage "app\dsh-pet")
if ($LASTEXITCODE -ne 0) { throw "Failed to apply dsh-pet patches." }

New-Item -ItemType Directory -Force -Path (Join-Path $stage "launcher") | Out-Null
Copy-Item -LiteralPath (Join-Path $root "src\launcher\DesktopPetLauncher.cs") -Destination (Join-Path $stage "launcher\DesktopPetLauncher.cs") -Force
Copy-Item -LiteralPath (Join-Path $root "src\install\install.ps1") -Destination (Join-Path $stage "install.ps1") -Force
Copy-Item -LiteralPath (Join-Path $root "src\install\uninstall.ps1") -Destination (Join-Path $stage "uninstall.ps1") -Force
Copy-Item -LiteralPath (Join-Path $root "src\install\setup.cmd") -Destination (Join-Path $stage "setup.cmd") -Force
Copy-Item -LiteralPath (Join-Path $root "src\install\uninstall.cmd") -Destination (Join-Path $stage "uninstall.cmd") -Force
Copy-Item -LiteralPath (Join-Path $root "Readme.md") -Destination (Join-Path $stage "Readme.md") -Force

$csc = Join-Path $env:WINDIR "Microsoft.NET\Framework\v4.0.30319\csc.exe"
if (-not (Test-Path -LiteralPath $csc)) { throw "C# compiler not found: $csc" }
$exe = Join-Path $stage "gsd大肥鱼桌宠.exe"
& $csc /nologo /target:winexe /optimize+ /out:$exe `
  /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.Web.Extensions.dll `
  /r:System.Management.dll /r:System.Net.Http.dll `
  (Join-Path $root "src\launcher\DesktopPetLauncher.cs")
if ($LASTEXITCODE -ne 0) { throw "Failed to compile launcher." }

Remove-Item -LiteralPath (Join-Path $stage "app\dsh-pet\node_modules") -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath (Join-Path $stage "runtime\python\Lib\site-packages") -Recurse -Force -ErrorAction SilentlyContinue
Get-ChildItem -LiteralPath $stage -Recurse -File -ErrorAction SilentlyContinue |
  Where-Object { $_.Extension -in @(".orig", ".log", ".pyc") } |
  ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue }

$zipOut = Join-Path $dist "gsd-pet-lite-1.1.zip"
if (Test-Path -LiteralPath $zipOut) { Remove-Item -LiteralPath $zipOut -Force }
Compress-Archive -LiteralPath $stage -DestinationPath $zipOut -CompressionLevel Optimal
Write-Host "Built: $zipOut"
Write-Host ("Size: {0:N1} MB" -f ((Get-Item -LiteralPath $zipOut).Length / 1MB))

if ($BuildInstaller) {
  & (Join-Path $root "src\tools\build-installer.ps1") -PayloadZip $zipOut
}
