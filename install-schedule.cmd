@echo off
rem MatchLab - install the scheduled task: the data is refreshed every 2 hours, without a window.
rem Run it once (double-click). To remove the task: remove-schedule.cmd
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0collector\schedule.ps1"
