[CmdletBinding()]
param()
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$clientPath = Join-Path $PSScriptRoot '../cliprelay.ps1'
$source = Get-Content -LiteralPath $clientPath -Raw -Encoding UTF8
$code = [regex]::Match($source, '\$clipRelaySource = @"\r?\n(?<code>.*?)\r?\n"@', 'Singleline').Groups['code'].Value
Add-Type -TypeDefinition $code -ReferencedAssemblies System.dll,System.Core.dll,System.Drawing.dll,System.Windows.Forms.dll
# Reuse the real delayed HTTP fixture used by the broadcast protocol tests.
$fixture = Get-Content (Join-Path $PSScriptRoot 'multi-peer-broadcast.ps1') -Raw -Encoding UTF8
$code = [regex]::Match($fixture, 'Add-Type -TypeDefinition @"\r?\n(?<code>.*?)\r?\n"@', 'Singleline').Groups['code'].Value
Add-Type -TypeDefinition $code -ReferencedAssemblies System.dll,System.Core.dll
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($clientPath, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw $errors[0] }
foreach ($name in @('Get-PropertyValue','Copy-RelayPeers','Get-EnabledRelayPeers','Get-RelayPeerRouteSignature',
    'New-RelayBroadcastTargets','Get-RelayDeliveryFailureText','Get-RelayDeliverySummary','Get-RelayFailedIndexes',
    'Add-RelayTransfer','Start-RelayTransferTask','Complete-RelayTransfer','Update-RelayTransfers',
    'Read-HttpRequest','Send-HttpResponse','Handle-Client','Initialize-RelayRequestReaders',
    'Start-RelayRequestRead','Update-RelayRequestReads','Stop-RelayRequestReaders','Process-WindowsMessages',
    'Get-NormalizedPeerAddress','Get-LocalRelayAddresses','Test-IsLocalRelayPeer','Remove-LocalRelayPeers',
    'Merge-DiscoveredRelayDevices','Get-RelayRecoveryPlan')) {
    $fn = $ast.Find({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name}, $true)
    if ($null -eq $fn) { throw "Missing function $name" }
    Invoke-Expression $fn.Extent.Text
}
function Assert($condition, $message) { if (-not $condition) { throw $message } }
function Show-ClipRelayNotification { param($Title,$Message,$Icon) }
function Set-ClipboardTextWithRetry { param($Text) $script:receivedText = $Text }
function Set-LastTransferStatus {
    param($State,$Kind,$Detail,$Results)
    $script:lastStatus = [pscustomobject]@{State=$State;Kind=$Kind;Detail=$Detail;Results=$Results}
}
$script:transferQueue = New-Object System.Collections.Queue
$script:activeTransfer = $null
$script:requestReaders = New-Object System.Collections.ArrayList
$script:requestReaderPool = $null
$script:DiscoveryEnabled = $false
$script:Notifications = $false
$script:AccessToken = ''
$script:lastSentClipboardText = $null
$script:lastSentClipboardPeer = $null
$script:lastSentClipboardAtUtc = [DateTime]::MinValue
$script:clipboardDuplicateWindowMilliseconds = 1000
$script:lastStatus = $null
$script:receivedText = $null
$script:clicks = 0
$form = New-Object Windows.Forms.Form
$form.Text = 'ClipRelay responsiveness test'
$button = New-Object Windows.Forms.Button
$form.Controls.Add($button)
$button.Add_Click({ $script:clicks++ })
$timer = New-Object Windows.Forms.Timer
$timer.Interval = 40
$timer.Add_Tick({ $button.PerformClick() })
$servers = New-Object System.Collections.ArrayList
$senders = New-Object System.Collections.ArrayList
$listener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, 0)
function Tick {
    Process-WindowsMessages
    Update-RelayTransfers
    Update-RelayRequestReads
    Start-Sleep -Milliseconds 10
}
function Wait-Until([scriptblock]$Condition, [int]$Milliseconds = 8000) {
    $deadline = [DateTime]::UtcNow.AddMilliseconds($Milliseconds)
    while (-not (& $Condition)) {
        if ([DateTime]::UtcNow -gt $deadline) { throw 'Test timed out.' }
        Tick
    }
}
function Set-TestPeer([int]$Port) {
    $script:Peers = @([pscustomobject]@{id='test';name='test';address='127.0.0.1';port=$Port;accessToken='';enabled=$true})
}
function Connect-Reader([string]$Request) {
    $sender = New-Object Net.Sockets.TcpClient
    $sender.Connect([Net.IPAddress]::Loopback, ([Net.IPEndPoint]$listener.LocalEndpoint).Port)
    $null = $senders.Add($sender)
    $receiver = $listener.AcceptTcpClient()
    $bytes = [Text.Encoding]::UTF8.GetBytes($Request)
    $sender.GetStream().Write($bytes, 0, $bytes.Length)
    Start-RelayRequestRead -Client $receiver
    return $sender
}
try {
    $form.Show()
    $timer.Start()
    Initialize-RelayRequestReaders
    $listener.Start()
    # A peer holds its response for 1.2 s. UI clicks must be delivered before it responds.
    $server = New-Object ClipRelayTests.OneShotHttpServer(200, 1200)
    $null = $servers.Add($server)
    Set-TestPeer $server.Port
    Add-RelayTransfer -Kind TEXT -Text 'first copy'
    $watch = [Diagnostics.Stopwatch]::StartNew()
    Update-RelayTransfers
    Assert ($watch.ElapsedMilliseconds -lt 500) 'Starting a transfer blocked the UI.'
    $before = $script:clicks
    Wait-Until { $script:clicks -ge $before + 3 } 1000
    Assert ($null -ne $script:activeTransfer) 'Clicks were only processed after the slow transfer finished.'
    Wait-Until { $null -eq $script:activeTransfer }
    Assert ($script:lastStatus.State -eq 'success') 'Background text delivery failed.'
    # A duplicate copy must not open another network connection.
    $script:lastSentClipboardAtUtc = [DateTime]::UtcNow
    Add-RelayTransfer -Kind TEXT -Text 'first copy'
    Update-RelayTransfers
    Assert ($null -eq $script:activeTransfer) 'Background clipboard deduplication was lost.'
    # A nonresponsive peer times out while the button continues receiving clicks.
    $server = New-Object ClipRelayTests.OneShotHttpServer(200, 5500)
    $null = $servers.Add($server)
    Set-TestPeer $server.Port
    Add-RelayTransfer -Kind TEXT -Text 'timeout copy'
    Update-RelayTransfers
    $before = $script:clicks
    Wait-Until { $null -eq $script:activeTransfer }
    Assert ($script:lastStatus.State -eq 'error' -and $script:clicks -gt $before + 20) 'Network timeout froze the UI or did not surface failure.'
    # The image task uses the same nonblocking path and preserves size headers.
    $server = New-Object ClipRelayTests.OneShotHttpServer(200, 500)
    $null = $servers.Add($server)
    Set-TestPeer $server.Port
    $frame = New-Object ClipRelay.ScreenshotFrame([byte[]]@(255,216,255,217), 2, 3)
    $transfer = [pscustomobject]@{Kind='IMAGE';Frame=$frame}
    $task = Start-RelayTransferTask -Transfer $transfer -Peers $script:Peers
    $before = $script:clicks
    Wait-Until { $task.IsCompleted }
    Assert ($task.GetAwaiter().GetResult()[0].Success -and $server.Width -eq '2' -and $server.Height -eq '3' -and
        $script:clicks -ge $before + 3) 'Image delivery blocked UI dispatch or lost headers.'
    # An incomplete header and incomplete body must not block a third valid request or UI clicks.
    $null = Connect-Reader "POST /push HTTP/1.1`r`n"
    $null = Connect-Reader "POST /push HTTP/1.1`r`nContent-Length: 100`r`n`r`n{"
    $body = '{"text":"background receive"}'
    $sender = Connect-Reader "POST /push HTTP/1.1`r`nContent-Length: $($body.Length)`r`n`r`n$body"
    $before = $script:clicks
    Wait-Until { $script:receivedText -eq 'background receive' -and $script:clicks -gt $before + 2 } 2000
    Assert ($script:requestReaders.Count -eq 2) 'Stalled sockets unexpectedly prevented normal receiving.'
    $buffer = New-Object byte[] 1024
    $sender.ReceiveTimeout = 1000
    $count = $sender.GetStream().Read($buffer, 0, $buffer.Length)
    Assert ([Text.Encoding]::ASCII.GetString($buffer,0,$count).StartsWith('HTTP/1.1 200')) 'Background receive did not return HTTP 200.'
    $watch.Restart()
    Stop-RelayRequestReaders
    Assert ($watch.ElapsedMilliseconds -lt 1500) 'Shutdown waited for stalled clients.'
    # Controlled async completion exercises the send/discover/retry boundary:
    # an already successful device must never receive the copy twice.
    function Get-LocalRelayAddresses { return @('127.0.0.1') }
    function Save-PeerConfiguration { param($Peers,$Notifications) $script:Peers = @(Copy-RelayPeers $Peers) }
    $script:Port = 47632; $script:DeviceId = 'this-pc'; $script:DiscoveryEnabled = $true
    $script:Peers = @(foreach ($id in @('phone','tablet')) {
        [pscustomobject]@{id=$id;name=$id;address="192.0.2.$(if($id -eq 'phone'){1}else{2})";port=47632;accessToken='key';enabled=$true}
    })
    $initial = New-Object 'System.Threading.Tasks.TaskCompletionSource[ClipRelay.RelayDeliveryResult[]]'
    $retry = New-Object 'System.Threading.Tasks.TaskCompletionSource[ClipRelay.RelayDeliveryResult[]]'
    $script:discovery = New-Object 'System.Threading.Tasks.TaskCompletionSource[ClipRelay.DiscoveredDevice[]]'
    $script:tasks = New-Object System.Collections.Queue
    $script:tasks.Enqueue($initial.Task); $script:tasks.Enqueue($retry.Task)
    $script:sentTo = @()
    function Start-RelayTransferTask {
        param($Transfer,$Peers)
        $script:sentTo += ,@(Copy-RelayPeers $Peers)
        return $script:tasks.Dequeue()
    }
    function Start-ClipRelayDeviceDiscovery { param($TimeoutMilliseconds) return $script:discovery.Task }
    $failed = New-Object ClipRelay.RelayDeliveryResult -Property @{Name='phone';Address='192.0.2.1';Success=$false;StatusCode=0;ErrorKind='Timeout'}
    $ok = New-Object ClipRelay.RelayDeliveryResult -Property @{Name='tablet';Address='192.0.2.2';Success=$true;StatusCode=200}
    Add-RelayTransfer -Kind TEXT -Text 'recover copy'
    Update-RelayTransfers
    $initial.SetResult([ClipRelay.RelayDeliveryResult[]]@($failed,$ok))
    Update-RelayTransfers
    Assert ($script:activeTransfer.Phase -eq 'discover') 'Failed asynchronous send did not begin discovery.'
    $before = $script:clicks
    Wait-Until { $script:clicks -ge $before + 3 } 1000
    $device = New-Object ClipRelay.DiscoveredDevice -Property @{Id='phone';Name='phone';Address='192.0.2.99';Port=47633}
    $script:discovery.SetResult([ClipRelay.DiscoveredDevice[]]@($device))
    Update-RelayTransfers
    Assert ($script:activeTransfer.Phase -eq 'retry' -and $script:sentTo.Count -eq 2 -and
        $script:sentTo[1].Count -eq 1 -and $script:sentTo[1][0].address -eq '192.0.2.99') 'Recovery retried the wrong devices.'
    $recovered = New-Object ClipRelay.RelayDeliveryResult -Property @{Name='phone';Address='192.0.2.99';Success=$true;StatusCode=200}
    $retry.SetResult([ClipRelay.RelayDeliveryResult[]]@($recovered))
    Update-RelayTransfers
    Assert ($null -eq $script:activeTransfer -and $script:lastStatus.State -eq 'success' -and
        $script:lastStatus.Results.Count -eq 2 -and $script:Peers[0].port -eq 47633) 'Recovery lost partial success or the saved endpoint.'
    Write-Output "PASS: delayed sends, timeout, images, duplicate suppression, async recovery, stalled HTTP clients and UI clicks ($script:clicks clicks)."
}
finally {
    Stop-RelayRequestReaders
    $timer.Stop(); $timer.Dispose(); $form.Dispose()
    foreach ($sender in $senders) { $sender.Dispose() }
    $listener.Stop()
    foreach ($server in $servers) { $server.Dispose() }
}
