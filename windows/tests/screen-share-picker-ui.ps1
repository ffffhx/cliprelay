param([string]$ScreenshotPath='')
Set-StrictMode -Version 2.0
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[Windows.Forms.Application]::SetUnhandledExceptionMode([Windows.Forms.UnhandledExceptionMode]::ThrowException)
$client=Join-Path (Split-Path $PSScriptRoot) 'cliprelay.ps1'
$source=Get-Content $client -Raw -Encoding UTF8
$match=[regex]::Match($source,'\$clipRelaySource = @"\r?\n(?<code>.*?)\r?\n"@',[Text.RegularExpressions.RegexOptions]::Singleline)
Add-Type -TypeDefinition $match.Groups['code'].Value -ReferencedAssemblies @('System.dll','System.Core.dll','System.Drawing.dll','System.Windows.Forms.dll')
$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($client,[ref]$null,[ref]$errors)
if($errors){throw ($errors | Out-String)}
foreach($name in @('Get-PropertyValue','Show-ScreenSharing')){
$f=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true)
Invoke-Expression $f.Extent.Text
}
function Initialize-ScreenSharing {}
function Invoke-ScreenShareCommand {param($Command) if($script:failStart){throw 'Test: receiver unavailable'};$script:captured=$Command}
function Get-Picker {return @([Windows.Forms.Application]::OpenForms | Where-Object Name -eq 'ScreenSharePicker')[0]}
function Capture-Picker($form,$file){
[Windows.Forms.Application]::DoEvents()
$bitmap=New-Object Drawing.Bitmap($form.Width,$form.Height)
try{$form.DrawToBitmap($bitmap,[Drawing.Rectangle]::new(0,0,$form.Width,$form.Height));$bitmap.Save($file,[Drawing.Imaging.ImageFormat]::Png)}finally{$bitmap.Dispose()}
}
$script:DeviceName='UCKF';$script:Port=47632;$script:appIcon=$null;$script:failStart=$false
$phone=[pscustomobject]@{name='Phone';address='192.168.0.102';platform='android';enabled=$true}
$pc=[pscustomobject]@{name='YIFAN';address='192.168.0.103';platform='windows';enabled=$false;port=47632}
$script:Peers=@($phone,$pc)
$script:ownerRefreshCount=0
$owner=New-Object Windows.Forms.Form
$owner.Tag=[pscustomobject]@{RefreshScreenSharing={ $script:ownerRefreshCount++ }}
Show-ScreenSharing -Owner $owner
$form=Get-Picker
Show-ScreenSharing
if(@([Windows.Forms.Application]::OpenForms | Where-Object Name -eq 'ScreenSharePicker').Count -ne 1){throw 'Duplicate picker'}
$list=$form.Controls['ScreenSharePeerList']
if($list.Controls.Count -ne 1 -or $list.Controls[0].AccessibleName -notlike 'YIFAN*'){throw 'Incorrect device roster'}
if($form.FormBorderStyle -ne 'None'){throw 'Native frame remains'}
if($ScreenshotPath){Capture-Picker $form $ScreenshotPath}
$script:failStart=$true
$form.Controls['StartScreenShareButton'].PerformClick()
if(!$form.Visible -or !$form.Controls['StartScreenShareButton'].Enabled -or $form.Controls['ScreenShareHint'].Text -notlike 'Test:*'){throw 'Inline error/retry failed'}
$script:failStart=$false
$form.Controls['StartScreenShareButton'].PerformClick()
if($script:captured.peer.name -ne 'YIFAN' -or $script:captured.localPort -ne 47632 -or $pc.enabled){throw 'Wrong destination or changed broadcast toggle'}
if($script:ownerRefreshCount -ne 1){throw 'Owner did not receive immediate status refresh after starting'}
$owner.Dispose()
$script:Peers=@($pc)
foreach($i in 2..5){$script:Peers += [pscustomobject]@{name="PC $i";address="192.168.0.$i";platform='windows';enabled=$true;port=47632}}
Show-ScreenSharing
$form=Get-Picker
$list=$form.Controls['ScreenSharePeerList']
if(!$list.AutoScroll -or $list.Controls.Count -ne 5){throw 'Device roster does not scroll'}
$list.Controls['ScreenSharePeer4'].PerformClick()
$form.Controls['StartScreenShareButton'].PerformClick()
if($script:captured.peer.name -ne 'PC 5'){throw 'Selected card was not used'}
$script:Peers=@($phone)
Show-ScreenSharing
$form=Get-Picker
if($form.Controls['StartScreenShareButton'].Enabled){throw 'Empty list can start sharing'}
$form.CancelButton.PerformClick()
'PASS: themed picker, selection, disabled broadcast target, scroll, empty state, inline retry, cancel and duplicate prevention.'
