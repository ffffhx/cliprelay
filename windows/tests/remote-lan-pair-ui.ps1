[CmdletBinding()]
param([string]$ScreenshotPath='')
Set-StrictMode -Version 2.0
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Threading.Tasks;
using System.Windows.Forms;
namespace ClipRelayLanQa {
    public class NoActivateForm : Form {
        protected override bool ShowWithoutActivation { get { return true; } }
        protected override CreateParams CreateParams { get { var cp=base.CreateParams;cp.ExStyle|=0x08000000;return cp; } }
        protected override void OnLoad(EventArgs e) {
            base.OnLoad(e);
            StartPosition=FormStartPosition.Manual;Location=new Point(-30000,-30000);
        }
    }
}
namespace ClipRelay.Remote {
    public static class ControlClient {
        public static string LastAction="";
        public static Task<string> RequestAsync(string json) {
            if(json.Contains("lanPairApprove")) {LastAction="lanPairApprove";return Task.FromResult("{\"ok\":true,\"data\":{\"status\":true}}");}
            if(json.Contains("pairings")) return Task.FromResult("{\"ok\":true,\"data\":{\"pairings\":[{\"id\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"name\":\"Test phone\",\"address\":\"0123 4567 89AB\",\"automatic\":true,\"verification\":\"0123 4567 89AB\"}]}}");
            if(json.Contains("clients")) return Task.FromResult("{\"ok\":true,\"data\":{\"named_certs\":[]}}");
            return Task.FromResult("{\"ok\":true,\"data\":{\"enabled\":true,\"ready\":true}}");
        }
    }
}
'@
$source=Get-Content -Raw -Encoding UTF8 (Join-Path (Split-Path $PSScriptRoot) 'remote-desktop\ui.ps1')
$temporary=Join-Path ([IO.Path]::GetTempPath()) ('cliprelay-lan-ui-'+[Guid]::NewGuid().ToString('N')+'.ps1')
$source=$source.Replace('New-Object Windows.Forms.Form','New-Object ClipRelayLanQa.NoActivateForm')
$source=$source.Replace("`$form.StartPosition = 'CenterScreen'", "`$form.StartPosition = 'Manual'; `$form.Location = New-Object Drawing.Point(-30000,-30000); `$form.ShowInTaskbar = `$false")
[IO.File]::WriteAllText($temporary,$source,[Text.UTF8Encoding]::new($true))
. $temporary
$state=@{Sent=$false;Passed=$false;Error='';Deadline=[DateTime]::UtcNow.AddSeconds(18)}
$timer=New-Object Windows.Forms.Timer
$timer.Interval=100
$timer.Add_Tick({
    $form=[Windows.Forms.Application]::OpenForms['RemoteDesktopSettings']
    if($null -eq $form){return}
    try {
        if([DateTime]::UtcNow -gt $state.Deadline){throw 'UI test timed out'}
        $pending=$form.Controls.Find('RemoteDesktopPairings',$true)[0]
        $button=$form.Controls.Find('RemoteDesktopPair',$true)[0]
        if(!$state.Sent -and $pending.Items.Count -eq 1 -and $button.Enabled){
            if($form.Controls.Find('RemoteDesktopPin',$true)[0].Visible){throw 'Manual PIN is still visible for automatic pairing'}
            if($form.Controls.Find('RemoteDesktopVerification',$true)[0].Text -cne '0123 4567 89AB'){throw 'Verification code missing'}
            $button.PerformClick();$state.Sent=$true
        }
        $message=$form.Controls.Find('RemoteDesktopMessage',$true)[0].Text
        if($state.Sent -and $message -like '已允许这台手机*'){
            if([ClipRelay.Remote.ControlClient]::LastAction -ne 'lanPairApprove'){throw 'Wrong authorization action'}
            if($ScreenshotPath){
                $bitmap=New-Object Drawing.Bitmap($form.Width,$form.Height)
                try{$form.DrawToBitmap($bitmap,[Drawing.Rectangle]::new(0,0,$form.Width,$form.Height));$bitmap.Save([IO.Path]::GetFullPath($ScreenshotPath))}finally{$bitmap.Dispose()}
            }
            $state.Passed=$true;$form.Close()
        }
    } catch {$state.Error=$_.Exception.Message;$form.Close()}
}.GetNewClosure())
try{$timer.Start();Show-RemoteDesktopSettings}finally{$timer.Stop();$timer.Dispose();Remove-Item -LiteralPath $temporary -Force}
if($state.Error){throw $state.Error}
if(!$state.Passed){throw 'LAN pairing UI did not finish'}
'PASS: matching code, no manual PIN, one approval action (off-screen, no activation).'
