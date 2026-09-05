[CmdletBinding()]
param(
    [string]$ScreenshotPath = "",
    [string]$ExpandedScreenshotPath = ""
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Application]::SetUnhandledExceptionMode(
    [System.Windows.Forms.UnhandledExceptionMode]::ThrowException
)

$clientPath = Join-Path (Split-Path -Parent $PSScriptRoot) "cliprelay.ps1"
$source = Get-Content -LiteralPath $clientPath -Raw -Encoding UTF8
$sourceMatch = [regex]::Match(
    $source,
    '\$clipRelaySource = @"\r?\n(?<code>.*?)\r?\n"@',
    [System.Text.RegularExpressions.RegexOptions]::Singleline
)
if (-not $sourceMatch.Success) {
    throw "ClipRelay C# source block was not found."
}
Add-Type -TypeDefinition $sourceMatch.Groups["code"].Value -ReferencedAssemblies @(
    "System.dll",
    "System.Core.dll",
    "System.Drawing.dll",
    "System.Windows.Forms.dll"
)

$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
    $clientPath,
    [ref]$tokens,
    [ref]$parseErrors
)
if ($parseErrors.Count -gt 0) {
    throw "cliprelay.ps1 has parse errors: $($parseErrors[0].Message)"
}

# GetNewClosure creates a dynamic module. Assigning a script-scoped variable
# inside one writes to that private module instead of ClipRelay's script state.
$closureScriptWrites = @()
$closureInvocations = @($ast.FindAll({
    param($node)
    $node -is [System.Management.Automation.Language.InvokeMemberExpressionAst] -and
        $node.Member.Value -eq "GetNewClosure"
}, $true))
foreach ($closureInvocation in $closureInvocations) {
    $assignments = @($closureInvocation.FindAll({
        param($node)
        $node -is [System.Management.Automation.Language.AssignmentStatementAst]
    }, $true))
    foreach ($assignment in $assignments) {
        $scriptVariables = @($assignment.Left.FindAll({
            param($node)
            $node -is [System.Management.Automation.Language.VariableExpressionAst] -and
                $node.VariablePath.IsScript
        }, $true))
        foreach ($scriptVariable in $scriptVariables) {
            $closureScriptWrites += "$($scriptVariable.Extent.Text) at line $($scriptVariable.Extent.StartLineNumber)"
        }
    }
}
if ($closureScriptWrites.Count -gt 0) {
    throw "GetNewClosure contains unsafe script-scoped writes: $($closureScriptWrites -join ', ')"
}

foreach ($functionName in @(
    "Get-PropertyValue", "Get-NormalizedPeerAddress", "Get-LocalRelayAddresses",
    "Test-IsLocalRelayPeer", "Copy-RelayPeers", "Remove-LocalRelayPeers",
    "Merge-DiscoveredRelayDevices", "Show-RelayControlCenter"
)) {
    $functionAst = $ast.Find({
        param($node)
        $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
            $node.Name -eq $functionName
    }, $true)
    if ($null -eq $functionAst) { throw "Function not found: $functionName" }
    Invoke-Expression $functionAst.Extent.Text
}

$script:configurationDialogOpen = $false
$script:configurationForm = $null
$script:Port = 47632
$script:Peer = "192.168.1.9"
$script:Notifications = $true
$script:AccessToken = ""
$script:DeviceId = "local-device-id"
$script:DeviceName = "Test PC"
$script:DiscoveryEnabled = $true
$script:appIcon = $null
$script:Peers = @(
    [PSCustomObject]@{
        id = "phone"
        name = "phone"
        address = "192.168.1.9"
        port = 47632
        accessToken = ""
        enabled = $true
    },
    [PSCustomObject]@{
        id = "computer"
        name = "office PC"
        address = "192.168.1.20"
        port = 47632
        accessToken = ""
        enabled = $true
    },
    [PSCustomObject]@{
        id = "tablet"
        name = "backup tablet"
        address = "192.168.1.30"
        port = 47632
        accessToken = ""
        enabled = $true
    }
)
$script:connectivityTaskSource = New-Object 'System.Threading.Tasks.TaskCompletionSource[ClipRelay.RelayDeliveryResult[]]'
$script:discoveryTaskSource = New-Object 'System.Threading.Tasks.TaskCompletionSource[ClipRelay.DiscoveredDevice[]]'
$script:lastProbedPeers = @()
$script:probeCallCount = 0
$script:editorResult = $null
$script:editorSelectedPeer = $null
$script:saveCallCount = 0
$script:lastSavedNotifications = $null
$script:lastSavedPeers = @()

