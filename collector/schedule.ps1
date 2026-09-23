# MatchLab - register the collector in Windows Task Scheduler: every 2 hours, no window.
# Called by install-schedule.cmd / remove-schedule.cmd. Registering a task needs admin rights on this
# PC (UAC), so the script restarts itself elevated; the task itself runs as you, not as admin.
param([switch]$Remove)

$name = 'MatchLab - update data'
$root = Split-Path -Parent $PSScriptRoot
$me = [Security.Principal.WindowsIdentity]::GetCurrent()
$isAdmin = ([Security.Principal.WindowsPrincipal]$me).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  $argv = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"")
  if ($Remove) { $argv += '-Remove' }
  Start-Process powershell.exe -Verb RunAs -ArgumentList $argv
  exit
}

try {
  if ($Remove) {
    Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction Stop
    Write-Host "Scheduled task '$name' removed."
  } else {
    $py = (Get-Command pythonw.exe -ErrorAction SilentlyContinue).Source
    if (-not $py) { throw 'pythonw.exe not found. Install Python 3 first.' }
    $log = Join-Path $root 'collector\cache\update.log'
    $action = New-ScheduledTaskAction -Execute $py -WorkingDirectory $root `
      -Argument ('"{0}" --log "{1}"' -f (Join-Path $root 'collector\collect.py'), $log)
    # from midnight today, every 2 hours: 00:00, 02:00, 04:00 ...
    $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).Date -RepetitionInterval (New-TimeSpan -Hours 2)
    # StartWhenAvailable: a run missed while the PC was off or asleep starts as soon as it is back
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RunOnlyIfNetworkAvailable `
      -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
      -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -MultipleInstances IgnoreNew
    $principal = New-ScheduledTaskPrincipal -UserId $me.Name -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskName $name -Force -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
      -Description "MatchLab: latest football data into $root\data every 2 hours. Last run's output: $log" -ErrorAction Stop | Out-Null
    Start-ScheduledTask -TaskName $name
    $info = Get-ScheduledTaskInfo -TaskName $name
    Write-Host "Scheduled task '$name' installed: every 2 hours, no window, as $($me.Name)."
    Write-Host "The first run is working in the background now (about 2 minutes)."
    Write-Host "Next run: $($info.NextRunTime)"
    Write-Host "Last run's output: $log"
  }
} catch {
  Write-Host "Failed: $($_.Exception.Message)" -ForegroundColor Red
}
Read-Host 'Press Enter to close'
