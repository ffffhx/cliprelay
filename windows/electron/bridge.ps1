function Initialize-ElectronHost {
    param([string]$PipeName)
    Add-Type -Path (Join-Path $PSScriptRoot 'native-bridge.cs')
    $script:desktopHost = New-Object ClipRelay.DesktopHostBridge($PipeName)
    $script:desktopJobs = New-Object Collections.ArrayList
    $script:desktopRevision = 0
    # Only the Electron renderer shows windows. The native engine retains its
    # clipboard, hotkey, discovery and network implementations.
    function script:Show-PeerConfiguration { Send-ElectronWindow 'control-center' }
    function script:Show-RelayControlCenter { Send-ElectronWindow 'control-center' }
    function script:Show-ScreenSharing { param($Owner); Send-ElectronWindow 'screen-share-picker' }
    function script:Show-PhonePreviewRemote { Send-ElectronWindow 'preview-remote' }
    function script:Show-RemoteDesktopSettings { param($Owner); Send-ElectronWindow 'remote-desktop' }
    function script:Show-RemoteNetworkSettings { param($Owner); Send-ElectronWindow 'remote-network' }
    function script:Show-RelayUpdates { param($Owner); Send-ElectronWindow 'updates' }
    $script:desktopHostTimer = New-Object Windows.Forms.Timer
    $script:desktopHostTimer.Interval = 100
    $script:desktopHostTimer.Add_Tick({
        $close = $script:desktopHost.Disconnected
        while ($command = $script:desktopHost.Take()) {
            if ($command -eq 'quit') { $close = $true }
            elseif ($command -eq 'open' -and -not $close) { Show-PeerConfiguration }
            elseif ($command.StartsWith('{') -and -not $close) { Invoke-ElectronRequest $command }
        }
        foreach ($job in @($script:desktopJobs)) {
            if ($job.Task.IsCompleted) {
                try {
                    $value = $job.Task.GetAwaiter().GetResult()
                    if ($job.Action -eq 'remote') { $value = $value | ConvertFrom-Json }
                    Send-ElectronReply $job.Id $value
                } catch { Send-ElectronReply $job.Id $null $_.Exception.Message }
                $script:desktopJobs.Remove($job)
            }
        }
        if ($close) {
            $script:stopRequested = $true
            # End modal dialogs too; otherwise their nested message loops can
            # outlive Electron and leave a hidden receiver behind.
            $script:desktopHostTimer.Stop()
            foreach ($window in @([Windows.Forms.Application]::OpenForms)) { $window.Close() }
        }
    })
    $script:desktopHostTimer.Start()
}

function Send-ElectronWindow([string]$Name) {
    $script:desktopHost.Send((@{event='open';window=$Name} | ConvertTo-Json -Compress))
}

function Send-ElectronReply($Id, $Data, [string]$ErrorText = '') {
    $script:desktopHost.Send((@{id=$Id;ok=(!$ErrorText);data=$Data;error=$ErrorText} | ConvertTo-Json -Depth 18 -Compress))
}

function Get-ElectronSnapshot {
    return @{
        revision=$script:desktopRevision
        runtime=(Get-RelayRuntimeSnapshot); addresses=@(Get-LocalShareableAddresses)
        config=@{peers=@($script:Peers);port=$script:Port;deviceId=$script:DeviceId;deviceName=$script:DeviceName;notifications=$script:Notifications;accessToken=$script:AccessToken;discoveryEnabled=$script:DiscoveryEnabled;startupEnabled=(Test-StartupRegistration)}
        sharing=(Get-ScreenSharingView); update=(Get-RelayUpdateSnapshot)
    }
}

function Save-ElectronConfiguration($Config) {
    $null = Save-PeerConfiguration -PeerAddress '' -Peers @($Config.peers) -ListenPort ([int]$Config.port) -Notifications ([bool]$Config.notifications) -AccessToken ([string]$Config.accessToken) -StartupEnabled ([bool]$Config.startupEnabled) -DiscoveryEnabled ([bool]$Config.discoveryEnabled) -DeviceName ([string]$Config.deviceName)
    $script:desktopRevision++
}