function Get-LocalShareableAddresses {
    return @(
        [PSCustomObject]@{ Address = "uckf.local"; Display = "uckf.local" },
        [PSCustomObject]@{ Address = "192.168.1.42"; Display = "192.168.1.42" }
    )
}

function Test-StartupRegistration { return $true }
function Set-ClipboardTextWithRetry { param([string]$Text) }
function Start-ClipRelayDeviceDiscovery {
    param([int]$TimeoutMilliseconds)
    return $script:discoveryTaskSource.Task
}
function Test-PeerConnectivity {
    param([string]$Address, [int]$Port, [int]$TimeoutMilliseconds, [string]$AccessToken)
    return "ok"
}
function Test-RelayPeersConnectivity {
    param([object[]]$Peers, [int]$TimeoutMilliseconds)
    return [PSCustomObject]@{
        State = "success"
        Detail = "probe delivered to 3/3 devices"
        SuccessCount = 3
        FailureCount = 0
        TotalCount = 3
        Results = @()
    }
}
function Start-RelayPeersConnectivityTest {
    param([object[]]$Peers, [int]$TimeoutMilliseconds)
    $script:probeCallCount++
    $script:lastProbedPeers = @(Copy-RelayPeers -Peers $Peers)
    return $script:connectivityTaskSource.Task
}
function Get-RelayDeliverySummary {
    param([ClipRelay.RelayDeliveryResult[]]$Results, [string]$Kind)
    $allResults = @($Results)
    $successCount = @($allResults | Where-Object Success).Count
    return [PSCustomObject]@{
        State = "partial"
        Detail = "probe delivered to $successCount/$($allResults.Count) devices"
        SuccessCount = $successCount
        FailureCount = $allResults.Count - $successCount
        TotalCount = $allResults.Count
        Results = $allResults
    }
}
function Show-RelayPeerEditor {
    param($Owner, $Peer, [int]$DefaultPort, [string]$DefaultAccessToken)
    $script:editorSelectedPeer = $Peer
    $result = $script:editorResult
    $script:editorResult = $null
    return $result
}
function Save-PeerConfiguration {
    param(
        [string]$PeerAddress,
        [bool]$Notifications,
        [int]$ListenPort,
        [string]$AccessToken,
        [bool]$StartupEnabled,
        [object[]]$Peers,
        [bool]$DiscoveryEnabled,
        [string]$DeviceName
    )
    $script:saveCallCount++
    $script:lastSavedNotifications = $Notifications
    $script:lastSavedPeers = @($Peers)
    $script:Peers = @(Copy-RelayPeers -Peers $Peers)
    return $PeerAddress
}
function Get-RelayRuntimeSnapshot {
    return [PSCustomObject]@{
        State = "success"
        Kind = "TEXT"
        Detail = "文本已发送到 192.168.1.9"
        At = [DateTime]::Now
        Port = 47632
        Peer = "192.168.1.9"
        ScreenshotHotkeyAvailable = $true
    }
}
function Show-ClipRelayNotification {
    param([string]$Title, [string]$Message)
}

Show-RelayControlCenter
for ($attempt = 0; $attempt -lt 20; $attempt++) {
    [System.Windows.Forms.Application]::DoEvents()
    Start-Sleep -Milliseconds 50
}

