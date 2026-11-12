# gsd特制大肥鱼桌宠 安装脚本（PowerShell 版，由 安装.cmd 调用）
# 注意：本文件必须存成 UTF-8 with BOM，否则 Windows PowerShell 5.1 会按 GBK 读，中文全乱。

$ErrorActionPreference = "Stop"
& chcp.com 65001 | Out-Null
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$Src = Split-Path -Parent $MyInvocation.MyCommand.Path
$Dst = Join-Path $env:LOCALAPPDATA "gsd-pet"
$ExeName = "gsd大肥鱼桌宠.exe"
$Exe = Join-Path $Dst $ExeName

Write-Host ""
Write-Host "  ============================================" -ForegroundColor Cyan
Write-Host "     gsd特制大肥鱼桌宠   v1.1   轻量安装程序"  -ForegroundColor Cyan
Write-Host "  ============================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "  安装位置：$Dst"
Write-Host "  需要空间：约 600 MB（可选语音包另算）"
Write-Host ""

if (-not (Test-Path (Join-Path $Src $ExeName))) {
    Write-Host "  [错误] 找不到 $ExeName" -ForegroundColor Red
    Write-Host "         请把 安装.cmd 放在解压后的文件夹里再运行。"
    Read-Host "  按回车退出"
    exit 1
}

if (Test-Path $Exe) {
    Write-Host "  检测到已经装过了（会覆盖程序文件，不动你的设置）。" -ForegroundColor Yellow
    $ans = Read-Host "  继续吗？(Y/n)"
    if ($ans -and $ans.Trim().ToLower() -ne "y") { exit 0 }
}

Write-Host ""
Write-Host "  [1/4] 复制文件（轻量版约 600 MB）..." -ForegroundColor Green
New-Item -ItemType Directory -Force -Path $Dst | Out-Null
$robolog = Join-Path $env:TEMP "gsd-pet-install.log"
# 先关掉正在运行的桌宠，否则 robocopy 会在被占用的 dll 上无限重试（看起来像卡死）
Get-Process -Name "gsd大肥鱼桌宠" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*gsd-pet*standalone.js*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Get-CimInstance Win32_Process -Filter "Name='python.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*pet-voice*server.py*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 2
# /R:2 /W:2：最多重试 2 次，别死等
& robocopy $Src $Dst /E /NFL /NDL /NJH /NJS /NP /R:2 /W:2 /XF "安装.cmd" "install.ps1" "安装日志.txt" /LOG:$robolog | Out-Null
$rc = $LASTEXITCODE
if ($rc -ge 8) {
    Write-Host "  [错误] 复制失败（robocopy 代码 $rc），可能有文件被杀毒软件占用。" -ForegroundColor Red
    Write-Host "         日志：$robolog"
    Read-Host "  按回车退出"
    exit 1
}
Write-Host "         复制完成。" -ForegroundColor Green

Write-Host "  [2/4] 创建桌面快捷方式..."
$ws = New-Object -ComObject WScript.Shell
$lnkPath = Join-Path ([Environment]::GetFolderPath("Desktop")) "gsd特制大肥鱼桌宠.lnk"
$lnk = $ws.CreateShortcut($lnkPath)
$lnk.TargetPath = $Exe
$lnk.WorkingDirectory = $Dst
$lnk.IconLocation = (Join-Path $Dst "pet.ico") + ",0"
$lnk.Description = "gsd特制大肥鱼桌宠"
$lnk.Save()
Write-Host "         桌面快捷方式已创建。" -ForegroundColor Green

Write-Host "  [3/4] 写入卸载信息..."
$key = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\gsd-pet"
New-Item -Path $key -Force | Out-Null
Set-ItemProperty -Path $key -Name "DisplayName"     -Value "gsd特制大肥鱼桌宠"
Set-ItemProperty -Path $key -Name "DisplayIcon"     -Value ((Join-Path $Dst "pet.ico") + ",0")
Set-ItemProperty -Path $key -Name "InstallLocation" -Value $Dst
Set-ItemProperty -Path $key -Name "DisplayVersion"  -Value "1.1"
Set-ItemProperty -Path $key -Name "Publisher"       -Value "gsd"
Set-ItemProperty -Path $key -Name "NoModify"        -Value 1 -Type DWord
Set-ItemProperty -Path $key -Name "NoRepair"        -Value 1 -Type DWord
Set-ItemProperty -Path $key -Name "UninstallString" -Value ('"cmd.exe" /c ""' + (Join-Path $Dst "uninstall.cmd") + '""')
Write-Host "         卸载信息已写入（设置 → 应用 里能看到）。" -ForegroundColor Green

Write-Host "  [4/4] 开机自启动？"
$ans2 = Read-Host "         要不要开机自动启动桌宠？(y/N)"
$startupDir = [Environment]::GetFolderPath("Startup")
$autoLnk = Join-Path $startupDir "gsd特制大肥鱼桌宠.lnk"
if ($ans2 -and $ans2.Trim().ToLower() -eq "y") {
    $l2 = $ws.CreateShortcut($autoLnk)
    $l2.TargetPath = $Exe
    $l2.WorkingDirectory = $Dst
    $l2.IconLocation = (Join-Path $Dst "pet.ico") + ",0"
    $l2.Arguments = "--autostart"
    $l2.Save()
    Write-Host "         已设置为开机自启动。" -ForegroundColor Green
} else {
    if (Test-Path $autoLnk) { Remove-Item $autoLnk -Force -ErrorAction SilentlyContinue }
    Write-Host "         没开自启动（以后可以在 App 里勾）。" -ForegroundColor Gray
}

Write-Host ""
Write-Host "  ============================================" -ForegroundColor Cyan
Write-Host "   装好了！" -ForegroundColor Cyan
Write-Host ""
Write-Host "   1) 桌面双击「gsd特制大肥鱼桌宠」"
Write-Host "   2) 填 API Key（sk- 开头）"
Write-Host "      模型保持 deepseek-flash（这个模型能看图，别改）"
Write-Host "      API 地址 https://api.deepseek.com"
Write-Host "   3) 点「保存并运行」，桌宠先启动，语音模型后台加载"
Write-Host "   4) 右键点桌宠：听我说话 / 陪玩模式"
Write-Host ""
Write-Host "   卸载：运行 $Dst\uninstall.cmd" -ForegroundColor Gray
Write-Host "  ============================================" -ForegroundColor Cyan
Write-Host ""
Read-Host "  按回车关闭这个窗口"
