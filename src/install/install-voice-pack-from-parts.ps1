$ErrorActionPreference = "Stop"
$source = Split-Path -Parent $MyInvocation.MyCommand.Path
$part1 = Join-Path $source "gsd-pet-voice-pack-1.1.zip.part01"
$part2 = Join-Path $source "gsd-pet-voice-pack-1.1.zip.part02"
$expectedZipHash = "257998D8B25FC86984BB8D13FCB6123E2926A920171AEB8111DE73F53EAD3A55"
$tempRoot = Join-Path $env:TEMP ("gsd-pet-voice-" + [Guid]::NewGuid().ToString("N"))
$joined = Join-Path $tempRoot "gsd-pet-voice-pack-1.1.zip"
$extract = Join-Path $tempRoot "extract"

if (-not (Test-Path -LiteralPath $part1) -or -not (Test-Path -LiteralPath $part2)) {
  throw "Place part01 and part02 next to this script, then run it again."
}

try {
  New-Item -ItemType Directory -Force -Path $tempRoot, $extract | Out-Null
  $output = [System.IO.File]::Create($joined)
  try {
    foreach ($part in @($part1, $part2)) {
      $input = [System.IO.File]::OpenRead($part)
      try { $input.CopyTo($output) } finally { $input.Dispose() }
    }
  } finally {
    $output.Dispose()
  }

  $actual = (Get-FileHash -LiteralPath $joined -Algorithm SHA256).Hash
  if ($actual -ne $expectedZipHash) {
    throw "Voice pack hash mismatch. Re-download the two parts and try again."
  }

  Expand-Archive -LiteralPath $joined -DestinationPath $extract -Force
  $installer = Join-Path $extract "voice-pack\install-voice-pack.ps1"
  if (-not (Test-Path -LiteralPath $installer)) {
    throw "The voice pack installer was not found after extraction."
  }
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer
  if ($LASTEXITCODE -ne 0) { throw "Voice pack installation failed." }
  Write-Host "Voice pack installed. Start the desktop pet launcher again."
} finally {
  Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