$openForms = [System.Windows.Forms.Application]::OpenForms
$form = if ($openForms.Count -gt 0) { $openForms[0] } else { $null }
if ($null -eq $form) {
    $openFormSummary = @([System.Windows.Forms.Application]::OpenForms | ForEach-Object {
        "$($_.GetType().FullName):$($_.Text)"
    }) -join ", "
    $errorSummary = @($Error | Select-Object -First 5 | ForEach-Object { $_.Exception.Message }) -join " | "
    throw "The relay control center did not open. Open forms: $openFormSummary. Errors: $errorSummary"
}
if ($form.ClientSize.Width -lt 600 -or $form.ClientSize.Height -lt 700) {
    throw "The relay control center is unexpectedly small: $($form.ClientSize). Errors: $($Error | Select-Object -First 3)"
}
$testPeersButton = @($form.Controls.Find("TestPeersButton", $true)) | Select-Object -First 1
if ($null -eq $testPeersButton -or $testPeersButton.Enabled) {
    throw "The background connectivity check did not start without blocking the control center."
}

$largeHeader = @($form.Controls | Where-Object {
    $_ -is [System.Windows.Forms.Label] -and $_.Font.Size -ge 16
}) | Select-Object -First 1
if ($null -eq $largeHeader -or -not $largeHeader.Visible) {
    throw "The primary device-link heading is not visible."
}

$minimizeButton = $form.Controls["MinimizeButton"]
if ($null -eq $minimizeButton -or -not $minimizeButton.Visible) {
    throw "The control center does not expose a visible minimize button."
}
$minimizeButton.PerformClick()
[System.Windows.Forms.Application]::DoEvents()
if ($form.WindowState -ne [System.Windows.Forms.FormWindowState]::Minimized) {
    throw "The minimize button did not minimize the control center."
}
Show-RelayControlCenter
[System.Windows.Forms.Application]::DoEvents()
if ($form.WindowState -ne [System.Windows.Forms.FormWindowState]::Normal -or -not $form.Visible) {
    throw "Reopening the control center did not restore its minimized window."
}
if ($script:probeCallCount -ne 0) { throw "Connectivity was probed before discovery finished." }
$movedPhone = New-Object ClipRelay.DiscoveredDevice
$movedPhone.Id = "phone"
$movedPhone.Name = "Phone advertised name"
$movedPhone.Address = "192.168.1.8"
$movedPhone.Port = 47633
$unknownPhone = New-Object ClipRelay.DiscoveredDevice
$unknownPhone.Id = "unknown-phone"
$unknownPhone.Name = "phone"
$unknownPhone.Address = "192.168.1.9"
$unknownPhone.Port = 47632
$script:discoveryTaskSource.SetResult([ClipRelay.DiscoveredDevice[]]@($unknownPhone, $movedPhone))
for ($attempt = 0; $attempt -lt 50 -and $script:probeCallCount -eq 0; $attempt++) {
    [System.Windows.Forms.Application]::DoEvents()
    Start-Sleep -Milliseconds 20
}
if ($script:probeCallCount -ne 1 -or $script:saveCallCount -ne 1 -or
    $script:lastSavedPeers[0].address -ne "192.168.1.8" -or
    $script:lastProbedPeers[0].address -ne "192.168.1.8" -or
    $script:lastProbedPeers[0].port -ne 47633 -or
    $script:lastProbedPeers[0].name -ne "phone" -or @($script:lastProbedPeers).Count -ne 3 -or
    $testPeersButton.Enabled) {
    throw "The check did not save the moved device's endpoint before probing the existing devices."
}
$availableResult = New-Object ClipRelay.RelayDeliveryResult
$availableResult.Name = "phone"
$availableResult.Address = "192.168.1.8:47633"
$availableResult.Success = $true
$unavailableResult = New-Object ClipRelay.RelayDeliveryResult
$unavailableResult.Name = "backup tablet"
$unavailableResult.Address = "192.168.1.30:47632"
$unavailableResult.Success = $false
$secondAvailableResult = New-Object ClipRelay.RelayDeliveryResult
$secondAvailableResult.Name = "office PC"
$secondAvailableResult.Address = "192.168.1.20:47632"
$secondAvailableResult.Success = $true
$script:connectivityTaskSource.SetResult(
    [ClipRelay.RelayDeliveryResult[]]@($availableResult, $secondAvailableResult, $unavailableResult)
)
for ($attempt = 0; $attempt -lt 50 -and -not $testPeersButton.Enabled; $attempt++) {
    [System.Windows.Forms.Application]::DoEvents()
    Start-Sleep -Milliseconds 20
}
if (-not $testPeersButton.Enabled) {
    throw "The completed background connectivity check did not update the control center."
}

