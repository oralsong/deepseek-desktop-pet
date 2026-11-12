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

Copy-Item -LiteralPath $PayloadZip -Destination (Join-Path $stage "payload.zip") -Force
Copy-Item -LiteralPath (Join-Path $root "src\install\installer-payload.ps1") -Destination (Join-Path $stage "setup.ps1") -Force

$target = Join-Path $dist "gsd-pet-lite-1.1-setup.exe"
if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Force }
$sed = Join-Path $stage "installer.sed"
$sourceDir = $stage.TrimEnd("\") + "\"
$content = @"
[Version]
Class=IEXPRESS
SEDVersion=3
[Options]
PackagePurpose=InstallApp
ShowInstallProgramWindow=0
HideExtractAnimation=1
UseLongFileName=1
InsideCompressed=0
CAB_FixedSize=0
CAB_ResvCodeSigning=0
RebootMode=N
InstallPrompt=
DisplayLicense=
FinishMessage=
TargetName=$target
FriendlyName=gsd-pet-lite
AppLaunched=powershell.exe -NoProfile -ExecutionPolicy Bypass -File setup.ps1
PostInstallCmd=<None>
AdminQuietInstCmd=
UserQuietInstCmd=
SourceFiles=SourceFiles
[Strings]
FILE0="payload.zip"
FILE1="setup.ps1"
[SourceFiles]
SourceFiles0=$sourceDir
[SourceFiles0]
%FILE0%=
%FILE1%=
"@
Set-Content -LiteralPath $sed -Value $content -Encoding ASCII
$iexpress = Start-Process -FilePath "$env:WINDIR\System32\iexpress.exe" -ArgumentList @("/N", "/Q", $sed) `
  -WindowStyle Hidden -PassThru
$iexpress.WaitForExit()
if ($iexpress.ExitCode -ne 0) { throw "IExpress failed with exit code $($iexpress.ExitCode)" }
if (-not (Test-Path -LiteralPath $target)) { throw "Installer was not produced: $target" }
Write-Host "Built: $target"
Write-Host ("Size: {0:N1} MB" -f ((Get-Item -LiteralPath $target).Length / 1MB))
