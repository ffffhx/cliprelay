[CmdletBinding()]
param([string]$ScreenshotPath = '')
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -Path (Join-Path (Split-Path $PSScriptRoot) 'remote-desktop\bin\ClipRelay.Remote.Client.dll')
[Windows.Forms.Application]::SetUnhandledExceptionMode([Windows.Forms.UnhandledExceptionMode]::ThrowException)
. (Join-Path (Split-Path $PSScriptRoot) 'remote-desktop\ui.ps1')
$testState = @{Error=$null;Tick=0;Passed=$false}
$timer = New-Object Windows.Forms.Timer
$timer.Interval=1000
$timer.Add_Tick({
    $testState.Tick++
    $form=[Windows.Forms.Application]::OpenForms['RemoteNetworkSettings']
    if ($null -eq $form -or $testState.Tick -lt 6) { return }
    try {
        foreach ($name in @('RemoteNetworkStatus','RemoteNetworkToggle','RemoteNetworkCode','RemoteNetworkPending','RemoteNetworkApprove','RemoteNetworkPeers','RemoteNetworkRevoke')) {
            if ($form.Controls.Find($name,$true).Count -ne 1) { throw "Missing control $name" }
        }
        $status=$form.Controls.Find('RemoteNetworkStatus',$true)[0].Text
        $message=$form.Controls.Find('RemoteNetworkMessage',$true)[0].Text
        if ($status -ne '外网连接已就绪' -and $status -ne '外网连接已关闭') { throw "Unexpected network status: $status" }
        if ($message -like '操作未完成*') { throw $message }
        if ($ScreenshotPath) {
            $bitmap=New-Object Drawing.Bitmap($form.Width,$form.Height)
            try { $form.DrawToBitmap($bitmap,[Drawing.Rectangle]::new(0,0,$form.Width,$form.Height)); $bitmap.Save([IO.Path]::GetFullPath($ScreenshotPath)) } finally { $bitmap.Dispose() }
        }
        $testState.Passed=$true
    } catch { $testState.Error=$_.Exception.Message }
    $form.Close(); $timer.Stop()
}.GetNewClosure())
try { $timer.Start(); Show-RemoteNetworkSettings } finally { $timer.Stop(); $timer.Dispose() }
if ($testState.Error) { throw $testState.Error }
if (!$testState.Passed) { throw 'Network UI test did not finish.' }
'PASS: network settings display the installed service state under StrictMode.'
