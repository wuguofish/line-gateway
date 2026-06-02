# install-task.ps1 — registers start-daemon.ps1 as a Windows scheduled task (at logon)
$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$daemonScript = Join-Path $scriptDir 'start-daemon.ps1'

$action = New-ScheduledTaskAction `
    -Execute 'powershell.exe' `
    -Argument "-NoProfile -WindowStyle Hidden -File `"$daemonScript`""

$trigger = New-ScheduledTaskTrigger -AtLogOn

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable

Register-ScheduledTask `
    -TaskName 'LINE Gateway Daemon' `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Description 'Local LINE Gateway daemon for Claude Code LINE channel plugins' `
    -Force

Write-Host "scheduled task 'LINE Gateway Daemon' registered; will start at next logon"