function Find-Control {
    param([string]$Name)
    return @($form.Controls.Find($Name, $true)) | Select-Object -First 1
}
function Wait-Check {
    for ($attempt = 0; $attempt -lt 100 -and -not $testPeersButton.Enabled; $attempt++) {
        [System.Windows.Forms.Application]::DoEvents()
        Start-Sleep -Milliseconds 20
    }
    if (-not $testPeersButton.Enabled) { throw "The check did not finish." }
}
$peerCountLabel = Find-Control "PeerCountLabel"
$onlineStatusLabel = Find-Control "OnlineStatusLabel"
$peerDetailsPanel = Find-Control "PeerDetailsPanel"
$addPeerButton = Find-Control "AddPeerButton"
$scanPeersButton = Find-Control "ScanPeersButton"
$notificationToggle = Find-Control "NotificationToggle"
$autoSaveStatusLabel = Find-Control "AutoSaveStatusLabel"
if ($null -ne (Find-Control "ManagePeersButton") -or $null -ne (Find-Control "PeerSummaryToggleButton")) {
    throw "The control center still requires a separate manager or expanding the device list."
}
if (-not $peerDetailsPanel.Visible -or -not $peerDetailsPanel.AutoScroll -or
    $null -eq $addPeerButton -or $null -eq $scanPeersButton -or
    @($peerDetailsPanel.Controls | Where-Object Name -like 'PeerRow*').Count -ne 3) {
    throw "The complete device roster and inline management controls are not visible."
}
if ($peerCountLabel.Text -notmatch '^3\s' -or $onlineStatusLabel.Text -notmatch '^2/3\s' -or
    (Find-Control "PeerStatusLabel0").Tag -ne "available" -or
    (Find-Control "PeerStatusLabel2").Tag -ne "unavailable" -or
    (Find-Control "PeerAddressLabel0").Text -ne "192.168.1.8") {
    throw "The inline rows did not show the refreshed addresses and per-device probe results."
}
# Each row remains independently operable and within the scrollable viewport.
foreach ($index in 0..2) {
    $row = Find-Control "PeerRow$index"
    $toggle = Find-Control "PeerEnabledToggle$index"
    $more = Find-Control "PeerMoreButton$index"
    if (-not $toggle.Checked -or -not $toggle.Visible -or -not $more.Visible -or
        $toggle.Right -gt $row.ClientSize.Width -or $more.Right -gt $row.ClientSize.Width) {
        throw "Device row $index has missing or clipped inline controls."
    }
}
foreach ($capturePath in @($ScreenshotPath, $ExpandedScreenshotPath)) {
    if ([string]::IsNullOrWhiteSpace($capturePath)) { continue }
    $bitmap = New-Object System.Drawing.Bitmap($form.Width, $form.Height)
    try {
        $form.DrawToBitmap($bitmap, (New-Object System.Drawing.Rectangle(0, 0, $bitmap.Width, $bitmap.Height)))
        $bitmap.Save($capturePath, [System.Drawing.Imaging.ImageFormat]::Png)
    }
    finally { $bitmap.Dispose() }
}
$saveCountBeforeToggle = $script:saveCallCount
(Find-Control "PeerEnabledToggle0").Checked = $false
[System.Windows.Forms.Application]::DoEvents()
if ($script:saveCallCount -ne ($saveCountBeforeToggle + 1) -or $script:Peers[0].enabled -or
    @($script:Peers).Count -ne 3 -or -not (Find-Control "PeerRow0").Visible -or
    (Find-Control "PeerStatusLabel0").Tag -ne "disabled" -or -not (Find-Control "PeerEnabledToggle1").Checked) {
    throw "Disabling a device did not save immediately while keeping it visible and preserving other devices."
}
(Find-Control "PeerEnabledToggle1").Checked = $false
(Find-Control "PeerEnabledToggle2").Checked = $false
if (@($script:Peers | Where-Object enabled).Count -ne 0 -or @($script:Peers).Count -ne 3 -or
    $peerCountLabel.Text -notmatch '^0\s' -or
    @($peerDetailsPanel.Controls | Where-Object Name -like 'PeerRow*').Count -ne 3) {
    throw "Disabling the last device lost the roster or did not pause all sending."
}
(Find-Control "PeerEnabledToggle0").Checked = $true
if (-not $script:Peers[0].enabled -or (Find-Control "PeerStatusLabel0").Tag -ne "pending") {
    throw "A disabled device could not be enabled again directly from the list."
}

