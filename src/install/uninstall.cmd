@echo off
chcp 65001 >nul
title gsd-pet uninstaller
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall.ps1"
