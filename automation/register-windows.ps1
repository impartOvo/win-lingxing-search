param(
    [Parameter(Mandatory=$true)][string]$TaskName,
    [Parameter(Mandatory=$true)][string]$LauncherPath,
    [Parameter(Mandatory=$true)][string]$DataRoot,
    [ValidateSet('enable','disable')][string]$Mode,
    [ValidateSet('collection','monitor')][string]$Kind = 'collection',
    [ValidateRange(5,2147483647)][int]$IntervalMinutes = 30
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
try { $registered = @(Get-ScheduledTask -TaskName ($TaskName + '*') -ErrorAction Stop | Where-Object { $_.TaskName -match ('^' + [regex]::Escape($TaskName) + '(-[0-9]{4})?$') }) }
catch { if ($_.CategoryInfo.Category -eq 'ObjectNotFound') { $registered = @() } else { throw } }
if ($Mode -eq 'disable') {
    foreach ($task in $registered) { $task | Unregister-ScheduledTask -Confirm:$false }
    exit 0
}
foreach ($value in @($LauncherPath,$DataRoot)) { if ($value.Contains('"')) { throw 'Invalid scheduler path' } }
if (-not (Test-Path -LiteralPath $LauncherPath -PathType Leaf)) { throw 'Scheduler launcher is missing; rebuild or update the application first' }
if ($Kind -eq 'monitor') {
    # Run the GUI-subsystem native launcher, independent of collection triggers.
    $monitorArguments = '--monitor-tick --data "' + $DataRoot.TrimEnd('\') + '"'
    $monitorAction = New-ScheduledTaskAction -Execute $LauncherPath -Argument $monitorArguments -WorkingDirectory (Split-Path -Parent $LauncherPath)
    $monitorTrigger = New-ScheduledTaskTrigger -Once -At ([datetime]::Now.AddMinutes(1)) -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes)
    $monitorPrincipal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
    $monitorSettings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    Register-ScheduledTask -TaskName $TaskName -Action $monitorAction -Trigger $monitorTrigger -Principal $monitorPrincipal -Settings $monitorSettings -Description 'PulsarFetch background monitoring' -Force | Out-Null
    exit 0
}
# A console-subsystem executable (including node.exe or PowerShell) flashes even for an idle tick.
$taskArguments = '--automation-tick --data "' + $DataRoot.TrimEnd('\') + '"'
$action = New-ScheduledTaskAction -Execute $LauncherPath -Argument $taskArguments -WorkingDirectory (Split-Path -Parent $LauncherPath)
$slots = ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd())
foreach ($slot in $slots) {
    if ($slot.time -notmatch '^([01][0-9]|2[0-3]):[0-5][0-9]$' -or @($slot.days).Count -eq 0) { throw 'Invalid scheduler time' }
    foreach ($day in $slot.days) { if (($day -isnot [int] -and $day -isnot [long]) -or $day -lt 0 -or $day -gt 6) { throw 'Invalid scheduler weekday' } }
}
$principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -MultipleInstances Parallel -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$wanted = @()
foreach ($slot in $slots) {
    $name = $TaskName + '-' + $slot.time.Replace(':','')
    $wanted += $name
    $at = [datetime]::Today.Add([timespan]::ParseExact($slot.time, 'hh\:mm', [System.Globalization.CultureInfo]::InvariantCulture))
    $days = [System.DayOfWeek[]]@($slot.days | ForEach-Object { [System.DayOfWeek]$_ })
    $trigger = New-ScheduledTaskTrigger -Weekly -WeeksInterval 1 -DaysOfWeek $days -At $at
    Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Lingxing Search scheduled collection' -Force | Out-Null
}
# Register new times before removing obsolete times and the former once-a-minute entry.
foreach ($task in $registered) { if ($task.TaskName -notin $wanted) { $task | Unregister-ScheduledTask -Confirm:$false } }
