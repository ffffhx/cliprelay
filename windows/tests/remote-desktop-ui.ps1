[CmdletBinding()]
param([string]$ScreenshotPath = '')
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[Windows.Forms.Application]::SetUnhandledExceptionMode([Windows.Forms.UnhandledExceptionMode]::ThrowException)
. (Join-Path (Split-Path $PSScriptRoot) 'remote-desktop\ui.ps1')
$testState = @{Error=$null;Tick=0;Passed=$false}
$timer = New-Object Windows.Forms.Timer
$timer.Interval=1000
$timer.Add_Tick({
    $testState.Tick++
    $form=[Windows.Forms.Application]::OpenForms['RemoteDesktopSettings']
    if ($null -eq $form) { return }
    if ($testState.Tick -lt 8) { return }
    try {
        foreach ($name in @('RemoteDesktopStatus','RemoteDesktopToggle','RemoteDesktopAddresses','RemoteDesktopPairings','RemoteDesktopPin','RemoteDesktopPair','RemoteDesktopClients','RemoteDesktopRevoke','RemoteDesktopDisconnect')) {
            if ($form.Controls.Find($name,$true).Count -ne 1) { throw "Missing control $name" }
        }
        $status=$form.Controls.Find('RemoteDesktopStatus',$true)[0].Text
        if ($status -notlike '远控已开启*' -and $status -ne '远控已关闭') { throw "Service not ready: $status" }
        if ($ScreenshotPath) {
            $bitmap=New-Object Drawing.Bitmap($form.Width,$form.Height)
            try { $form.DrawToBitmap($bitmap,[Drawing.Rectangle]::new(0,0,$form.Width,$form.Height)); $bitmap.Save([IO.Path]::GetFullPath($ScreenshotPath)) } finally { $bitmap.Dispose() }
        }
        $testState.Passed=$true
    } catch { $testState.Error=$_.Exception.Message }
    $form.Close(); $timer.Stop()
}.GetNewClosure())
try { $timer.Start(); Show-RemoteDesktopSettings } finally { $timer.Stop(); $timer.Dispose() }
if ($testState.Error) { throw $testState.Error }
if (!$testState.Passed) { throw 'Remote desktop UI test did not finish.' }
'PASS: integrated remote settings communicate with the installed ClipRelay service.'
