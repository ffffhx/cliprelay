[CmdletBinding()]
param([string]$ScreenshotPath='')

. "$PSScriptRoot/multi-peer-broadcast.ps1"
[Windows.Forms.Application]::SetUnhandledExceptionMode([Windows.Forms.UnhandledExceptionMode]::ThrowException)
Add-Type -Path "$PSScriptRoot/preview-state-server.cs"
foreach ($name in @('Show-PhonePreviewRemote','New-RelayBroadcastTargets','Get-EnabledRelayPeers','Get-PropertyValue')) {
    $functionAst = $ast.Find({
        param($node)
        $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name
    }, $true)
    Invoke-Expression $functionAst.Extent.Text
}
function Wait-Ui([scriptblock]$Condition, [string]$Message) {
    $deadline=[DateTime]::UtcNow.AddSeconds(7)
    do {
        [Windows.Forms.Application]::DoEvents()
        if (& $Condition) { return }
        Start-Sleep -Milliseconds 30
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "$Message Phase: $($phase.Text). Detail: $($status.Text). Latest error: $($Error | Select-Object -First 1)"
}
function Set-Reading($Server,[int]$Page,[int]$Count,[bool]$Active=$true,[bool]$Moving=$false) {
    $Server.StateCode=200
    $Server.StateBody=@{active=$Active;page=$Page;pageCount=$Count;contentType='text';moving=$Moving} | ConvertTo-Json -Compress
}
$script:previewRemoteForm=$null
$script:appIcon=$null
$phone=New-Object ClipRelayTests.PreviewStateServer
$other=New-Object ClipRelayTests.PreviewStateServer
$script:Peers=@(
    [pscustomobject]@{name='Reading phone';address='127.0.0.1';port=$phone.Port;accessToken='test-token';enabled=$false;platform='android'},
    [pscustomobject]@{name='Other phone';address='127.0.0.1';port=$other.Port;accessToken='other-token';enabled=$true;platform='android'},
    [pscustomobject]@{name='Windows PC';address='127.0.0.1';port=1;accessToken='';enabled=$true;platform='windows'}
)
try {
    Show-PhonePreviewRemote
    $form=$script:previewRemoteForm
    $picker=$form.Controls['PhonePreviewDevicePicker']
    $previous=$form.Controls['PreviousPreviewButton']; $next=$form.Controls['NextPreviewButton']
    $page=$form.Controls['PhonePreviewPageCard'].Controls['PhonePreviewPageLabel']
    $phase=$form.Controls['PhonePreviewPageCard'].Controls['PhonePreviewPhase']
    $status=$form.Controls['PhonePreviewStatus']
    if (!$form.Visible -or $form -isnot [ClipRelay.RelayForm] -or $picker.Items.Count -ne 2) { throw 'Themed phone selector is missing.' }
    Show-PhonePreviewRemote
    if ($script:previewRemoteForm -ne $form) { throw 'Opened a duplicate remote window.' }
    Wait-Ui { $page.Text -eq '3 / 8' -and $next.Enabled } 'Initial phone state was not displayed.'
    if ($phone.LastToken -ne 'test-token') { throw 'State request was not authenticated.' }
    Set-Reading $phone 4 8
    Wait-Ui { $page.Text -eq '4 / 8' } 'Manual phone navigation did not sync.'
    $next.PerformClick()
    Wait-Ui { $phone.NavigateRequests -eq 1 -and $next.Enabled } 'Navigation did not complete.'
    if (($phone.LastBody | ConvertFrom-Json).direction -ne 'previous' -or $page.Text -ne '4 / 8') { throw 'Next must request newer content without guessing the confirmed page.' }
    $previous.PerformClick()
    Wait-Ui { $phone.NavigateRequests -eq 2 -and $previous.Enabled } 'Previous navigation did not complete.'
    if (($phone.LastBody | ConvertFrom-Json).direction -ne 'next') { throw 'Previous must request older content.' }
    foreach ($key in @([Windows.Forms.Keys]::Left,[Windows.Forms.Keys]::Right)) {
        $requests=$phone.NavigateRequests
        $keyEvent=New-Object Windows.Forms.KeyEventArgs($key)
        $form.GetType().GetMethod('OnKeyDown',[Reflection.BindingFlags]'Instance,NonPublic').Invoke($form,[Windows.Forms.KeyEventArgs[]]@($keyEvent))
        Wait-Ui { $phone.NavigateRequests -eq ($requests+1) -and $next.Enabled } 'Arrow key navigation did not complete.'
        $expected=if ($key -eq [Windows.Forms.Keys]::Right) { 'previous' } else { 'next' }
        if (($phone.LastBody | ConvertFrom-Json).direction -ne $expected -or !$keyEvent.SuppressKeyPress) { throw 'Arrow keys must match the chronological button directions.' }
    }
    Set-Reading $phone 1 8
    Wait-Ui { $page.Text -eq '1 / 8' -and $previous.Enabled -and !$next.Enabled } 'Newest page must disable next.'
    Set-Reading $phone 1 1
    Wait-Ui { $page.Text -eq '1 / 1' -and !$previous.Enabled -and !$next.Enabled } 'Single-page state was not enforced.'
    Set-Reading $phone 8 8
    Wait-Ui { $page.Text -eq '8 / 8' -and !$previous.Enabled -and $next.Enabled } 'Oldest page must disable previous.'
    Set-Reading $phone 4 8 $true $true
    Wait-Ui { $page.Text -eq '4 / 8' -and !$previous.Enabled -and !$next.Enabled } 'Moving state accepted competing navigation.'
    Set-Reading $phone 0 0 $false
    Wait-Ui { $page.Text -eq '— / —' -and !$next.Enabled -and $phase.Text -like '*打开预览*' } 'Leaving preview retained a stale page.'
    $phone.StateCode=401
    Wait-Ui { $phase.Text -like '*密钥*' -and !$next.Enabled } 'Authentication failure was not explained.'
    $phone.StateCode=404
    Wait-Ui { $phase.Text -like '*更新*' -and $next.Enabled } 'Older phone lost navigation compatibility.'
    $phone.NavigateCode=409
    $next.PerformClick()
    Wait-Ui { $status.Text -like '*前台全屏预览*' } 'Inactive preview feedback missing.'
    $phone.StateCode=200; $phone.StateBody='not json'
    Wait-Ui { $phase.Text -eq '无法读取页码' -and !$next.Enabled } 'Malformed status was accepted.'

    Set-Reading $phone 7 9
    Wait-Ui { $page.Text -eq '7 / 9' } 'Status did not recover.'
    $phone.StateDelay=700
    $requests=$phone.StateRequests
    Wait-Ui { $phone.StateRequests -gt $requests } 'Delayed poll did not start.'
    Set-Reading $other 2 4
    $picker.SelectedIndex=1
    if ($page.Text -ne '— / —') { throw 'Switching phones retained the previous page.' }
    Wait-Ui { $page.Text -eq '2 / 4' -and $next.Enabled } 'Late response overwrote the selected phone.'
    if ($other.LastToken -ne 'other-token') { throw 'New phone used the wrong token.' }
    if ($ScreenshotPath) {
        $bitmap=New-Object Drawing.Bitmap($form.Width,$form.Height)
        try { $form.DrawToBitmap($bitmap,[Drawing.Rectangle]::new(0,0,$form.Width,$form.Height)); $bitmap.Save($ScreenshotPath) }
        finally { $bitmap.Dispose() }
    }
    $other.StateCode=503
    Wait-Ui { $phase.Text -eq '手机未连接' -and $page.Text -eq '— / —' -and !$next.Enabled } 'Disconnected phone retained live controls.'
    $form.Close()
    $script:Peers=@()
    Show-PhonePreviewRemote
    if ($script:previewRemoteForm -eq $form -or $script:previewRemoteForm.Controls['NextPreviewButton'].Enabled) { throw 'Empty-device reopen failed.' }
    'PASS: themed remote, authenticated live pages, phone swipes, boundaries, lifecycle, legacy phones, stale-response isolation, disconnect recovery and reopen.'
} finally {
    if ($null -ne $script:previewRemoteForm) { $script:previewRemoteForm.Close() }
    $phone.Dispose(); $other.Dispose()
}
