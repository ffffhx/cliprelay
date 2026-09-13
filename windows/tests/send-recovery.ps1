Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
    (Join-Path $PSScriptRoot '../cliprelay.ps1'), [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw $errors[0] }
foreach ($name in @('Get-PropertyValue','Get-NormalizedPeerAddress','Get-LocalRelayAddresses',
    'Test-IsLocalRelayPeer','Copy-RelayPeers','Remove-LocalRelayPeers','Merge-DiscoveredRelayDevices',
    'Get-EnabledRelayPeers','Invoke-RelayBroadcastWithRecovery')) {
    $fn = $ast.Find({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name }, $true)
    Invoke-Expression $fn.Extent.Text
}
function Assert($condition, $message) { if (-not $condition) { throw $message } }
function Find-ClipRelayDevices {
    param($TimeoutMilliseconds)
    $script:scans++
    if ($script:scanFails) { throw 'Discovery unavailable' }
    return $script:devices
}
function Save-PeerConfiguration {
    param($Peers, $Notifications)
    $script:saves++
    $script:Peers = @(Copy-RelayPeers $Peers)
}
$script:Port = 47632; $script:DeviceId = 'this-pc'; $script:Notifications = $false
function Reset-Scenario {
    $script:Peers = @(foreach ($id in @('phone','tablet')) {
        [pscustomobject]@{ id=$id; name='Same display name'; address="192.0.2.$(if ($id -eq 'phone') {1} else {2})";
            port=47632; accessToken='preserved-key'; enabled=$true; requiresAuth=$true; platform='android' }
    })
    $script:devices = @([pscustomobject]@{Id='phone';Name='Changed name';Address='192.0.2.99';Port=47633;RequiresAuth=$false;Platform='android'})
    $script:DiscoveryEnabled=$true; $script:scans=0; $script:saves=0; $script:calls=@()
    $script:scanFails=$false; $script:kind='ConnectFailure'; $script:status=0; $script:retryFails=$false
}
$send = {
    param($Peers)
    $script:calls += ,@($Peers | ForEach-Object { "$($_.id)@$($_.address):$($_.port)" })
    foreach ($peer in $Peers) {
        $ok = $peer.id -eq 'tablet' -or ($peer.address -eq '192.0.2.99' -and -not $script:retryFails)
        [pscustomobject]@{Success=$ok; StatusCode=$(if($ok){200}else{$script:status}); ErrorKind=$script:kind; Address=$peer.address}
    }
}
Reset-Scenario
$result = @(Invoke-RelayBroadcastWithRecovery -Peers $script:Peers -Send $send)
Assert ($result.Count -eq 2 -and $result[0].Success -and $result[1].Success) 'Recovery result order/success'
Assert ($script:calls.Count -eq 2 -and $script:calls[1].Count -eq 1 -and $script:calls[1][0] -eq 'phone@192.0.2.99:47633') 'Retry only changed failed target'
Assert ($script:Peers[0].accessToken -eq 'preserved-key' -and $script:Peers[0].name -eq 'Same display name') 'Preserve credentials and user label'
Assert ($script:saves -eq 1 -and $script:scans -eq 1) 'Persist and discover once'
foreach ($case in @('success','http','disabled','unknown-id','unchanged','scan-error','retry-error','probe','timeout')) {
    Reset-Scenario
    switch ($case) {
        'success' { $script:Peers[0].address='192.0.2.99' }
        'http' { $script:status=401; $script:kind='ProtocolError' }
        'disabled' { $script:DiscoveryEnabled=$false }
        'unknown-id' { $script:devices[0].Id='other-phone' }
        'unchanged' { $script:devices[0].Address='192.0.2.1';$script:devices[0].Port=47632 }
        'scan-error' { $script:scanFails=$true }
        'retry-error' { $script:retryFails=$true }
        'timeout' { $script:kind='Timeout' }
    }
    $result = @(Invoke-RelayBroadcastWithRecovery -Peers $script:Peers -Send $send -NoRecovery:($case -eq 'probe'))
    Assert ($result.Count -eq 2 -and $result[1].Success) "$case must retain successful tablet result"
    $expectedCalls = if ($case -in @('retry-error','timeout')) {2} else {1}
    Assert ($script:calls.Count -eq $expectedCalls) "$case unexpected retry count"
    if ($case -in @('success','http','disabled','probe')) { Assert ($script:scans -eq 0) "$case should not scan" }
}
Write-Host 'PASS: send recovery, identity, persistence, partial success, bounded retries and failure cases'
