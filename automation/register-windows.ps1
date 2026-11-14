param(
    [Parameter(Mandatory=$true)][string]$TaskName,
    [Parameter(Mandatory=$true)][string]$NodePath,
    [Parameter(Mandatory=$true)][string]$CliPath,
    [Parameter(Mandatory=$true)][string]$DataRoot,
    [ValidateSet('enable','disable')][string]$Mode
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
if ($Mode -eq 'disable') {
    try { $registered = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop }
    catch { if ($_.CategoryInfo.Category -eq 'ObjectNotFound') { exit 0 }; throw }
    if ($registered) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false }
    exit 0
}
foreach ($value in @($NodePath,$CliPath,$DataRoot)) { if ($value.Contains('"')) { throw 'Invalid scheduler path' } }
$taskArguments = '"' + $CliPath + '" tick --data "' + $DataRoot.TrimEnd('\') + '"'
$action = New-ScheduledTaskAction -Execute $NodePath -Argument $taskArguments -WorkingDirectory (Split-Path -Parent $CliPath)
$first = (Get-Date).AddMinutes(1)
$first = [datetime]::new($first.Year,$first.Month,$first.Day,$first.Hour,$first.Minute,0)
$trigger = New-ScheduledTaskTrigger -Once -At $first -RepetitionInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -MultipleInstances Parallel -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Lingxing Search scheduled collection' -Force | Out-Null
