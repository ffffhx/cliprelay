[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$PairingId, [Parameter(Mandatory=$true)][string]$Pin, [string]$ScreenshotPath='')
Set-StrictMode -Version 2.0
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
. (Join-Path (Split-Path $PSScriptRoot) 'remote-desktop\ui.ps1')
$state=@{Sent=$false;Passed=$false;Error=$null;Deadline=[DateTime]::UtcNow.AddSeconds(45)}
$timer=New-Object Windows.Forms.Timer
$timer.Interval=250
$timer.Add_Tick({
    $form=[Windows.Forms.Application]::OpenForms['RemoteDesktopSettings']
    if ($null -eq $form) {return}
    try {
        if ([DateTime]::UtcNow -gt $state.Deadline) {throw 'Timed out waiting for the pairing UI.'}
        $pending=$form.Controls.Find('RemoteDesktopPairings',$true)[0]
        $button=$form.Controls.Find('RemoteDesktopPair',$true)[0]
        if (!$state.Sent -and $button.Enabled) {
            for ($i=0; $i -lt $pending.Items.Count; $i++) {
                if ($pending.Items[$i].id -ceq $PairingId) {
                    $pending.SelectedIndex=$i
                    $form.Controls.Find('RemoteDesktopPin',$true)[0].Text=$Pin
                    $button.PerformClick()
                    $state.Sent=$true
                    break
                }
            }
        }
        $message=$form.Controls.Find('RemoteDesktopMessage',$true)[0].Text
        if ($state.Sent -and $message -like '配对成功*') {
            if ($ScreenshotPath) {
                $bitmap=New-Object Drawing.Bitmap($form.Width,$form.Height)
                try {$form.DrawToBitmap($bitmap,[Drawing.Rectangle]::new(0,0,$form.Width,$form.Height));$bitmap.Save([IO.Path]::GetFullPath($ScreenshotPath))} finally {$bitmap.Dispose()}
            }
            $state.Passed=$true
            $form.Close()
        }
        if ($state.Sent -and $message -like '操作未完成*') {throw $message}
    } catch {$state.Error=$_.Exception.Message;$form.Close()}
}.GetNewClosure())
try {$timer.Start();Show-RemoteDesktopSettings} finally {$timer.Stop();$timer.Dispose()}
if ($state.Error) {throw $state.Error}
if (!$state.Passed) {throw 'Pairing was not confirmed.'}
'PASS: phone pairing approved through the ClipRelay settings UI.'
