param(
  [string]$PayloadZip = ""
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
if (-not $PayloadZip) { $PayloadZip = Join-Path $root "dist\gsd-pet-lite-1.1.zip" }
if (-not (Test-Path -LiteralPath $PayloadZip)) { throw "Payload zip not found: $PayloadZip" }

$stage = Join-Path $root ".build\installer"
$dist = Join-Path $root "dist"
$rootFull = [System.IO.Path]::GetFullPath($root)
$stageFull = [System.IO.Path]::GetFullPath($stage)
if (-not $stageFull.StartsWith($rootFull, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to clean an installer path outside the workspace."
}
if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
New-Item -ItemType Directory -Force -Path $stage, $dist | Out-Null

$target = Join-Path $dist "gsd-pet-lite-1.1-setup.exe"
if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Force }
$bootstrap = Join-Path $stage "bootstrap.exe"
$csc = Join-Path $env:WINDIR "Microsoft.NET\Framework\v4.0.30319\csc.exe"
if (-not (Test-Path -LiteralPath $csc)) { throw "C# compiler not found: $csc" }
& $csc /nologo /target:winexe /optimize+ /out:$bootstrap `
  /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.Management.dll `
  /r:System.IO.Compression.dll /r:System.IO.Compression.FileSystem.dll `
  (Join-Path $root "src\install\SetupBootstrap.cs")
if ($LASTEXITCODE -ne 0) { throw "Failed to compile setup bootstrap." }

$magic = [System.Text.Encoding]::ASCII.GetBytes("GSD-PET-PAYLOAD-V1")
$length = [System.BitConverter]::GetBytes([int64](Get-Item -LiteralPath $PayloadZip).Length)
$output = [System.IO.File]::Create($target)
try {
  $bootstrapStream = [System.IO.File]::OpenRead($bootstrap)
  try { $bootstrapStream.CopyTo($output) } finally { $bootstrapStream.Dispose() }
  $payloadStream = [System.IO.File]::OpenRead($PayloadZip)
  try { $payloadStream.CopyTo($output) } finally { $payloadStream.Dispose() }
  $output.Write($length, 0, $length.Length)
  $output.Write($magic, 0, $magic.Length)
} finally {
  $output.Dispose()
}
Write-Host "Built: $target"
Write-Host ("Size: {0:N1} MB" -f ((Get-Item -LiteralPath $target).Length / 1MB))
