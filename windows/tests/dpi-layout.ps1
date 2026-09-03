[CmdletBinding()]
param()

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
if (-not $sourceMatch.Success) { throw "ClipRelay C# source block was not found." }
$dpiLayoutArmCount = ([regex]::Matches($source, '\$form\.EnableDpiLayout\(\)')).Count
if ($dpiLayoutArmCount -ne 3) {
    throw "Every runtime-authored form must arm DPI layout after its controls are created; found $dpiLayoutArmCount of 3."
}
if ($source -match 'AutoScaleMode\]::Dpi') {
    throw "Runtime-authored forms must not establish the current monitor as their design DPI."
}
Add-Type -TypeDefinition $sourceMatch.Groups["code"].Value -ReferencedAssemblies @(
    "System.dll",
    "System.Core.dll",
    "System.Drawing.dll",
    "System.Windows.Forms.dll"
)

function Assert-Near {
    param([int]$Actual, [int]$Expected, [string]$Message)
    if ([Math]::Abs($Actual - $Expected) -gt 1) {
        throw "$Message Expected $Expected, got $Actual."
    }
}

foreach ($dpi in @(96, 120, 144, 192)) {
    $scale = $dpi / 96.0
    $form = New-Object ClipRelay.RelayForm
    try {
        $form.ClientSize = New-Object System.Drawing.Size(760, 720)
        $panel = New-Object ClipRelay.RelayPanel
        $panel.Bounds = New-Object System.Drawing.Rectangle(16, 68, 204, 136)
        $form.Controls.Add($panel)
        $label = New-Object System.Windows.Forms.Label
        $label.Bounds = New-Object System.Drawing.Rectangle(28, 9, 164, 22)
        $label.Font = New-Object System.Drawing.Font("Microsoft YaHei UI", 9.0)
        $panel.Controls.Add($label)

        $form.ApplyDpiLayoutForTesting(
            [single]$dpi,
            (New-Object System.Drawing.Size(3840, 2160))
        )

        if ($form.AutoScaleMode -ne [System.Windows.Forms.AutoScaleMode]::None) {
            throw "The runtime-authored form must use deterministic manual DPI scaling."
        }
        Assert-Near $form.UnconstrainedClientSize.Width ([int][Math]::Round(760 * $scale)) "Form width did not scale at $dpi DPI."
        Assert-Near $form.UnconstrainedClientSize.Height ([int][Math]::Round(720 * $scale)) "Form height did not scale at $dpi DPI."
        Assert-Near $panel.Left ([int][Math]::Round(16 * $scale)) "Panel position did not scale at $dpi DPI."
        Assert-Near $panel.Width ([int][Math]::Round(204 * $scale)) "Panel width did not scale at $dpi DPI."
        Assert-Near $label.Height ([int][Math]::Round(22 * $scale)) "Label height did not scale with its font at $dpi DPI."
        Assert-Near ([int][Math]::Round($form.LayoutScale * 100)) ([int][Math]::Round($scale * 100)) "Reported layout scale is wrong at $dpi DPI."

        # Device rows and expanded status labels are created after a form has
        # opened. They must receive the same scale instead of reverting to
        # fixed 96-DPI bounds.
        $lateLabel = New-Object System.Windows.Forms.Label
        $lateLabel.Bounds = New-Object System.Drawing.Rectangle(12, 40, 180, 18)
        $lateLabel.Font = New-Object System.Drawing.Font("Microsoft YaHei UI", 8.0)
        $panel.Controls.Add($lateLabel)
        Assert-Near $lateLabel.Left ([int][Math]::Round(12 * $scale)) "Late label position did not scale at $dpi DPI."
        Assert-Near $lateLabel.Width ([int][Math]::Round(180 * $scale)) "Late label width did not scale at $dpi DPI."
        Assert-Near $lateLabel.Height ([int][Math]::Round(18 * $scale)) "Late label height did not scale at $dpi DPI."

        $bitmap = New-Object System.Drawing.Bitmap(800, 200)
        try {
            $bitmap.SetResolution($dpi, $dpi)
            $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
            try {
                $statusText = -join @(
                    [char]0x63A5, [char]0x6536, [char]0x4E2D, [char]0x0020,
                    [char]0x00B7, [char]0x0020, [char]0x53EF, [char]0x53D1,
                    [char]0x73B0
                )
                $measured = $graphics.MeasureString($statusText, $label.Font)
                if ($measured.Width -gt $label.Width -or $measured.Height -gt $label.Height) {
                    throw "Representative Chinese status text is clipped at $dpi DPI: measured $measured in $($label.Size)."
                }
            }
            finally {
                $graphics.Dispose()
            }
        }
        finally {
            $bitmap.Dispose()
        }
    }
    finally {
        $form.Dispose()
    }
}

$compactForm = New-Object ClipRelay.RelayForm
try {
    $compactForm.ClientSize = New-Object System.Drawing.Size(760, 720)
    $compactForm.ApplyDpiLayoutForTesting(
        [single]144,
        (New-Object System.Drawing.Size(1366, 768))
    )
    if (-not $compactForm.AutoScroll) {
        throw "A scaled form larger than the working area must remain reachable through scrolling."
    }
    if ($compactForm.ClientSize.Width -gt 1342 -or $compactForm.ClientSize.Height -gt 744) {
        throw "The scaled form was not constrained to the working area."
    }
    if ($compactForm.AutoScrollMinSize.Width -lt 1140 -or $compactForm.AutoScrollMinSize.Height -lt 1080) {
        throw "The full scaled layout was not preserved as the scrollable extent."
    }
}
finally {
    $compactForm.Dispose()
}

Write-Host "ClipRelay DPI layout regression checks passed at 100%, 125%, 150%, and 200%." -ForegroundColor Green
