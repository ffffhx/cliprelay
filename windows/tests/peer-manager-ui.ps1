[CmdletBinding()]
param(
    [string]$ScreenshotPath = ""
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
if (-not $sourceMatch.Success) { throw "ClipRelay C# source block was not found." }
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
if ($parseErrors.Count -gt 0) { throw "cliprelay.ps1 has parse errors: $($parseErrors[0].Message)" }
foreach ($functionName in @("Show-RelayPeerEditor", "Show-RelayPeerManager")) {
    $functionAst = $ast.Find({
        param($node)
        $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
            $node.Name -eq $functionName
    }, $true)
    if ($null -eq $functionAst) { throw "Function not found: $functionName" }
    Invoke-Expression $functionAst.Extent.Text
}

$script:appIcon = $null
function Get-PropertyValue {
    param([object]$Object, [string]$Name)
    if ($null -eq $Object) { return $null }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) { return $null }
    return $property.Value
}
function Copy-RelayPeers {
    param([object[]]$Peers)
    return @($Peers | ForEach-Object {
        [PSCustomObject]@{
            id = $_.id
            name = $_.name
            address = $_.address
            port = $_.port
            accessToken = $_.accessToken
            enabled = $_.enabled
            requiresAuth = [bool]$_.requiresAuth
            platform = [string]$_.platform
        }
    })
}
function Remove-LocalRelayPeers {
    param([object[]]$Peers, [string]$LocalDeviceId, [int]$LocalPort, [string[]]$LocalAddresses)
    return [PSCustomObject]@{
        Peers = @(Copy-RelayPeers -Peers $Peers)
        RemovedPeers = @()
        Removed = 0
    }
}
function Get-NormalizedRelayPeers {
    param([object[]]$Peers, [int]$DefaultPort, [string]$DefaultAccessToken)
    return @($Peers)
}
function Test-PeerConnectivity {
    param([string]$Address, [int]$Port, [int]$TimeoutMilliseconds, [string]$AccessToken)
    return "ok"
}
function Find-ClipRelayDevices {
    param([int]$TimeoutMilliseconds, [string]$LocalDeviceId, [int]$LocalPort)
    return @()
}
function Merge-DiscoveredRelayDevices {
    param(
        [object[]]$Peers,
        [object[]]$DiscoveredDevices,
        [int]$DefaultPort,
        [string]$DefaultAccessToken,
        [string]$LocalDeviceId,
        [int]$MaximumPeers
    )
    return [PSCustomObject]@{
        Peers = @($Peers)
        Added = 0
        Updated = 0
        AuthRequired = 0
        Discovered = 0
    }
}
function Get-DescendantControls {
    param([System.Windows.Forms.Control]$Parent)
    foreach ($control in $Parent.Controls) {
        $control
        Get-DescendantControls -Parent $control
    }
}

$peers = @(
    [PSCustomObject]@{
        id = "phone"
        name = "Phone"
        address = "192.168.1.9"
        port = 47632
        accessToken = "phone-token"
        enabled = $true
        requiresAuth = $true
        platform = "android"
    },
    [PSCustomObject]@{
        id = "computer"
        name = "Office PC"
        address = "192.168.1.20"
        port = 47632
        accessToken = ""
        enabled = $true
        requiresAuth = $false
        platform = "windows"
    }
)

$captured = $false
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 800
$timer.Add_Tick({
    $timer.Stop()
    $openForms = [System.Windows.Forms.Application]::OpenForms
    if ($openForms.Count -lt 1) { return }
    $manager = $openForms[$openForms.Count - 1]
    if ($manager.ClientSize.Width -lt 520 -or $manager.ClientSize.Height -lt 540) {
        $manager.Close()
        throw "The peer manager is unexpectedly small."
    }
    $scanButton = $manager.Controls["ScanDevicesButton"]
    if ($null -eq $scanButton -or -not $scanButton.Visible) {
        $manager.Close()
        throw "The peer manager does not expose a visible mDNS scan button."
    }
    if (-not [string]::IsNullOrWhiteSpace($ScreenshotPath)) {
        $bitmap = New-Object System.Drawing.Bitmap($manager.Width, $manager.Height)
        try {
            $manager.DrawToBitmap($bitmap, (New-Object System.Drawing.Rectangle(0, 0, $bitmap.Width, $bitmap.Height)))
            $bitmap.Save($ScreenshotPath, [System.Drawing.Imaging.ImageFormat]::Png)
        }
        finally {
            $bitmap.Dispose()
        }
    }
    $script:captured = $true
    $manager.Close()
})
$timer.Start()
$null = Show-RelayPeerManager -Owner $null -Peers $peers -DefaultPort 47632 -DefaultAccessToken ""
$timer.Dispose()
if (-not $script:captured) { throw "The peer manager did not open for validation." }

