param(
  [string]$InputFile = "",
  [int64]$PartSize = 1800000000
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
if (-not $InputFile) { $InputFile = Join-Path $root "dist\gsd-pet-voice-pack-1.1.zip" }
if (-not (Test-Path -LiteralPath $InputFile)) { throw "Input file not found: $InputFile" }
if ($PartSize -le 0 -or $PartSize -ge 2147483648) { throw "PartSize must be between 1 byte and 2 GiB." }

$outDir = Join-Path $root "dist\voice-pack-parts"
$rootFull = [System.IO.Path]::GetFullPath($root)
$outFull = [System.IO.Path]::GetFullPath($outDir)
if (-not $outFull.StartsWith($rootFull, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to write outside the workspace."
}
if (Test-Path -LiteralPath $outDir) { Remove-Item -LiteralPath $outDir -Recurse -Force }
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$source = [System.IO.File]::OpenRead($InputFile)
try {
  $buffer = New-Object byte[] (8MB)
  $part = 1
  while ($source.Position -lt $source.Length) {
    $partPath = Join-Path $outDir ("gsd-pet-voice-pack-1.1.zip.part{0:D2}" -f $part)
    $target = [System.IO.File]::Create($partPath)
    try {
      [int64]$remaining = [Math]::Min($PartSize, $source.Length - $source.Position)
      while ($remaining -gt 0) {
        $want = [int][Math]::Min($buffer.Length, $remaining)
        $read = $source.Read($buffer, 0, $want)
        if ($read -le 0) { throw "Unexpected end of input while creating part $part." }
        $target.Write($buffer, 0, $read)
        $remaining -= $read
      }
    } finally {
      $target.Dispose()
    }
    $part++
  }
} finally {
  $source.Dispose()
}

Copy-Item -LiteralPath (Join-Path $root "src\install\install-voice-pack-from-parts.ps1") -Destination $outDir -Force
$rows = Get-ChildItem -LiteralPath $outDir -File | Sort-Object Name | ForEach-Object {
  [pscustomobject]@{
    File = $_.Name
    Bytes = $_.Length
    SHA256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
  }
}
$rows | ForEach-Object { "{0}  {1}" -f $_.SHA256, $_.File } |
  Set-Content -LiteralPath (Join-Path $outDir "SHA256SUMS.txt") -Encoding ASCII
$rows | Select-Object File, Bytes, SHA256 | Format-Table -AutoSize
Write-Host "Created split parts in: $outDir"
