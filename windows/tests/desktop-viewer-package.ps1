param([ValidateSet('viewer','network')][string]$Kind = 'viewer')
$ErrorActionPreference = 'Stop'
$base = Join-Path ([IO.Path]::GetTempPath()) ('cliprelay-viewer-test-' + [Guid]::NewGuid().ToString('N'))
$artifact = Join-Path $base 'artifact'
$target = Join-Path $base $(if ($Kind -eq 'network') { 'desktop-network' } else { 'remote-viewer' })
$runtimeFile = if ($Kind -eq 'network') { 'runtime/cliprelay-client-network.exe' } else { 'runtime/ClipRelayStream.exe' }
$requiredFiles = if ($Kind -eq 'network') { @($runtimeFile,'LICENSE','NETWORK-LICENSES.txt','cliprelay-network-source.tar.gz') } else { @($runtimeFile,'LICENSE','corresponding-source.tar.gz') }
$stage = Join-Path (Split-Path $PSScriptRoot) 'electron\stage-viewer.ps1'
$utf8 = New-Object Text.UTF8Encoding($false)
$checks = New-Object 'System.Collections.Generic.List[string]'
function Save-Fixture {
    param([string]$Version)
    [IO.Directory]::CreateDirectory((Join-Path $artifact 'runtime')) | Out-Null
    $files = [ordered]@{}
    foreach ($name in $requiredFiles) {
        $file = Join-Path $artifact $name.Replace('/','\')
        [IO.File]::WriteAllText($file, 'Synthetic non-executable test file ' + $Version, $utf8)
        $files[$name] = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    [IO.File]::WriteAllText((Join-Path $artifact 'manifest.json'), (@{role='desktop-network';capabilities=@('pairing-bootstrap');protocol=1;platform='windows';files=$files} | ConvertTo-Json -Depth 4), $utf8)
}
function Must-Reject {
    $rejected = $false
    try { & $stage -Kind $Kind -Artifact $artifact -Destination $target } catch { $rejected = $true }
    if (!$rejected) { throw 'Expected staging rejection.' }
}
try {
    [IO.Directory]::CreateDirectory($base) | Out-Null
    Save-Fixture 'one'
    [IO.File]::WriteAllText((Join-Path $artifact 'private-unlisted.txt'),'synthetic excluded value',$utf8)
    & $stage -Kind $Kind -Artifact $artifact -Destination $target
    if (Test-Path -LiteralPath (Join-Path $target 'private-unlisted.txt')) { throw 'Copied unlisted file.' }
    $checks.Add('copies-only-verified-manifest-files')
    Save-Fixture 'two'
    & $stage -Kind $Kind -Artifact $artifact -Destination $target
    if (!(Get-Content -LiteralPath (Join-Path $target $runtimeFile) -Raw).EndsWith('two')) { throw 'New runtime not published.' }
    $checks.Add('atomic-existing-runtime-replacement')
    [IO.File]::AppendAllText((Join-Path $artifact 'LICENSE'),'changed')
    Must-Reject
    if (!(Get-Content -LiteralPath (Join-Path $target 'LICENSE') -Raw).EndsWith('two')) { throw 'Modified installed runtime after rejected checksum.' }
    $checks.Add('tamper-preserves-current-runtime')
    Save-Fixture 'three'
    [IO.File]::WriteAllText((Join-Path $target 'user-added.txt'),'preserve',$utf8)
    Must-Reject
    if (!(Test-Path -LiteralPath (Join-Path $target 'user-added.txt'))) { throw 'Removed unknown file.' }
    Remove-Item -LiteralPath (Join-Path $target 'user-added.txt')
    $checks.Add('unknown-existing-files-are-preserved')
    $value = Get-Content -LiteralPath (Join-Path $artifact 'manifest.json') -Raw | ConvertFrom-Json
    $value.files | Add-Member -NotePropertyName '../escape.txt' -NotePropertyValue ('a' * 64)
    [IO.File]::WriteAllText((Join-Path $artifact 'manifest.json'), ($value | ConvertTo-Json -Depth 4), $utf8)
    Must-Reject
    $checks.Add('parent-path-escape-rejected')
    if ($Kind -eq 'network') {
        Save-Fixture 'four'
        $value = Get-Content -LiteralPath (Join-Path $artifact 'manifest.json') -Raw | ConvertFrom-Json
        $value.capabilities = @()
        [IO.File]::WriteAllText((Join-Path $artifact 'manifest.json'), ($value | ConvertTo-Json -Depth 4), $utf8)
        Must-Reject
        $checks.Add('old-helper-without-bootstrap-rejected')
    }
    @{checks=$checks;passed=$checks.Count} | ConvertTo-Json -Compress
} finally {
    $resolved = [IO.Path]::GetFullPath($base)
    $temp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if (!$resolved.StartsWith($temp,[StringComparison]::OrdinalIgnoreCase) -or !(Split-Path $resolved -Leaf).StartsWith('cliprelay-viewer-test-')) { throw 'Unexpected test directory.' }
    if (Test-Path -LiteralPath $resolved) { Remove-Item -LiteralPath $resolved -Recurse -Force }
}
