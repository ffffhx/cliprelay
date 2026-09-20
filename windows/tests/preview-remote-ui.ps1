[CmdletBinding()]
param()

# Reuse the loopback HTTP fixture and compiled production sender.
. "$PSScriptRoot/multi-peer-broadcast.ps1"
foreach ($name in @("Show-PhonePreviewRemote", "New-RelayBroadcastTargets")) {
    $functionAst = $ast.Find({
        param($node)
        $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name
    }, $true)
    Invoke-Expression $functionAst.Extent.Text
}
function Get-EnabledRelayPeers { param([object[]]$Peers) return $Peers }
$script:previewRemoteForm = $null
$remote = New-Object ClipRelayTests.OneShotHttpServer(409, 0)
$script:Peers = @([pscustomobject]@{
    name = 'Test phone'; address = '127.0.0.1'; port = $remote.Port; accessToken = 'test-token'; enabled = $true
})
try {
    Show-PhonePreviewRemote
    $form = $script:previewRemoteForm
    if (-not $form.Visible) { throw 'Remote window did not open modelessly.' }
    Show-PhonePreviewRemote
    if ($script:previewRemoteForm -ne $form) { throw 'Opened a duplicate remote window.' }
    $buttons = @($form.Controls | Where-Object { $_ -is [System.Windows.Forms.Button] })
    $buttons[1].PerformClick()
    $deadline = [DateTime]::UtcNow.AddSeconds(5)
    while (-not $buttons[1].Enabled -and [DateTime]::UtcNow -lt $deadline) {
        [System.Windows.Forms.Application]::DoEvents()
        Start-Sleep -Milliseconds 20
    }
    if (-not $buttons[1].Enabled) { throw 'Remote response did not restore controls.' }
    $payload = [Text.Encoding]::UTF8.GetString($remote.Body) | ConvertFrom-Json
    if ($payload.direction -ne 'next' -or $remote.Token -ne 'test-token') { throw 'Button sent incorrect command.' }
    $label = $form.Controls | Where-Object { $_ -is [System.Windows.Forms.Label] }
    if ($label.Text -notlike '*全屏预览*') { throw 'Missing inactive preview feedback.' }
    $form.Close()
    Show-PhonePreviewRemote
    if ($script:previewRemoteForm -eq $form) { throw 'Could not reopen remote window.' }
    Write-Output 'PASS: modeless remote window, authenticated button delivery, inactive feedback and reopen.'
} finally {
    if ($null -ne $script:previewRemoteForm) { $script:previewRemoteForm.Close() }
    $remote.Dispose()
}
