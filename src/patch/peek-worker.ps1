# dsh-pet peek capture worker (long-lived, started once by lib/peek.js)
#
# Why a worker: starting powershell.exe costs ~1.2s per instance. A one-shot capture
# therefore costs ~1.8s wall even though the grab itself is ~0.1s. This worker stays
# alive, loads System.Drawing / DPI awareness / the JPEG codec ONCE, then serves
# capture requests through files, so each grab costs only the actual work (~0.2-0.3s).
#
# Protocol (all files inside -Dir):
#   caller writes  req.json   { "meta": "...", "out": "...", "small": "...", "format": "jpg|png|bmp|none",
#                               "width": 96, "height": 54, "maxWidth": 1280, "quality": 85 }
#   worker claims   req.json -> work.json (atomic move, so two callers never share a request)
#   worker writes   <meta>    { ok, width, height, file, small, w, ms:{copy,small,shot,total} }
#   caller may drop stop       (any file) to make the worker exit
#
# NOTE: keep this file pure ASCII on purpose. Windows PowerShell 5.1 decodes a BOM-less
# script as the ANSI code page, and multibyte text there can swallow the following
# newline and break parsing.
param(
  [Parameter(Mandatory = $true)][string]$Dir,
  [int]$PollMs = 40
)

$ErrorActionPreference = 'Continue'

function Write-Meta2($path, $obj) {
  if (-not $path) { return }
  foreach ($attempt in 1, 2, 3) {
    try {
      ($obj | ConvertTo-Json -Compress) | Out-File -LiteralPath $path -Encoding ascii -Force
      return
    } catch { Start-Sleep -Milliseconds 20 }
  }
}

# ---- one-time setup (this is the part that used to cost ~450ms on every capture) ----
$dpiReady = $false
$jpgCodec = $null
try {
  Add-Type -AssemblyName System.Drawing
  Add-Type -AssemblyName System.Windows.Forms
  try {
    if (-not ('DshPeekDpi' -as [type])) {
      Add-Type -Namespace '' -Name DshPeekDpi -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool SetProcessDPIAware();
'@
    }
    try { [DshPeekDpi]::SetProcessDPIAware() | Out-Null } catch { }
    $dpiReady = $true
  } catch { }
  try {
    $jpgCodec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' } | Select-Object -First 1
  } catch { }
} catch { }

$stopPath = Join-Path $Dir 'stop'
$reqPath = Join-Path $Dir 'req.json'
$workPath = Join-Path $Dir 'work.json'

