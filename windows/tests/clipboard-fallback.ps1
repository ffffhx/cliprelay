[CmdletBinding()]
param()

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System.Runtime.InteropServices;
namespace ClipRelay {
    public static class NativeMethods {
        [DllImport("user32.dll")]
        public static extern uint GetClipboardSequenceNumber();
    }
}
'@

$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
    (Join-Path (Split-Path -Parent $PSScriptRoot) "cliprelay.ps1"),
    [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw $errors[0].Message }
foreach ($name in @("Get-ClipboardTextWithRetry", "Send-CopiedClipboard")) {
    $functionAst = $ast.Find({
        param($node)
        $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name
    }, $true)
    Invoke-Expression $functionAst.Extent.Text
}

$script:enabled = $true
$script:sent = @()
$script:Notifications = $false
function Get-EnabledRelayPeers { if ($script:enabled) { "test-receiver" } }
function Send-ClipboardTextUnlessDuplicate {
    param([string]$Text)
    $script:sent += $Text
    return $true
}
function Set-LastTransferStatus { throw "Unexpected clipboard/send failure" }
function Assert-Sent {
    param([string]$Expected, [int]$Count)
    if ($script:sent.Count -ne $Count) { throw "Unexpected send count: $($script:sent.Count), expected $Count" }
    if ($Count -gt 0 -and $script:sent[-1] -cne $Expected) { throw "Unexpected clipboard payload" }
}

$savedClipboard = [System.Windows.Forms.Clipboard]::GetDataObject()
try {
    # A website copy button placed Markdown on the clipboard, then Ctrl+C did nothing.
    $markdown = "# Clipboard test`n`n``````powershell`nGet-Date`n``````"
    [System.Windows.Forms.Clipboard]::SetText($markdown)
    Send-CopiedClipboard -PreviousSequence ([ClipRelay.NativeMethods]::GetClipboardSequenceNumber())
    Assert-Sent -Expected $markdown -Count 1

    # A normal copy replaces the existing text before the polling code runs.
    $before = [ClipRelay.NativeMethods]::GetClipboardSequenceNumber()
    [System.Windows.Forms.Clipboard]::SetText("new selection")
    Send-CopiedClipboard -PreviousSequence $before
    Assert-Sent -Expected "new selection" -Count 2

    # Simulate an application that updates the clipboard after several polls.
    $script:polls = 0
    function Start-Sleep {
        param([int]$Milliseconds)
        $script:polls++
        if ($script:polls -eq 3) { [System.Windows.Forms.Clipboard]::SetText("delayed selection") }
    }
    Send-CopiedClipboard -PreviousSequence ([ClipRelay.NativeMethods]::GetClipboardSequenceNumber())
    Assert-Sent -Expected "delayed selection" -Count 3
    Remove-Item Function:\Start-Sleep

    [System.Windows.Forms.Clipboard]::Clear()
    Send-CopiedClipboard -PreviousSequence ([ClipRelay.NativeMethods]::GetClipboardSequenceNumber())
    Assert-Sent -Expected "delayed selection" -Count 3

    # A new non-text copy must not resend a previously copied text.
    [System.Windows.Forms.Clipboard]::SetText("must not send")
    $before = [ClipRelay.NativeMethods]::GetClipboardSequenceNumber()
    $bitmap = New-Object System.Drawing.Bitmap 2, 2
    try { [System.Windows.Forms.Clipboard]::SetImage($bitmap) } finally { $bitmap.Dispose() }
    Send-CopiedClipboard -PreviousSequence $before
    Assert-Sent -Expected "delayed selection" -Count 3

    $script:enabled = $false
    [System.Windows.Forms.Clipboard]::SetText("disabled receiver")
    Send-CopiedClipboard -PreviousSequence ([ClipRelay.NativeMethods]::GetClipboardSequenceNumber())
    Assert-Sent -Expected "delayed selection" -Count 3
}
finally {
    if ($null -ne $savedClipboard) {
        [System.Windows.Forms.Clipboard]::SetDataObject($savedClipboard, $true)
    } else { [System.Windows.Forms.Clipboard]::Clear() }
}
Write-Output "PASS: existing Markdown, new and delayed copies, empty/non-text clipboard, and disabled receivers."