$script:toggleApplied = $false
$toggleTimer = New-Object System.Windows.Forms.Timer
$toggleTimer.Interval = 500
$toggleTimer.Add_Tick({
    $toggleTimer.Stop()
    $openForms = [System.Windows.Forms.Application]::OpenForms
    if ($openForms.Count -lt 1) { return }
    $manager = $openForms[$openForms.Count - 1]
    $controls = @(Get-DescendantControls -Parent $manager)
    $probeToggle = $controls |
        Where-Object { $_.GetType().FullName -eq "ClipRelay.RelayToggle" } |
        Select-Object -First 1
    $probeCountLabel = $controls |
        Where-Object { $_ -is [System.Windows.Forms.Label] -and $_.Text -match "^\d+/\d+ " } |
        Select-Object -First 1
    $probeApplyButton = $manager.Controls |
        Where-Object { $_.GetType().FullName -eq "ClipRelay.RelayButton" } |
        Select-Object -Last 1
    if ($null -eq $probeToggle -or $null -eq $probeCountLabel -or $null -eq $probeApplyButton) {
        $manager.Close()
        throw "The peer manager toggle controls were not found."
    }

    $probeToggle.Checked = $false
    if ($probeCountLabel.Text -notmatch "^1/2 ") {
        $manager.Close()
        throw "Toggling a peer did not update the enabled-device count."
    }
    $script:toggleApplied = $true
    $probeApplyButton.PerformClick()
})
$toggleTimer.Start()
$toggledPeers = @(Show-RelayPeerManager -Owner $null -Peers $peers -DefaultPort 47632 -DefaultAccessToken "")
$toggleTimer.Dispose()
if (-not $script:toggleApplied) { throw "The peer toggle regression check did not run." }
if ($toggledPeers.Count -ne 2 -or [bool]$toggledPeers[0].enabled -or -not [bool]$toggledPeers[1].enabled) {
    throw "The peer manager did not return the toggled enabled state."
}

$script:removeApplied = $false
$removeTimer = New-Object System.Windows.Forms.Timer
$removeTimer.Interval = 500
$removeTimer.Add_Tick({
    $removeTimer.Stop()
    $openForms = [System.Windows.Forms.Application]::OpenForms
    if ($openForms.Count -lt 1) { return }
    $manager = $openForms[$openForms.Count - 1]
    $controls = @(Get-DescendantControls -Parent $manager)
    $firstPeerRow = $controls |
        Where-Object { $_.GetType().FullName -eq "ClipRelay.RelayPanel" } |
        Select-Object -First 1
    $probeRemoveButton = $firstPeerRow.Controls |
        Where-Object { $_.GetType().FullName -eq "ClipRelay.RelayButton" } |
        Select-Object -Last 1
    if ($null -eq $probeRemoveButton) {
        $manager.Close()
        throw "The peer manager remove button was not found."
    }

    $probeRemoveButton.PerformClick()
    $controls = @(Get-DescendantControls -Parent $manager)
    $probeCountLabel = $controls |
        Where-Object { $_ -is [System.Windows.Forms.Label] -and $_.Text -match "^\d+/\d+ " } |
        Select-Object -First 1
    $probeApplyButton = $manager.Controls |
        Where-Object { $_.GetType().FullName -eq "ClipRelay.RelayButton" } |
        Select-Object -Last 1
    if ($null -eq $probeCountLabel -or $probeCountLabel.Text -notmatch "^1/1 ") {
        $manager.Close()
        throw "Removing a peer did not refresh the enabled-device count."
    }
    $script:removeApplied = $true
    $probeApplyButton.PerformClick()
})
$removeTimer.Start()
$remainingPeers = @(Show-RelayPeerManager -Owner $null -Peers $peers -DefaultPort 47632 -DefaultAccessToken "")
$removeTimer.Dispose()
if (-not $script:removeApplied) { throw "The peer removal regression check did not run." }
if ($remainingPeers.Count -ne 1 -or $remainingPeers[0].id -ne "computer") {
    throw "The peer manager did not return the expected device after removal."
}

