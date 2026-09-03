[CmdletBinding()]
param(
    [string]$ScreenshotPath = "",
    [string]$ExpandedScreenshotPath = ""
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

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

$functionAst = $ast.Find({
    param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
        $node.Name -eq "Show-RelayControlCenter"
}, $true)
if ($null -eq $functionAst) {
    throw "Function not found: Show-RelayControlCenter"
}
Invoke-Expression $functionAst.Extent.Text

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

function Get-LocalShareableAddresses {
    return @(
        [PSCustomObject]@{ Address = "uckf.local"; Display = "uckf.local" },
        [PSCustomObject]@{ Address = "192.168.1.42"; Display = "192.168.1.42" }
    )
}

function Test-StartupRegistration { return $true }
function Set-ClipboardTextWithRetry { param([string]$Text) }
function Copy-RelayPeers { param([object[]]$Peers); return @($Peers) }
function Remove-LocalRelayPeers {
    param([object[]]$Peers, [string]$LocalDeviceId, [int]$LocalPort, [string[]]$LocalAddresses)
    return [PSCustomObject]@{ Peers = @($Peers); RemovedPeers = @(); Removed = 0 }
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
function Show-RelayPeerManager {
    param($Owner, [object[]]$Peers, [int]$DefaultPort, [string]$DefaultAccessToken, [string]$LocalDeviceId)
    return $null
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
    throw "The relay control center is unexpectedly small."
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
$availableResult = New-Object ClipRelay.RelayDeliveryResult
$availableResult.Name = "phone"
$availableResult.Address = "192.168.1.9:47632"
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

$peerCountLabel = @($form.Controls.Find("PeerCountLabel", $true)) | Select-Object -First 1
$onlineStatusLabel = @($form.Controls.Find("OnlineStatusLabel", $true)) | Select-Object -First 1
$peerSummaryOne = @($form.Controls.Find("PeerSummaryOneLabel", $true)) | Select-Object -First 1
$peerSummaryTwo = @($form.Controls.Find("PeerSummaryTwoLabel", $true)) | Select-Object -First 1
$peerSummaryToggle = @($form.Controls.Find("PeerSummaryToggleButton", $true)) | Select-Object -First 1
$peerDetailsPanel = @($form.Controls.Find("PeerDetailsPanel", $true)) | Select-Object -First 1
$managePeersButton = @($form.Controls.Find("ManagePeersButton", $true)) | Select-Object -First 1
if ($null -eq $peerCountLabel -or $null -eq $onlineStatusLabel -or
    $null -eq $peerSummaryOne -or $null -eq $peerSummaryTwo -or
    $null -eq $peerSummaryToggle -or $null -eq $peerDetailsPanel -or $null -eq $managePeersButton) {
    throw "The peer controls required for cancellation validation were not found."
}
if ($peerCountLabel.Text -notmatch '^3\s' -or $peerCountLabel.Text -match '/') {
    throw "The broadcast target count still mixes enabled and total-device counts."
}
if ($onlineStatusLabel.Text -notmatch '^2/3\s') {
    throw "The online status does not show available devices over checked devices."
}
if ($peerSummaryOne.Tag -ne "available" -or -not $peerSummaryToggle.Visible -or
    $peerSummaryToggle.Tag -ne "summary") {
    throw "The collapsed target-node list does not expose an explicit expand control."
}
$peerSummaryToggle.PerformClick()
[System.Windows.Forms.Application]::DoEvents()
$expandedStatuses = @($peerDetailsPanel.Controls | Where-Object { $_.Name -like "PeerExpandedStatusLabel*" })
if (-not $peerDetailsPanel.Visible -or $peerSummaryToggle.Tag -ne "expanded" -or
    $expandedStatuses.Count -ne 3 -or -not $peerDetailsPanel.AutoScroll) {
    throw "Expanding the target-node list did not reveal the complete scrollable device roster."
}
if (@($expandedStatuses | Where-Object { $_.Tag -eq "available" }).Count -ne 2 -or
    @($expandedStatuses | Where-Object { $_.Tag -eq "unavailable" }).Count -ne 1) {
    throw "The expanded target-node list does not distinguish each device's availability."
}
foreach ($expectedName in @("phone", "office PC", "backup tablet")) {
    if (@($expandedStatuses | Where-Object { $_.Text -match [regex]::Escape($expectedName) }).Count -ne 1) {
        throw "The expanded target-node list is missing $expectedName."
    }
}
if (-not [string]::IsNullOrWhiteSpace($ExpandedScreenshotPath)) {
    $expandedBitmap = New-Object System.Drawing.Bitmap($form.Width, $form.Height)
    try {
        $form.DrawToBitmap(
            $expandedBitmap,
            (New-Object System.Drawing.Rectangle(0, 0, $expandedBitmap.Width, $expandedBitmap.Height))
        )
        $expandedBitmap.Save($ExpandedScreenshotPath, [System.Drawing.Imaging.ImageFormat]::Png)
    }
    finally {
        $expandedBitmap.Dispose()
    }
}
$peerSummaryToggle.PerformClick()
[System.Windows.Forms.Application]::DoEvents()
if ($peerDetailsPanel.Visible -or $peerSummaryToggle.Tag -ne "summary") {
    throw "The expanded target-node list could not be collapsed again."
}
$peerCountBeforeCancellation = $peerCountLabel.Text
$managePeersButton.PerformClick()
[System.Windows.Forms.Application]::DoEvents()
if ($peerCountLabel.Text -ne $peerCountBeforeCancellation) {
    throw "Cancelling the peer manager replaced the configured peers."
}

if (-not [string]::IsNullOrWhiteSpace($ScreenshotPath)) {
    $bitmap = New-Object System.Drawing.Bitmap($form.Width, $form.Height)
    try {
        $form.DrawToBitmap($bitmap, (New-Object System.Drawing.Rectangle(0, 0, $bitmap.Width, $bitmap.Height)))
        $bitmap.Save($ScreenshotPath, [System.Drawing.Imaging.ImageFormat]::Png)
    }
    finally {
        $bitmap.Dispose()
    }
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
Show-RelayControlCenter
[System.Windows.Forms.Application]::DoEvents()
$reopenedForm = $script:configurationForm
if ($null -eq $reopenedForm -or $reopenedForm.IsDisposed -or [object]::ReferenceEquals($form, $reopenedForm)) {
    throw "The control center did not recover from stale lifecycle state."
}
$reopenedForm.Close()
[System.Windows.Forms.Application]::DoEvents()
$script:connectivityTaskSource.SetResult([ClipRelay.RelayDeliveryResult[]]@())
[System.Windows.Forms.Application]::DoEvents()
if ($script:configurationDialogOpen -or $null -ne $script:configurationForm) {
    throw "Closing the recovered control center did not reset its lifecycle state."
}
Write-Output "PASS: the control center marks each target's availability and stays responsive during background checks."
