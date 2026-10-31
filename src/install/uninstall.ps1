# gsd特制大肥鱼桌宠 卸载脚本（由 uninstall.cmd 调用）
# 必须存成 UTF-8 with BOM。

$ErrorActionPreference = "Continue"
& chcp.com 65001 | Out-Null
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$Dst = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host ""
Write-Host "  ============================================" -ForegroundColor Cyan
Write-Host "     gsd特制大肥鱼桌宠   卸载" -ForegroundColor Cyan
Write-Host "  ============================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "  将要删除：$Dst"
Write-Host "  桌面快捷方式、开机自启项、卸载注册表项"
Write-Host ""
$ans = Read-Host "  确定卸载吗？(y/N)"
if (-not $ans -or $ans.Trim().ToLower() -ne "y") { Write-Host "  已取消。"; Start-Sleep 1; exit 0 }

Write-Host "  [1/4] 停止进程..."
Get-CimInstance Win32_Process | Where-Object {
    $_.CommandLine -and (
        $_.CommandLine -like "*gsd-pet*" -or
        $_.CommandLine -like "*standalone.js*" -or
        $_.CommandLine -like "*pet-voice*server.py*"
    )
} | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch {} }
Start-Sleep -Milliseconds 800
Write-Host "         完成。"

Write-Host "  [2/4] 删除快捷方式..."
$desk = Join-Path ([Environment]::GetFolderPath("Desktop")) "gsd特制大肥鱼桌宠.lnk"
$auto = Join-Path ([Environment]::GetFolderPath("Startup")) "gsd特制大肥鱼桌宠.lnk"
foreach ($p in @($desk, $auto)) { if (Test-Path $p) { Remove-Item $p -Force -ErrorAction SilentlyContinue } }
Write-Host "         完成。"

Write-Host "  [3/4] 删除卸载注册表项..."
Remove-Item "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\gsd-pet" -Recurse -Force -ErrorAction SilentlyContinue
Write-Host "         完成。"

Write-Host "  [4/4] 删除程序目录（后台进行，窗口会自动关）..."
$ans2 = Read-Host "         你的 API Key 和陪玩记忆要一起删吗？(y/N)"
if ($ans2 -and $ans2.Trim().ToLower() -eq "y") {
    $cfg = Join-Path $env:USERPROFILE ".dsh\dsh-pet"
    foreach ($f in @("standalone-ai.json", "peek.json", "peek-memory.json", "standalone-runtime.json")) {
        $p = Join-Path $cfg $f
        if (Test-Path $p) { Remove-Item $p -Force -ErrorAction SilentlyContinue }
    }
    Write-Host "         配置已删除。"
} else {
    Write-Host "         配置保留（以后重装还能接着用）。"
}

$cleaner = Join-Path $env:TEMP ("gsd-pet-clean-" + [guid]::NewGuid().ToString("N") + ".cmd")
$lines = @(
    "@echo off",
    "timeout /t 2 /nobreak >nul",
    "rmdir /s /q `"$Dst`"",
    "del /f /q `"%~f0`" >nul 2>nul"
)
Set-Content -Path $cleaner -Value $lines -Encoding ASCII
Start-Process -FilePath "cmd.exe" -ArgumentList "/c", "`"$cleaner`"" -WindowStyle Hidden
Write-Host "  卸载完成，窗口即将关闭。" -ForegroundColor Green
Start-Sleep -Seconds 2
