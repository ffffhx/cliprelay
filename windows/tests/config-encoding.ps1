[CmdletBinding()]
param()

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"

$clientPath = Join-Path (Split-Path -Parent $PSScriptRoot) "cliprelay.ps1"
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
$functionAst = $ast.Find({
    param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
        $node.Name -eq "Read-ClipRelayConfiguration"
}, $true)
if ($null -eq $functionAst) {
    throw "Read-ClipRelayConfiguration was not found."
}
Invoke-Expression $functionAst.Extent.Text

$temporaryConfig = [System.IO.Path]::GetTempFileName()
try {
    $json = '{"peers":[{"name":"\u624b\u673a","address":"192.168.1.9","port":47632},{"name":"\u4e00\u52a0 PHK110","address":"192.168.1.10","port":47632}]}'
    $utf8WithoutBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($temporaryConfig, $json, $utf8WithoutBom)

    $configuration = Read-ClipRelayConfiguration -Path $temporaryConfig
    $phone = ([string][char]0x624B) + ([char]0x673A)
    $onePlus = ([string][char]0x4E00) + ([char]0x52A0) + " PHK110"
    if ($configuration.peers[0].name -cne $phone -or
        $configuration.peers[1].name -cne $onePlus) {
        throw "UTF-8 discovery names were corrupted while reading a BOM-less config file."
    }
}
finally {
    Remove-Item -LiteralPath $temporaryConfig -Force -ErrorAction SilentlyContinue
}

Write-Output "PASS: BOM-less UTF-8 device names remain intact in Windows PowerShell 5.1."