# Changing the roster during an unfinished scan must not be overwritten when it completes.
$script:discoveryTaskSource = New-Object 'System.Threading.Tasks.TaskCompletionSource[ClipRelay.DiscoveredDevice[]]'
$probesBeforeStaleScan = $script:probeCallCount
$testPeersButton.PerformClick()
(Find-Control "PeerEnabledToggle1").Checked = $true
$stalePhone = New-Object ClipRelay.DiscoveredDevice
$stalePhone.Id = "phone"
$stalePhone.Name = "phone"
$stalePhone.Address = "192.168.1.99"
$stalePhone.Port = 47632
$script:discoveryTaskSource.SetResult([ClipRelay.DiscoveredDevice[]]@($stalePhone))
for ($attempt = 0; $attempt -lt 10; $attempt++) {
    [System.Windows.Forms.Application]::DoEvents()
    Start-Sleep -Milliseconds 20
}
if ($script:probeCallCount -ne $probesBeforeStaleScan -or $script:Peers[0].address -ne "192.168.1.8" -or
    -not $script:Peers[1].enabled -or -not $testPeersButton.Enabled) {
    throw "An old scan overwrote the device selection made while it was running."
}

$saveCountBeforeNotification = $script:saveCallCount
$notificationToggle.Checked = -not $notificationToggle.Checked
if ($script:saveCallCount -ne ($saveCountBeforeNotification + 1) -or
    $script:lastSavedNotifications -ne $notificationToggle.Checked) {
    throw "Notification autosave stopped working."
}
$editedPhone = @(Copy-RelayPeers -Peers @($script:Peers[0]))[0]
$editedPhone.name = "realme RMX3700"
$editedPhone.accessToken = "edited-token"
$script:editorResult = $editedPhone
(Find-Control "PeerRow0").ContextMenuStrip.Items["EditPeerItem"].PerformClick()
if ($script:editorSelectedPeer.id -ne "phone" -or $script:Peers[0].name -ne "realme RMX3700" -or
    $script:Peers[0].accessToken -ne "edited-token") {
    throw "The row menu did not edit and save the selected device."
}
(Find-Control "PeerRow1").ContextMenuStrip.Items["RemovePeerItem"].PerformClick()
if (@($script:Peers).Count -ne 2 -or @($script:Peers | Where-Object id -eq "computer").Count -ne 0) {
    throw "The row menu did not remove only the selected device."
}
$script:editorResult = [PSCustomObject]@{
    id = "yifan"; name = "YIFAN"; address = "192.168.1.7"; port = 47632
    enabled = $true; accessToken = ""; requiresAuth = $false; platform = "windows"
}
$addPeerButton.PerformClick()
if ($null -ne $script:editorSelectedPeer -or @($script:Peers).Count -ne 3 -or $script:Peers[2].id -ne "yifan") {
    throw "The inline add button did not add and save a device."
}