$script:editApplied = $false
$script:editDialogTimer = New-Object System.Windows.Forms.Timer
$editManagerTimer = New-Object System.Windows.Forms.Timer
$editManagerTimer.Interval = 500
$editManagerTimer.Add_Tick({
    $editManagerTimer.Stop()
    $openForms = [System.Windows.Forms.Application]::OpenForms
    if ($openForms.Count -lt 1) { return }
    $manager = $openForms[$openForms.Count - 1]
    $controls = @(Get-DescendantControls -Parent $manager)
    $firstPeerRow = $controls |
        Where-Object { $_.GetType().FullName -eq "ClipRelay.RelayPanel" } |
        Select-Object -First 1
    $probeEditButton = $firstPeerRow.Controls |
        Where-Object { $_.GetType().FullName -eq "ClipRelay.RelayButton" } |
        Select-Object -First 1
    if ($null -eq $probeEditButton) {
        $manager.Close()
        throw "The peer manager edit button was not found."
    }

    $script:editDialogTimer.Interval = 300
    $script:editDialogTimer.Add_Tick({
        $script:editDialogTimer.Stop()
        $editor = [System.Windows.Forms.Application]::OpenForms[
            [System.Windows.Forms.Application]::OpenForms.Count - 1
        ]
        $editorControls = @(Get-DescendantControls -Parent $editor)
        $nameTextBox = $editorControls |
            Where-Object { $_ -is [System.Windows.Forms.TextBox] } |
            Select-Object -First 1
        $editorSaveButton = $editor.Controls |
            Where-Object { $_.GetType().FullName -eq "ClipRelay.RelayButton" } |
            Select-Object -Last 1
        if ($null -eq $nameTextBox -or $null -eq $editorSaveButton) {
            $editor.Close()
            throw "The peer editor controls were not found."
        }
        $nameTextBox.Text = "Renamed Phone"
        $editorSaveButton.PerformClick()
    })
    $script:editDialogTimer.Start()
    $probeEditButton.PerformClick()
    $script:editDialogTimer.Dispose()

    $controls = @(Get-DescendantControls -Parent $manager)
    $renamedLabel = $controls |
        Where-Object { $_ -is [System.Windows.Forms.Label] -and $_.Text -eq "Renamed Phone" } |
        Select-Object -First 1
    $probeApplyButton = $manager.Controls |
        Where-Object { $_.GetType().FullName -eq "ClipRelay.RelayButton" } |
        Select-Object -Last 1
    if ($null -eq $renamedLabel -or $null -eq $probeApplyButton) {
        $manager.Close()
        throw "Editing a peer did not refresh its displayed name."
    }
    $script:editApplied = $true
    $probeApplyButton.PerformClick()
})
$editManagerTimer.Start()
$editedPeers = @(Show-RelayPeerManager -Owner $null -Peers $peers -DefaultPort 47632 -DefaultAccessToken "")
$editManagerTimer.Dispose()
if (-not $script:editApplied) { throw "The peer edit regression check did not run." }
if ($editedPeers.Count -ne 2 -or $editedPeers[0].name -ne "Renamed Phone") {
    throw "The peer manager did not return the edited device."
}

$script:editorOpened = $false
$editorTimer = New-Object System.Windows.Forms.Timer
$editorTimer.Interval = 500
$editorTimer.Add_Tick({
    $editorTimer.Stop()
    $openForms = [System.Windows.Forms.Application]::OpenForms
    if ($openForms.Count -lt 1) { return }
    $editor = $openForms[$openForms.Count - 1]
    if ($editor.ClientSize.Width -lt 470 -or $editor.ClientSize.Height -lt 420) {
        $editor.Close()
        throw "The peer editor is unexpectedly small."
    }
    $script:editorOpened = $true
    $editor.Close()
})
$editorTimer.Start()
$null = Show-RelayPeerEditor -Owner $null -Peer $peers[0] -DefaultPort 47632 -DefaultAccessToken ""
$editorTimer.Dispose()
if (-not $script:editorOpened) { throw "The peer editor did not open for validation." }

Write-Output "PASS: peer manager toggle/edit/removal events and the per-device editor work at the expected sizes."
