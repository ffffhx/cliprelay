[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$Artifact, [Parameter(Mandatory=$true)][string]$Destination)
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$source = [IO.Path]::GetFullPath($Artifact).TrimEnd('\')
$target = [IO.Path]::GetFullPath($Destination).TrimEnd('\')
if ($source -ieq $target) { throw 'Source and destination must differ.' }
$parent = Split-Path $target
if (!(Test-Path -LiteralPath $parent -PathType Container)) { throw 'Destination parent must exist.' }
if ((Split-Path $target -Leaf) -ne 'remote-viewer') { throw 'Destination must be a remote-viewer runtime directory.' }
$manifestFile = Join-Path $source 'manifest.json'
if ((Get-Item -LiteralPath $manifestFile).Length -gt 1MB) { throw 'Viewer manifest is too large.' }
$manifest = Get-Content -LiteralPath $manifestFile -Raw -Encoding UTF8 | ConvertFrom-Json
if ($manifest.protocol -ne 1 -or $manifest.platform -ne 'windows') { throw 'Incompatible viewer package.' }
$files = @($manifest.files.PSObject.Properties)
if (!$files.Count -or $files.Count -gt 10000 -or !($files.Name -ccontains 'runtime/ClipRelayStream.exe') -or !($files.Name -ccontains 'LICENSE') -or !($files.Name -ccontains 'corresponding-source.tar.gz')) { throw 'Incomplete viewer package.' }
$total = [long]0
foreach ($file in $files) {
    if ($file.Name -cnotmatch '^[A-Za-z0-9_.+/-]+$' -or $file.Name.StartsWith('/') -or ($file.Name.Split('/') | Where-Object { $_ -in @('','..','.') }) -or $file.Value -cnotmatch '^[a-f0-9]{64}$') { throw 'Invalid viewer manifest path or hash.' }
    $itemPath = $source
    foreach ($part in $file.Name.Split('/')) {
        $itemPath = Join-Path $itemPath $part
        $item = Get-Item -LiteralPath $itemPath -Force
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Viewer package must not contain reparse points.' }
    }
    if ($item.PSIsContainer -or $item.Length -gt 256MB) { throw 'Invalid viewer file.' }
    $total += $item.Length
    if ($total -gt 768MB -or (Get-FileHash -LiteralPath $itemPath -Algorithm SHA256).Hash -ine $file.Value) { throw 'Viewer file checksum mismatch or package too large.' }
}
foreach ($process in Get-Process -Name ClipRelayStream -ErrorAction SilentlyContinue) {
    if ($process.Path -and $process.Path.StartsWith($target + '\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Close the remote desktop window before updating the viewer.' }
}
if (Test-Path -LiteralPath $target) {
    $previousManifest = Join-Path $target 'manifest.json'
    if (!(Test-Path -LiteralPath $previousManifest -PathType Leaf)) { throw 'Refusing to replace an unrecognized viewer directory.' }
    $previous = Get-Content -LiteralPath $previousManifest -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($previous.protocol -ne 1 -or $previous.platform -ne 'windows') { throw 'Refusing to replace an unrecognized viewer directory.' }
    $known = @('manifest.json') + @($previous.files.PSObject.Properties.Name)
    foreach ($existing in Get-ChildItem -LiteralPath $target -Recurse -Force) {
        if ($existing.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Previous viewer contains a reparse point.' }
        if (!$existing.PSIsContainer -and !($known -ccontains $existing.FullName.Substring($target.Length + 1).Replace('\','/'))) { throw 'Previous viewer contains an unrecognized file; preserve it before updating.' }
    }
}
$pending = Join-Path $parent ('remote-viewer-pending-' + [Guid]::NewGuid().ToString('N'))
$backup = Join-Path $parent ('remote-viewer-previous-' + [Guid]::NewGuid().ToString('N'))
$prefix = [IO.Path]::GetFullPath($parent).TrimEnd('\') + '\'
foreach ($candidate in @($pending,$backup,$target)) {
    if (![IO.Path]::GetFullPath($candidate).StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid viewer staging directory.' }
    if ((Test-Path -LiteralPath $candidate) -and ((Get-Item -LiteralPath $candidate -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Invalid viewer staging link.' }
}
$published = $false
try {
    New-Item -ItemType Directory -Path $pending | Out-Null
    foreach ($file in $files) {
        $out = Join-Path $pending $file.Name.Replace('/','\')
        [IO.Directory]::CreateDirectory((Split-Path $out)) | Out-Null
        Copy-Item -LiteralPath (Join-Path $source $file.Name.Replace('/','\')) -Destination $out
        if ((Get-FileHash -LiteralPath $out -Algorithm SHA256).Hash -ine $file.Value) { throw 'Viewer source changed during copy.' }
    }
    Copy-Item -LiteralPath $manifestFile -Destination (Join-Path $pending 'manifest.json')
    if (Test-Path -LiteralPath $target) { Move-Item -LiteralPath $target -Destination $backup }
    Move-Item -LiteralPath $pending -Destination $target
    $published = $true
} finally {
    if (!$published -and (Test-Path -LiteralPath $backup) -and !(Test-Path -LiteralPath $target)) { Move-Item -LiteralPath $backup -Destination $target }
    if (Test-Path -LiteralPath $pending) { Remove-Item -LiteralPath $pending -Recurse -Force }
    if ($published -and (Test-Path -LiteralPath $backup)) { Remove-Item -LiteralPath $backup -Recurse -Force }
}
Write-Host 'Verified desktop viewer staged.'
