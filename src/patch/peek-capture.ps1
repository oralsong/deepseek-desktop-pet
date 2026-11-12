# dsh-pet peek screen capture helper (called by lib/peek.js)
#
# One process = one screen copy, optionally two outputs from that same instant:
#   * small BMP   (uncompressed pixels, used for frame diffing in JS)
#   * model frame (JPEG/PNG at -MaxWidth, the frame actually handed to the model)
#
# Usage:
#   powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File peek-capture.ps1 ^
#     -Out <model frame path> [-Small <small bmp path>] -Meta <result json path> ^
#     [-Format jpg|png|bmp|none] [-Width 96 -Height 54] [-MaxWidth 1280] [-Quality 85] [-NoDpi]
#
# -Format none : only write the small BMP (cheapest tick, no model frame at all)
# -Format jpg  : JPEG at -Quality (default; ~10x smaller than PNG for screen content)
# Result goes to the -Meta JSON file: {ok,width,height,file,small,w,h,ms:{dpi,copy,small,shot,total}}
# The caller never relies on stdout pipes.
#
# NOTE: keep this file pure ASCII on purpose. Windows PowerShell 5.1 decodes a BOM-less
# script as the ANSI code page, and multibyte text there can swallow the following
# newline and break parsing.
param(
  [Parameter(Mandatory = $true)][string]$Out,
  [string]$Small = '',
  [string]$Meta = '',
  [ValidateSet('bmp', 'png', 'jpg', 'none')][string]$Format = 'jpg',
  [int]$Width = 96,
  [int]$Height = 54,
  [int]$MaxWidth = 1280,
  [int]$Quality = 85,
  [switch]$NoDpi
)

$ErrorActionPreference = 'Stop'
$total = [System.Diagnostics.Stopwatch]::StartNew()
$t = [ordered]@{ dpi = 0; copy = 0; small = 0; shot = 0; total = 0 }

function Write-Meta($obj) {
  $obj.ms = $t
  if ($Meta) {
    try { ($obj | ConvertTo-Json -Compress) | Out-File -LiteralPath $Meta -Encoding ascii -Force } catch { }
  }
  if ($obj.ok) { exit 0 } else { exit 1 }
}

try {
  Add-Type -AssemblyName System.Drawing
  Add-Type -AssemblyName System.Windows.Forms

  # Per-monitor DPI awareness: a non-DPI-aware process gets a scaled virtual desktop
  # (blurry/undersized grab on HiDPI). Add-Type compiles C# with csc at runtime, which
  # costs a few hundred ms per process, hence -NoDpi for the cheap tick path.
  if (-not $NoDpi) {
    try {
      if (-not ('DshPeekDpi' -as [type])) {
        Add-Type -Namespace '' -Name DshPeekDpi -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool SetProcessDPIAware();
'@
      }
      try { [DshPeekDpi]::SetProcessDPIAware() | Out-Null } catch { }
    } catch { }
  }
  $t.dpi = [int]$total.ElapsedMilliseconds

  $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $full = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
  $g = [System.Drawing.Graphics]::FromImage($full)
  try { $g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size) }
  finally { $g.Dispose() }
  $t.copy = [int]$total.ElapsedMilliseconds

  $wantSmall = [bool]$Small
  $wantShot = $Format -ne 'none'
  if (-not $wantSmall -and -not $wantShot) { throw 'nothing to do: pass -Small and/or -Format jpg|png|bmp' }

  # NOTE: never name a local like a parameter ($small vs -Small, $width vs -Width ...):
  # PowerShell variable names are case-insensitive, so the parameter would be clobbered.
  try {
    if ($wantSmall) {
      $miniW = if ($Width -gt 0) { $Width } else { 96 }
      $miniH = if ($Height -gt 0) { $Height } else { 54 }
      $miniBmp = New-Object System.Drawing.Bitmap $miniW, $miniH
      $miniG = [System.Drawing.Graphics]::FromImage($miniBmp)
      try {
        $miniG.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $miniG.DrawImage($full, (New-Object System.Drawing.Rectangle 0, 0, $miniW, $miniH))
      }
      finally { $miniG.Dispose() }
      $miniBmp.Save($Small, [System.Drawing.Imaging.ImageFormat]::Bmp)
      $miniBmp.Dispose()
      $t.small = [int]$total.ElapsedMilliseconds
    }

    if ($wantShot) {
      $frameW = $MaxWidth
      if ($frameW -le 0 -or $frameW -gt $full.Width) { $frameW = $full.Width }
      $frameH = [int][Math]::Round($full.Height * $frameW / $full.Width)
      $frame = $full
      if ($frameW -ne $full.Width) {
        $frameScaled = New-Object System.Drawing.Bitmap $frameW, $frameH
        $frameG = [System.Drawing.Graphics]::FromImage($frameScaled)
        try {
          $frameG.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
          $frameG.DrawImage($full, (New-Object System.Drawing.Rectangle 0, 0, $frameW, $frameH))
        }
        finally { $frameG.Dispose() }
        $frame = $frameScaled
      }
      try {
        if ($Format -eq 'jpg') {
          $jpgCodec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' } | Select-Object -First 1
          if (-not $jpgCodec) { throw 'no jpeg encoder available' }
          $encParams = New-Object System.Drawing.Imaging.EncoderParameters 1
          $encParams.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), ([long]$Quality)
          $frame.Save($Out, $jpgCodec, $encParams)
          $encParams.Dispose()
        }
        elseif ($Format -eq 'png') { $frame.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png) }
        else { $frame.Save($Out, [System.Drawing.Imaging.ImageFormat]::Bmp) }
      }
      finally { if (-not [object]::ReferenceEquals($frame, $full)) { $frame.Dispose() } }
      $t.shot = [int]$total.ElapsedMilliseconds
    }
  }
  finally { $full.Dispose() }

  $t.total = [int]$total.ElapsedMilliseconds
  $frameW = if ($wantShot) { if ($MaxWidth -le 0 -or $MaxWidth -gt $bounds.Width) { $bounds.Width } else { $MaxWidth } } else { 0 }
  Write-Meta @{ ok = $true; width = $bounds.Width; height = $bounds.Height; file = $Out; small = $Small; w = $frameW }
}
catch {
  $t.total = [int]$total.ElapsedMilliseconds
  Write-Meta @{ ok = $false; error = $_.Exception.Message; width = 0; height = 0 }
}