# --- foreground-window probe (used by "quiet while gaming") -----------------
# P/Invoke kept in its own type so a failure here never breaks capture.
$winReady = $false
$speakSynth = $null
$speakPlayer = $null
try { Add-Type -AssemblyName System.Speech } catch { }
try {
  if (-not ('DshPeekWin' -as [type])) {
    Add-Type -Namespace '' -Name DshPeekWin -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool GetWindowRect(System.IntPtr hWnd, out RECT lpRect);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern int GetClassName(System.IntPtr hWnd, System.Text.StringBuilder lpClassName, int nMaxCount);
[System.Runtime.InteropServices.DllImport("user32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)] public static extern int GetWindowTextW(System.IntPtr hWnd, System.Text.StringBuilder lpString, int nMaxCount);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern System.IntPtr MonitorFromWindow(System.IntPtr hWnd, uint dwFlags);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool GetMonitorInfoW(System.IntPtr hMonitor, ref MONITORINFO lpmi);
[System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
[System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)] public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }
'@
  }
  $winReady = $true
} catch { }

function Get-DshPeekForeground {
  $r = [ordered]@{ fullscreen = $false; title = ''; cls = ''; w = 0; h = 0 }
  if (-not $winReady) { return $r }
  try {
    $hwnd = [DshPeekWin]::GetForegroundWindow()
    if ($hwnd -eq [System.IntPtr]::Zero) { return $r }
    $sb = New-Object System.Text.StringBuilder 512
    [void][DshPeekWin]::GetWindowTextW($hwnd, $sb, 512)
    $r.title = $sb.ToString()
    $sb2 = New-Object System.Text.StringBuilder 256
    [void][DshPeekWin]::GetClassName($hwnd, $sb2, 256)
    $r.cls = $sb2.ToString()
    $rect = New-Object DshPeekWin+RECT
    if (-not [DshPeekWin]::GetWindowRect($hwnd, [ref]$rect)) { return $r }
    $w = $rect.Right - $rect.Left
    $h = $rect.Bottom - $rect.Top
    $r.w = $w
    $r.h = $h
    $mon = [DshPeekWin]::MonitorFromWindow($hwnd, 2)
    $mi = New-Object DshPeekWin+MONITORINFO
    $mi.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($mi)
    [void][DshPeekWin]::GetMonitorInfoW($mon, [ref]$mi)
    $tol = 4
    $covers = ($rect.Left -le ($mi.rcMonitor.Left + $tol)) -and ($rect.Top -le ($mi.rcMonitor.Top + $tol)) -and
              ($rect.Right -ge ($mi.rcMonitor.Right - $tol)) -and ($rect.Bottom -ge ($mi.rcMonitor.Bottom - $tol))
    $skip = @('Progman', 'WorkerW', 'Shell_TrayWnd', 'MultitaskingViewFrame', 'XamlExplorerHostIslandWindow')
    $r.fullscreen = [bool]($covers -and ($skip -notcontains $r.cls) -and ($w -gt 0) -and ($h -gt 0))
  } catch { }
  return $r
}

while ($true) {
  if (Test-Path -LiteralPath $stopPath) { break }
  if (-not (Test-Path -LiteralPath $reqPath)) { Start-Sleep -Milliseconds $PollMs; continue }

  $claimed = $false
  try { Move-Item -LiteralPath $reqPath -Destination $workPath -Force -ErrorAction Stop; $claimed = $true } catch { }
  if (-not $claimed) { Start-Sleep -Milliseconds $PollMs; continue }

  $total = [System.Diagnostics.Stopwatch]::StartNew()
  $t = [ordered]@{ copy = 0; small = 0; shot = 0; total = 0 }
  $metaPath = ''
  try {
    # -Encoding UTF8 matters: lib/peek.js writes the request as BOM-less UTF-8, and
    # Windows PowerShell 5.1 otherwise decodes it as the ANSI code page. Chinese text
    # then turns into mojibake and ConvertFrom-Json can throw, which used to make every
    # "speak" request silently time out (no meta file, worker still alive).
    $reqRaw = (Get-Content -LiteralPath $workPath -Raw -Encoding UTF8)
    if ($reqRaw -and $reqRaw.Length -gt 0 -and $reqRaw[0] -eq [char]0xFEFF) { $reqRaw = $reqRaw.Substring(1) }
    $req = $reqRaw | ConvertFrom-Json
    $metaPath = [string]$req.meta
    $cmd = if ($req.cmd) { [string]$req.cmd } else { '' }
    if ($cmd -eq 'probe') {
      # foreground-window probe: no screen capture at all
      $p = Get-DshPeekForeground
      Write-Meta2 $metaPath ([ordered]@{ ok = $true; cmd = 'probe'; fullscreen = [bool]$p.fullscreen; title = [string]$p.title; cls = [string]$p.cls; w = [int]$p.w; h = [int]$p.h })
      Remove-Item -LiteralPath $workPath -Force -ErrorAction SilentlyContinue
      continue
    }
    if ($cmd -eq 'speak') {
      # text -> wav (System.Speech) -> async playback; never blocks the capture loop
      $text = [string]$req.text
      $voice = [string]$req.voice
      $rate = if ($req.rate) { [int]$req.rate } else { 0 }
      $vol = if ($req.volume) { [int]$req.volume } else { 90 }
      $sw = [System.Diagnostics.Stopwatch]::StartNew()
      $wav = Join-Path $Dir ('tts-' + [guid]::NewGuid().ToString('N') + '.wav')
      $okSpeak = $false
      $speakErr = ''
      $bytes = 0
      try {
        if ($null -eq $speakSynth) { $speakSynth = New-Object System.Speech.Synthesis.SpeechSynthesizer }
        $speakSynth.Rate = [Math]::Max(-10, [Math]::Min(10, $rate))
        $speakSynth.Volume = [Math]::Max(0, [Math]::Min(100, $vol))
        if ($voice) { try { $speakSynth.SelectVoice($voice) } catch { } }
        $speakSynth.SetOutputToWaveFile($wav)
        $speakSynth.Speak($text)
        $speakSynth.SetOutputToNull()
        $okSpeak = $true
      } catch { $speakErr = $_.Exception.Message }
      $synthMs = [int]$sw.ElapsedMilliseconds
      if ($okSpeak) {
        try { $bytes = (Get-Item -LiteralPath $wav).Length } catch { $bytes = 0 }
        if ($bytes -gt 0) {
          try {
            if ($null -eq $speakPlayer) { $speakPlayer = New-Object System.Media.SoundPlayer }
            $speakPlayer.SoundLocation = $wav
            $speakPlayer.Play()
          } catch { $speakErr = $_.Exception.Message; $okSpeak = $false }
        } else {
          $okSpeak = $false
          $speakErr = 'empty wav'
        }
      }
      try {
        Get-ChildItem -LiteralPath $Dir -Filter 'tts-*.wav' -ErrorAction SilentlyContinue |
          Where-Object { $_.LastWriteTime -lt (Get-Date).AddMinutes(-1) } |
          Remove-Item -Force -ErrorAction SilentlyContinue
      } catch { }
      Write-Meta2 $metaPath ([ordered]@{ ok = $okSpeak; cmd = 'speak'; ms = $synthMs; bytes = $bytes; error = $speakErr })
      Remove-Item -LiteralPath $workPath -Force -ErrorAction SilentlyContinue
      continue
    }
    $out = [string]$req.out
    $smallPath = [string]$req.small
    $format = if ($req.format) { [string]$req.format } else { 'jpg' }
    $miniW = if ([int]$req.width -gt 0) { [int]$req.width } else { 96 }
    $miniH = if ([int]$req.height -gt 0) { [int]$req.height } else { 54 }
    $maxW = if ([int]$req.maxWidth -gt 0) { [int]$req.maxWidth } else { 1280 }
    $quality = if ([int]$req.quality -gt 0) { [int]$req.quality } else { 85 }

    $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $full = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
    $g = [System.Drawing.Graphics]::FromImage($full)
    try { $g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size) }
    finally { $g.Dispose() }
    $t.copy = [int]$total.ElapsedMilliseconds

    $wantSmall = [bool]$smallPath
    $wantShot = $format -ne 'none' -and [bool]$out

    try {
      if ($wantSmall) {
        $miniBmp = New-Object System.Drawing.Bitmap $miniW, $miniH
        $miniG = [System.Drawing.Graphics]::FromImage($miniBmp)
        try {
          $miniG.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
          $miniG.DrawImage($full, (New-Object System.Drawing.Rectangle 0, 0, $miniW, $miniH))
        }
        finally { $miniG.Dispose() }
        $miniBmp.Save($smallPath, [System.Drawing.Imaging.ImageFormat]::Bmp)
        $miniBmp.Dispose()
        $t.small = [int]$total.ElapsedMilliseconds
      }

      $frameW = 0
      if ($wantShot) {
        $frameW = $maxW
        if ($frameW -le 0 -or $frameW -gt $full.Width) { $frameW = $full.Width }
        $frameH = [int][Math]::Round($full.Height * $frameW / $full.Width)
        $frame = $full
        $scaled = $null
        if ($frameW -ne $full.Width) {
          $scaled = New-Object System.Drawing.Bitmap $frameW, $frameH
          $frameG = [System.Drawing.Graphics]::FromImage($scaled)
          try {
            $frameG.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $frameG.DrawImage($full, (New-Object System.Drawing.Rectangle 0, 0, $frameW, $frameH))
          }
          finally { $frameG.Dispose() }
          $frame = $scaled
        }
        try {
          if ($format -eq 'jpg') {
            if (-not $jpgCodec) { throw 'no jpeg encoder available' }
            $encParams = New-Object System.Drawing.Imaging.EncoderParameters 1
            $encParams.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), ([long]$quality)
            $frame.Save($out, $jpgCodec, $encParams)
            $encParams.Dispose()
          }
          elseif ($format -eq 'png') { $frame.Save($out, [System.Drawing.Imaging.ImageFormat]::Png) }
          else { $frame.Save($out, [System.Drawing.Imaging.ImageFormat]::Bmp) }
        }
        finally { if ($scaled) { $scaled.Dispose() } }
        $t.shot = [int]$total.ElapsedMilliseconds
      }

      $t.total = [int]$total.ElapsedMilliseconds
      Write-Meta2 $metaPath @{ ok = $true; width = $bounds.Width; height = $bounds.Height; file = $out; small = $smallPath; w = $frameW; dpi = $dpiReady; ms = $t }
    }
    finally { $full.Dispose() }
  }
  catch {
    $t.total = [int]$total.ElapsedMilliseconds
    Write-Meta2 $metaPath @{ ok = $false; error = $_.Exception.Message; width = 0; height = 0; ms = $t }
  }
  finally {
    Remove-Item -LiteralPath $workPath -Force -ErrorAction SilentlyContinue
  }
}
