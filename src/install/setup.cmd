@echo off
chcp 65001 >nul
title gsd-pet setup
rem ASCII entry: extract this zip anywhere, then double-click setup.cmd
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
if errorlevel 1 pause