function Invoke-ElectronRequest([string]$Json) {
    $request = $null
    try {
        $request = $Json | ConvertFrom-Json
        $data = $request.data
        $result = $null
        $task = $null
        switch ($request.action) {
            'snapshot' { $result = Get-ElectronSnapshot }
            'save' { Save-ElectronConfiguration $data; $result = Get-ElectronSnapshot }
            'patch' {
                $config = (Get-ElectronSnapshot).config
                if ($null -ne $data.PSObject.Properties['expectedRevision'] -and [int]$data.expectedRevision -ne $script:desktopRevision) { throw '设备列表已改变，请重试。' }
                foreach ($property in $data.PSObject.Properties) {
                    if ($property.Name -eq 'expectedRevision') { continue }
                    if ($property.Name -notin @('peers','port','deviceName','notifications','accessToken','discoveryEnabled','startupEnabled')) { throw 'Invalid setting.' }
                    $config[$property.Name] = $property.Value
                }
                Save-ElectronConfiguration ([pscustomobject]$config)
                $result = Get-ElectronSnapshot
            }
            'normalize-peer' { $result = @(Get-NormalizedRelayPeers -Peers @($data) -DefaultPort $script:Port -DefaultAccessToken $script:AccessToken)[0] }
            'discover' { $task = Start-ClipRelayDeviceDiscovery }
            'merge' { $result = Merge-DiscoveredRelayDevices -Peers @($data.peers) -DiscoveredDevices @($data.devices) -DefaultPort $script:Port -DefaultAccessToken '' -LocalDeviceId $script:DeviceId -ExistingOnly:(-not [bool]$data.addNew) }
            'probe' { $task = Start-RelayPeersConnectivityTest -Peers @($data.peers) }
            'summary' { $result = Get-RelayDeliverySummary -Results @($data.results) -Kind '检测' }
            'copy' { Set-ClipboardTextWithRetry -Text ([string]$data.text) }
            'share' { $result = Invoke-ScreenShareCommand -Command @{action='start';peer=$data.peer;localPort=$script:Port;localName=$script:DeviceName} }
            'stop-sharing' { $result = Invoke-ScreenShareCommand -Command @{action='stop-sending'} -NoStart }
            'preview-state' { $targets = @(New-RelayBroadcastTargets -Peers @($data.peer) -IncludeDisabled); $task = [ClipRelay.RelayBroadcaster]::GetPreviewStateAsync($targets[0],1500) }
            'preview-navigate' {
                if ($data.direction -notin @('previous','next')) { throw 'Invalid direction.' }
                $targets = @(New-RelayBroadcastTargets -Peers @($data.peer) -IncludeDisabled)
                $direction = if ($data.direction -eq 'next') { 'previous' } else { 'next' }
                $task = [ClipRelay.RelayBroadcaster]::NavigatePreviewAsync($targets,$direction,1500)
            }
            'remote' {
                if ($data.action -notin @('status','pairings','clients','enable','disable','pair','lanPairApprove','unpair','disconnect','networkStatus','networkCode','networkApprove','networkRevoke','networkEnable','networkDisable')) { throw 'Unknown remote action.' }
                if (-not ('ClipRelay.Remote.ControlClient' -as [type])) { Add-Type -Path (Join-Path (Split-Path $PSScriptRoot) 'remote-desktop\remote-client.cs') }
                $task = [ClipRelay.Remote.ControlClient]::RequestAsync(($data | ConvertTo-Json -Compress))
            }
            'update-check' { Start-RelayUpdateCheck }
            'update-download' { Start-RelayUpdateDownload }
            'update-open' { Open-RelayUpdateDownload }
            'update-notify' { Set-RelayUpdateNotifications -Enabled ([bool]$data.enabled) }
            default { throw 'Unknown desktop action.' }
        }
        if ($null -ne $task) { [void]$script:desktopJobs.Add(@{Id=$request.id;Action=$request.action;Task=$task}) }
        else { Send-ElectronReply $request.id $result }
    } catch {
        if ($null -ne $request) { Send-ElectronReply $request.id $null $_.Exception.Message }
    }
}

function Stop-ElectronHost {
    param([bool]$Restart)
    $script:desktopHostTimer.Stop()
    $script:desktopHostTimer.Dispose()
    $script:desktopHost.Send($(if ($Restart) { 'restart' } else { 'exit' }))
    $script:desktopHost.Dispose()
}
