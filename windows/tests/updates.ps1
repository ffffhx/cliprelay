param([switch]$Network, [string]$ScreenshotPath='')
Set-StrictMode -Version 2.0
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[Windows.Forms.Application]::SetUnhandledExceptionMode([Windows.Forms.UnhandledExceptionMode]::ThrowException)
$root=Split-Path $PSScriptRoot
$source=Get-Content (Join-Path $root 'cliprelay.ps1') -Raw -Encoding UTF8
$match=[regex]::Match($source,'\$clipRelaySource = @"\r?\n(?<code>.*?)\r?\n"@',[Text.RegularExpressions.RegexOptions]::Singleline)
Add-Type -TypeDefinition $match.Groups['code'].Value -ReferencedAssemblies @('System.dll','System.Core.dll','System.Drawing.dll','System.Windows.Forms.dll')
$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $root 'cliprelay.ps1'),[ref]$null,[ref]$errors)
if($errors){throw ($errors|Out-String)}
$property=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Get-PropertyValue'},$true)
Invoke-Expression $property.Extent.Text
. (Join-Path $root 'updates.ps1')
function Assert($Condition,$Message){if(!$Condition){throw $Message}}
function Complete-Check($Info,$ErrorText=''){
    $transfer=[PSCustomObject]@{Done=$true;Error=$ErrorText;Content=($Info|ConvertTo-Json -Depth 5);FilePath='';Received=0}
    $transfer|Add-Member ScriptMethod Dispose {}
    $script:relayUpdateState.Transfer=$transfer
    $script:relayUpdateState.Operation='check'
    Update-RelayUpdateState
}
function Wait-Transfer($Transfer){
    $deadline=[DateTime]::UtcNow.AddSeconds(45)
    while(!$Transfer.Done -and [DateTime]::UtcNow -lt $deadline){Start-Sleep -Milliseconds 30}
    if(!$Transfer.Done){$Transfer.Dispose();throw 'Transfer did not finish'}
}
$oldLocal=$env:LOCALAPPDATA
$temp=Join-Path ([IO.Path]::GetTempPath()) ('cliprelay-updates-test-'+[Guid]::NewGuid().ToString('N'))
try{
    $env:LOCALAPPDATA=$temp
    $script:appIcon=$null; $script:updateMenuItem=$null
    $script:notifyIcon=[PSCustomObject]@{Count=0}
    $script:notifyIcon|Add-Member ScriptMethod ShowBalloonTip {param($ms,$title,$body,$icon) $this.Count++}
    Initialize-RelayUpdater
    $state=$script:relayUpdateState
    $state.NextCheck=[DateTime]::UtcNow.AddHours(1)
    $offer=@{versionCode=2;versionName='0.2.0';sizeBytes=123456;sha256=('a'*64);releaseNotes="新增更新提醒。`n屏幕共享体验改进。";downloadUrl="$script:relayUpdateBase/ClipRelay-Windows-0.2.0.zip"}
    foreach($mutation in @(
        @{downloadUrl='http://example.com/payload.zip'}, @{downloadUrl='https://example.com/payload.zip'},
        @{downloadUrl="$script:relayUpdateBase/../payload.zip"}, @{sizeBytes=0}, @{sizeBytes=536870913},
        @{versionCode='2'}, @{versionCode=$true}, @{versionName='../../evil'}, @{sha256='bad'}, @{releaseNotes=''}
    )){
        $bad=$offer.Clone();foreach($key in $mutation.Keys){$bad[$key]=$mutation[$key]}
        $rejected=$false
        try{$null=ConvertFrom-RelayUpdateManifest ($bad|ConvertTo-Json)}catch{$rejected=$true}
        Assert $rejected ('Accepted invalid manifest: '+($mutation|ConvertTo-Json -Compress))
    }
    $current=$offer.Clone();$current.versionCode=1
    Complete-Check $current
    Assert ($null -eq $state.Release -and $state.Checked) 'Current version offered an update'
    Complete-Check $offer
    Assert ($state.Release.versionCode -eq 2 -and $script:notifyIcon.Count -eq 1) 'New version did not notify'
    Complete-Check $offer
    Assert ($script:notifyIcon.Count -eq 1) 'Repeated notification for same release'
    Complete-Check $current
    Assert ($state.Release.versionCode -eq 2) 'Stale check removed a newer offer'
    $tampered=$offer.Clone();$tampered.sha256='b'*64
    Complete-Check $tampered
    Assert ($state.Error -and $state.Release.sha256 -eq ('a'*64)) 'Same-version replacement accepted'
    Complete-Check $null 'offline'
    Assert ($state.Error -eq 'offline' -and $state.Release.versionCode -eq 2) 'Offline failure lost existing release'
    Complete-Check $offer
    $script:relayUpdateState=$null
    Initialize-RelayUpdater
    $state=$script:relayUpdateState
    Complete-Check $offer
    Assert ($script:notifyIcon.Count -eq 1) 'Restart repeats dismissed notification'
    Set-RelayUpdateNotifications $false
    $next=$offer.Clone();$next.versionCode=3
    Complete-Check $next
    Assert ($script:notifyIcon.Count -eq 1) 'Disabled notifications still fired'
    Set-RelayUpdateNotifications $true
    Complete-Check $next
    Assert ($script:notifyIcon.Count -eq 2) 'Notification toggle did not restore notifications'

    # Click the real controls; replace only network/open side effects.
    function Start-RelayUpdateCheck {$script:manualChecks++}
    function Start-RelayUpdateDownload {$script:manualDownloads++}
    function Open-RelayUpdateDownload {$script:openedDownloads++}
    $script:manualChecks=0;$script:manualDownloads=0;$script:openedDownloads=0
    Show-RelayUpdates
    Show-RelayUpdates
    $forms=@([Windows.Forms.Application]::OpenForms | Where-Object Name -eq 'ClipRelayUpdates')
    Assert ($forms.Count -eq 1) 'Duplicate update window'
    $form=$forms[0]
    Assert ($form.FormBorderStyle -eq 'None') 'Native unthemed frame'
    Assert ($form.Controls['ReleaseNotes'].Text.Contains('新增更新提醒')) 'Release notes absent'
    $form.Controls['CheckUpdates'].PerformClick()
    $form.Controls['DownloadUpdate'].PerformClick()
    Assert ($script:manualChecks -eq 1 -and $script:manualDownloads -eq 1) 'Update buttons not connected'
    if($ScreenshotPath){
        [Windows.Forms.Application]::DoEvents()
        $bitmap=[Drawing.Bitmap]::new($form.Width,$form.Height)
        try{$form.DrawToBitmap($bitmap,[Drawing.Rectangle]::new(0,0,$form.Width,$form.Height));$bitmap.Save($ScreenshotPath,[Drawing.Imaging.ImageFormat]::Png)}finally{$bitmap.Dispose()}
    }
    $state.FilePath='download-fixture.zip'
    $form.Controls['DownloadUpdate'].PerformClick()
    Assert ($script:openedDownloads -eq 1) 'Downloaded package cannot be located'
    $form.Close()

    if($Network){
        # Real HTTPS bytes from the existing cloud service, without publishing a test release.
        $url='https://124-221-36-36.anyip.dev:8443/cliprelay/update.json'
        $check=[ClipRelay.UpdateTransfer]::Check($url);Wait-Transfer $check
        Assert (!$check.Error -and $check.Content.Contains('versionCode')) 'Cloud check failed'
        $bytes=[Text.Encoding]::UTF8.GetBytes($check.Content)
        $sha=[Security.Cryptography.SHA256]::Create()
        try{$digest=[BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}
        $path=Join-Path $temp 'download-fixture.json'
        $download=[ClipRelay.UpdateTransfer]::Download($url,$path,$bytes.Length,$digest);Wait-Transfer $download
        Assert (!$download.Error -and (Test-Path $path)) 'Verified HTTPS download failed'
        $badPath=Join-Path $temp 'bad-fixture.json'
        $bad=[ClipRelay.UpdateTransfer]::Download($url,$badPath,$bytes.Length,('0'*64));Wait-Transfer $bad
        Assert ($bad.Error -and !(Test-Path $badPath)) 'Bad hash was exposed as a completed download'
        $truncated=[ClipRelay.UpdateTransfer]::Download($url,$badPath,1,$digest);Wait-Transfer $truncated
        Assert ($truncated.Error -and !(Test-Path $badPath)) 'Wrong size accepted'
        Assert (@(Get-ChildItem $temp -Filter '*.partial').Count -eq 0) 'Partial download leaked'
        'PASS: real cloud HTTPS check/download, digest mismatch, size mismatch and partial cleanup.'
    }
    'PASS: manifest validation, version comparisons, notification persistence, offline recovery, themed UI and click actions.'
}
finally{
    Stop-RelayUpdater
    $env:LOCALAPPDATA=$oldLocal
    $resolved=[IO.Path]::GetFullPath($temp)
    $tempRoot=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')+'\'
    if($resolved.StartsWith($tempRoot,[StringComparison]::OrdinalIgnoreCase) -and (Split-Path $resolved -Leaf).StartsWith('cliprelay-updates-test-') -and (Test-Path $resolved)){
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}
