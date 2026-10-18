[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
$windows = Join-Path (Split-Path $PSScriptRoot) 'windows'
. (Join-Path $windows 'install-support.ps1')
$pins = Get-Content -LiteralPath (Join-Path $windows 'components.json') -Raw -Encoding UTF8 | ConvertFrom-Json
foreach ($kind in @('engine','viewer','network')) {
    $pin = $pins.$kind
    $destination = [IO.Path]::GetFullPath((Join-Path $OutputDirectory $kind))
    if (Test-Path -LiteralPath $destination) { throw "Component output already exists: $destination" }
    $run = & gh run view $pin.run --repo $pins.repository --json headSha,conclusion
    if ($LASTEXITCODE -ne 0) { throw "Cannot verify $kind build." }
    $run = $run | ConvertFrom-Json
    if ($run.conclusion -ne 'success' -or $run.headSha -cne $pin.commit) { throw "Unexpected $kind build." }
    & gh run download $pin.run --repo $pins.repository --name $pin.artifact --dir $destination
    if ($LASTEXITCODE -ne 0) { throw "Cannot download pinned $kind artifact. Rebuild and review a new pin if the artifact has expired." }
    if ($kind -eq 'engine') {
        $manifest = Get-Content -LiteralPath (Join-Path $windows 'remote-desktop/engine-files.json') -Raw -Encoding UTF8 | ConvertFrom-Json
        Assert-ClipRelayFiles -Directory $destination -Files $manifest.files
        $env:CLIPRELAY_HOST_ENGINE_ARTIFACT = $destination
    } else {
        if ((Get-FileHash -LiteralPath (Join-Path $destination 'manifest.json')).Hash -ine $pin.manifestSha256) { throw "Unexpected $kind manifest." }
        $runtimeName = if ($kind -eq 'viewer') { 'remote-viewer' } else { 'desktop-network' }
        & (Join-Path $windows 'electron/stage-viewer.ps1') -Kind $kind -Artifact $destination -Destination (Join-Path $OutputDirectory $runtimeName) -VerifyOnly
        if ($kind -eq 'viewer') { $env:CLIPRELAY_VIEWER_ARTIFACT = $destination }
        else { $env:CLIPRELAY_NETWORK_HELPER_ARTIFACT = $destination }
    }
}
Write-Host 'Pinned Windows components downloaded and verified.'
