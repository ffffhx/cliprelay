Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path (Split-Path $PSScriptRoot) 'cliprelay.ps1'), [ref]$null, [ref]$errors)
if ($errors) { throw ($errors | Out-String) }
$function = $ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Update-ScreenSharingTrayState'}, $true)
Invoke-Expression $function.Extent.Text
function Get-ScreenSharingStatus { return $script:snapshot }
function Show-ClipRelayNotification { param($Title, $Message); $script:notificationsShown++ }
function Refresh { $script:screenShareNextUpdate = [DateTime]::MinValue; Update-ScreenSharingTrayState }
$script:screenShareStatusMenuItem = New-Object Windows.Forms.ToolStripMenuItem
$script:stopScreenShareMenuItem = New-Object Windows.Forms.ToolStripMenuItem
$notifyIcon = New-Object Windows.Forms.NotifyIcon
$script:screenShareLastEvent = ''
$script:screenShareLastText = '屏幕共享 · 未开始'
$script:screenShareWasActive = $false
$script:Notifications = $true
$script:notificationsShown = 0
$script:snapshot = $null
try {
    Refresh
    if ($script:stopScreenShareMenuItem.Enabled) { throw 'Idle stop action enabled' }
    $script:snapshot = [pscustomobject]@{senders=@([pscustomobject]@{peer='Friend';state='waiting'});receivers=0;lastEvent=$null}
    Refresh
    if (!$script:stopScreenShareMenuItem.Enabled -or $notifyIcon.Text -notlike '*待接收 Friend*') { throw 'Waiting state missing' }
    $script:snapshot.senders[0].state = 'connected'
    Refresh
    if ($notifyIcon.Text -notlike '*正在共享给 Friend*') { throw 'Live state missing' }
    $script:snapshot.senders += [pscustomobject]@{peer=('Long name ' * 20);state='reconnecting'}
    Refresh
    if ($notifyIcon.Text.Length -gt 63) { throw 'NotifyIcon text exceeds Windows limit' }
    $script:snapshot.senders = @()
    $script:snapshot.receivers = 1
    $script:snapshot.lastEvent = [pscustomobject]@{id='end-1';peer='Friend';reason='对方拒绝了观看邀请。'}
    Refresh; Refresh
    if (!$script:stopScreenShareMenuItem.Enabled -or $script:notificationsShown -ne 1) { throw 'Receiver stop or event deduplication failed' }
    $script:snapshot.receivers = 0
    Refresh
    if ($script:stopScreenShareMenuItem.Enabled -or $script:screenShareStatusMenuItem.Text -notlike '*拒绝*') { throw 'Ended state missing' }
    $script:snapshot = $null
    Refresh
    if ($script:screenShareStatusMenuItem.Text -notlike '*拒绝*') { throw 'Idle engine exit lost the last result' }
    $script:snapshot = [pscustomobject]@{senders=@([pscustomobject]@{peer='Friend';state='connected'});receivers=0;lastEvent=$null}
    Refresh
    $script:snapshot = $null
    Refresh; Refresh
    if ($script:stopScreenShareMenuItem.Enabled -or $script:screenShareStatusMenuItem.Text -notlike '*中断*') { throw 'Dead engine left a live indicator' }
    $script:Notifications = $false
    $script:snapshot = [pscustomobject]@{senders=@();receivers=0;lastEvent=[pscustomobject]@{id='end-2';peer='Friend';reason='Failed'}}
    Refresh
    if ($script:notificationsShown -ne 1) { throw 'Notification preference ignored' }
    'PASS: waiting, live, reconnecting, multiple sessions, bounded tooltip, stop availability, ended results, dead engine and notification preference.'
} finally { $notifyIcon.Dispose(); $script:screenShareStatusMenuItem.Dispose(); $script:stopScreenShareMenuItem.Dispose() }
