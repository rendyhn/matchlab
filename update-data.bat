@echo off
rem MatchLab - collect the extra data (football-data.org, Understat, OpenLigaDB, bookmaker odds).
rem Writes data\latest.json and data\latest.js; reload index.html afterwards.
rem The scheduled task (install-schedule.cmd) runs the same collector every 2 hours without a
rem window; its last run's output is in collector\cache\update.log.
cd /d "%~dp0"
python collector\collect.py
if errorlevel 1 (
  echo.
  echo The data collector failed. Check that Python is installed and the internet is connected.
)
if "%1"=="" pause
