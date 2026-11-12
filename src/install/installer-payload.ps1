$ErrorActionPreference = "Stop"
$source = Split-Path -Parent $MyInvocation.MyCommand.Path
$payload = Join-Path $source "payload.zip"
$target = Join-Path $env:LOCALAPPDATA "gsd-pet"
$temp = Join-Path $env:TEMP ("gsd-pet-lite-" + [Guid]::NewGuid().ToString("N"))

try {
  Expand-Archive -LiteralPath $payload -DestinationPath $temp -Force
  Get-Process -Name "gsd大肥鱼桌宠" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*gsd-pet*standalone.js*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Get-CimInstance Win32_Process -Filter "Name='python.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*pet-voice*server.py*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

  New-Item -ItemType Directory -Force -Path $target | Out-Null
  & robocopy.exe $temp $target /E /R:2 /W:2 /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy failed with exit code $LASTEXITCODE" }

  $exe = Join-Path $target "gsd大肥鱼桌宠.exe"
  $shell = New-Object -ComObject WScript.Shell
  $link = $shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath("Desktop")) "gsd特制大肥鱼桌宠.lnk"))
  $link.TargetPath = $exe
  $link.WorkingDirectory = $target
  $link.IconLocation = (Join-Path $target "pet.ico") + ",0"
  $link.Save()

  $uninstall = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\gsd-pet"
  New-Item -Path $uninstall -Force | Out-Null
  Set-ItemProperty -Path $uninstall -Name "DisplayName" -Value "gsd特制大肥鱼桌宠"
  Set-ItemProperty -Path $uninstall -Name "DisplayIcon" -Value ((Join-Path $target "pet.ico") + ",0")
  Set-ItemProperty -Path $uninstall -Name "InstallLocation" -Value $target
  Set-ItemProperty -Path $uninstall -Name "DisplayVersion" -Value "1.1"
  Set-ItemProperty -Path $uninstall -Name "Publisher" -Value "gsd"
  Set-ItemProperty -Path $uninstall -Name "NoModify" -Value 1 -Type DWord
  Set-ItemProperty -Path $uninstall -Name "NoRepair" -Value 1 -Type DWord
  Set-ItemProperty -Path $uninstall -Name "UninstallString" -Value ('"cmd.exe" /c ""' + (Join-Path $target "uninstall.cmd") + '""')
  Start-Process -FilePath $exe -WorkingDirectory $target
} finally {
  Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}
