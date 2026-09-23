@echo off
rem MatchLab - remove the scheduled task installed by install-schedule.cmd.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0collector\schedule.ps1" -Remove