# Discovery can still add new devices from the list itself.
$script:discoveryTaskSource = New-Object 'System.Threading.Tasks.TaskCompletionSource[ClipRelay.DiscoveredDevice[]]'
$newDevice = New-Object ClipRelay.DiscoveredDevice
$newDevice.Id = "new-phone"
$newDevice.Name = "New phone"
$newDevice.Address = "192.168.1.40"
$newDevice.Port = 47632
$scanPeersButton.PerformClick()
$script:discoveryTaskSource.SetResult([ClipRelay.DiscoveredDevice[]]@($newDevice))
Wait-Check
if (@($script:Peers).Count -ne 4 -or $script:Peers[3].id -ne "new-phone" -or -not $script:Peers[3].enabled -or
    @($script:lastProbedPeers | Where-Object id -eq "new-phone").Count -ne 1) {
    throw "Scanning from the inline list did not add and probe the new device."
}
foreach ($scanOutcome in @("empty", "failed")) {
    $script:discoveryTaskSource = New-Object 'System.Threading.Tasks.TaskCompletionSource[ClipRelay.DiscoveredDevice[]]'
    $probesBeforeScan = $script:probeCallCount
    $savesBeforeScan = $script:saveCallCount
    $testPeersButton.PerformClick()
    if ($scanOutcome -eq "empty") {
        $script:discoveryTaskSource.SetResult([ClipRelay.DiscoveredDevice[]]@())
    }
    else {
        $script:discoveryTaskSource.SetException([Exception]::new("mDNS unavailable"))
    }
    Wait-Check
    if ($script:probeCallCount -ne ($probesBeforeScan + 1) -or $script:saveCallCount -ne $savesBeforeScan -or
        @($script:Peers).Count -ne 4 -or $script:Peers[0].address -ne "192.168.1.8") {
        throw "A $scanOutcome scan did not fall back to the saved roster."
    }
}
# Removing the final device leaves a usable empty list with an add entry point.
while (@($script:Peers).Count -gt 0) {
    (Find-Control "PeerRow0").ContextMenuStrip.Items["RemovePeerItem"].PerformClick()
}
if ($null -eq (Find-Control "EmptyPeersLabel") -or -not $addPeerButton.Enabled -or @($script:Peers).Count -ne 0) {
    throw "An empty roster cannot be managed from the control center."
}

$form.Close()
[System.Windows.Forms.Application]::DoEvents()
if ($script:configurationDialogOpen -or $null -ne $script:configurationForm) {
    throw "Closing the control center did not reset its script-scoped lifecycle state."
}

# A stale disposed-form reference must self-heal instead of making subsequent
# tray clicks silently return without opening a window.
$script:configurationDialogOpen = $true
$script:configurationForm = $form
$script:connectivityTaskSource = New-Object 'System.Threading.Tasks.TaskCompletionSource[ClipRelay.RelayDeliveryResult[]]'
$script:discoveryTaskSource = New-Object 'System.Threading.Tasks.TaskCompletionSource[ClipRelay.DiscoveredDevice[]]'
Show-RelayControlCenter
[System.Windows.Forms.Application]::DoEvents()
$reopenedForm = $script:configurationForm
if ($null -eq $reopenedForm -or $reopenedForm.IsDisposed -or [object]::ReferenceEquals($form, $reopenedForm)) {
    throw "The control center did not recover from stale lifecycle state."
}
$reopenedForm.Close()
[System.Windows.Forms.Application]::DoEvents()
$probesBeforeClosedScan = $script:probeCallCount
$script:discoveryTaskSource.SetResult([ClipRelay.DiscoveredDevice[]]@($movedPhone))
$script:connectivityTaskSource.SetResult([ClipRelay.RelayDeliveryResult[]]@())
[System.Windows.Forms.Application]::DoEvents()
if ($script:configurationDialogOpen -or $null -ne $script:configurationForm -or
    $script:probeCallCount -ne $probesBeforeClosedScan) {
    throw "Closing the recovered control center did not reset its lifecycle state."
}
Write-Output "PASS: inline device management saves toggles, edits, removals and scans; all-off and stale-scan states remain usable."
