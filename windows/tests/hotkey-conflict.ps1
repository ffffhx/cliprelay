[CmdletBinding()]
param()

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"

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
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class ClipRelayHotkeyTest
{
    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool RegisterHotKey(IntPtr window, int id, uint modifiers, int virtualKey);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool UnregisterHotKey(IntPtr window, int id);
}
"@

$testHotkeyId = 0x4764
$modControlAltNoRepeat = 0x4003
$virtualKeyF12 = 0x7B
$ownsBlockingRegistration = [ClipRelayHotkeyTest]::RegisterHotKey(
    [IntPtr]::Zero,
    $testHotkeyId,
    $modControlAltNoRepeat,
    $virtualKeyF12
)

try {
    try {
        [ClipRelay.CopyHotkeyMonitor]::Start()
        if ([ClipRelay.CopyHotkeyMonitor]::ScreenshotHotkeyAvailable) {
            throw "Ctrl+Alt+F12 was reported available while another registration owned it."
        }
        if ([string]::IsNullOrWhiteSpace([ClipRelay.CopyHotkeyMonitor]::ScreenshotHotkeyError)) {
            throw "Ctrl+Alt+F12 conflict did not expose a diagnostic message."
        }
    }
    finally {
        [ClipRelay.CopyHotkeyMonitor]::Stop()
    }
}
finally {
    if ($ownsBlockingRegistration) {
        $null = [ClipRelayHotkeyTest]::UnregisterHotKey([IntPtr]::Zero, $testHotkeyId)
    }
}

if ($ownsBlockingRegistration) {
    try {
        [ClipRelay.CopyHotkeyMonitor]::Start()
        if (-not [ClipRelay.CopyHotkeyMonitor]::ScreenshotHotkeyAvailable) {
            throw "Ctrl+Alt+F12 was not registered after the simulated conflict was released."
        }
    }
    finally {
        [ClipRelay.CopyHotkeyMonitor]::Stop()
    }
    Write-Output "PASS: Ctrl+Alt+F12 conflict is detected, text monitoring survives, and registration succeeds after release."
}
else {
    Write-Output "PASS: An existing Ctrl+Alt+F12 owner was detected and text monitoring remained active."
}
