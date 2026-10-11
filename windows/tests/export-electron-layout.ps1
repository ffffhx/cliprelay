[CmdletBinding()]
param([string]$OutputDirectory = '')
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
if (!$OutputDirectory) { $OutputDirectory = Join-Path (Split-Path $PSScriptRoot) 'electron\renderer\layouts' }
$script:layoutOutput = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Path $script:layoutOutput -Force | Out-Null

function Export-LegacyLayout {
    param($Form, $Variables)
    if ($Form.Text -ne 'ClipRelay 控制中心') { return }
    $destination = Join-Path $script:layoutOutput 'control-center.json'
    if (Test-Path -LiteralPath $destination) { return }
    $bindings = @{}
    foreach ($variable in $Variables) {
        if ($variable.Value -is [Windows.Forms.Control]) { $bindings[$variable.Value] = $variable.Name }
    }
    function Color-Css($Color) {
        if ($Color.A -eq 0) { return 'transparent' }
        return ('#{0:x2}{1:x2}{2:x2}' -f $Color.R, $Color.G, $Color.B)
    }
    function Export-Control($Control, $Key) {
        $id = if ($Control.Name) { $Control.Name } elseif ($bindings.ContainsKey($Control)) { $bindings[$Control] } else { $Key }
        $item = [ordered]@{
            id=$id; type=$Control.GetType().Name; text=$Control.Text
            x=$Control.Left; y=$Control.Top; width=$Control.Width; height=$Control.Height
            color=(Color-Css $Control.ForeColor); background=(Color-Css $Control.BackColor)
            font=$Control.Font.Name; fontSize=$Control.Font.SizeInPoints; bold=$Control.Font.Bold
            tabIndex=$Control.TabIndex; tabStop=$Control.TabStop
            children=@()
        }
        foreach ($property in @('CornerRadius','BorderWidth','AutoScroll','Checked','UseSystemPasswordChar','ReadOnly','MaxLength')) {
            if ($null -ne $Control.PSObject.Properties[$property]) { $item[$property] = $Control.$property }
        }
        foreach ($property in @('FillColor','HoverColor','PressedColor','TextColor','BorderColor','OnColor','OffColor','KnobColor')) {
            if ($null -ne $Control.PSObject.Properties[$property]) { $item[$property] = Color-Css $Control.$property }
        }
        if ($null -ne $Control.PSObject.Properties['TextAlign']) { $item['align'] = $Control.TextAlign.ToString() }
        if ($id -eq 'localAddressValue') { $item.text = 'cliprelay.local' }
        $index = 0
        foreach ($child in $Control.Controls) { $item.children += Export-Control $child "$id-$index"; $index++ }
        return $item
    }
    $layout = Export-Control $Form 'form'
    $layout.text = 'ClipRelay 控制中心'
    $layout.width = $Form.ClientSize.Width; $layout.height = $Form.ClientSize.Height
    [IO.File]::WriteAllText($destination, ($layout | ConvertTo-Json -Depth 40), [Text.UTF8Encoding]::new($false))
}
function Add-LayoutExport([string]$Source) {
    return $Source.Replace('$form.EnableDpiLayout()', 'Export-LegacyLayout -Form $form -Variables (Get-Variable); $form.EnableDpiLayout()')
}
# Run the existing, isolated UI fixture: it supplies synthetic devices and
# stubs network/config writes. Export before DPI scaling, then run its checks.
$fixture = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'settings-ui.ps1') -Raw -Encoding UTF8
$fixture = $fixture.Replace('Invoke-Expression $functionAst.Extent.Text', 'Invoke-Expression (Add-LayoutExport $functionAst.Extent.Text)')
$fixture = $fixture.Replace('$PSScriptRoot', ("'" + $PSScriptRoot.Replace("'", "''") + "'"))
Invoke-Expression $fixture
