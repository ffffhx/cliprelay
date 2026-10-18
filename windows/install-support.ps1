Set-StrictMode -Version 2.0

function Assert-ClipRelayFiles {
    param([string]$Directory, [object]$Files)
    $root = [IO.Path]::GetFullPath($Directory).TrimEnd('\')
    if ((Get-Item -LiteralPath $root -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Package root must not be a link.' }
    $entries = @($Files.PSObject.Properties)
    if (!$entries.Count -or $entries.Count -gt 10000) { throw 'Invalid package file count.' }
    $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    $total = [long]0
    foreach ($entry in $entries) {
        if ($entry.Name -cnotmatch '^[A-Za-z0-9_.+/-]+$' -or $entry.Name.StartsWith('/') -or
            ($entry.Name.Split('/') | Where-Object { $_ -in @('','..','.') }) -or
            $entry.Value -cnotmatch '^[a-f0-9]{64}$' -or !$seen.Add($entry.Name)) { throw 'Invalid package path or hash.' }
        $path = $root
        foreach ($part in $entry.Name.Split('/')) {
            $path = Join-Path $path $part
            $item = Get-Item -LiteralPath $path -Force -ErrorAction Stop
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Package must not contain links.' }
        }
        if ($item.PSIsContainer -or $item.Length -gt 512MB) { throw 'Invalid package file.' }
        $total += $item.Length
        if ($total -gt 1536MB -or (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ine $entry.Value) { throw "Package checksum mismatch: $($entry.Name)" }
    }
}

function Get-ClipRelayHostManifest {
    param([string]$Directory)
    $manifest = Get-Content -LiteralPath (Join-Path $Directory 'files.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $names = @($manifest.serviceSources) + @($manifest.supportFiles)
    if (!$manifest.serviceSources.Count -or $names.Count -ne @($names | Select-Object -Unique).Count) { throw 'Invalid host source manifest.' }
    foreach ($name in $names) {
        if ($name -cnotmatch '^[A-Za-z0-9_-]+(\.[A-Za-z0-9]+)?$') { throw 'Invalid host source path.' }
        if (!(Test-Path -LiteralPath (Join-Path $Directory $name) -PathType Leaf)) { throw "Missing host source: $name" }
    }
    return $manifest
}

function Assert-ClipRelayPackage {
    param([string]$Directory)
    $manifestPath = Join-Path $Directory 'package-files.json'
    if (!(Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw 'Use the complete ClipRelay Windows package (package-files.json missing).' }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($manifest.protocol -ne 1 -or $manifest.platform -ne 'windows') { throw 'Incompatible Windows package.' }
    Assert-ClipRelayFiles -Directory $Directory -Files $manifest.files
    $hostRoot = Join-Path $Directory 'remote-desktop'
    $hostManifest = Get-ClipRelayHostManifest $hostRoot
    $electron = Get-Content -LiteralPath (Join-Path $Directory 'electron/windows-files.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $required = @('install.ps1','install-support.ps1','cliprelay.ps1','start.ps1','uninstall.ps1','updates.ps1','update-client.cs','paired-relay.cs','cliprelay.ico','version.json',
        'desktop/ClipRelay.exe','desktop/icudtl.dat','desktop/resources/app/main.js',
        'remote-desktop/files.json','remote-desktop/bin/ClipRelay.Remote.Service.exe','remote-desktop/bin/ClipRelay.Remote.Client.dll','remote-desktop/bin/cliprelay-network.exe',
        'electron/windows-files.json','remote-viewer/manifest.json','desktop-network/manifest.json')
    $required += @($hostManifest.serviceSources + $hostManifest.supportFiles | ForEach-Object { 'remote-desktop/' + $_ })
    $required += @($electron | ForEach-Object { 'electron/' + $_ })
    $required += @('main.js','preload.js','package.json','share.html','share.css','share.js','bridge.ps1','setup.ps1','RESEARCH.md' | ForEach-Object { 'screen-share/' + $_ })
    foreach ($name in $required) {
        if ($null -eq $manifest.files.PSObject.Properties[$name]) { throw "Incomplete Windows package: $name" }
    }
    $engine = Get-Content -LiteralPath (Join-Path $hostRoot 'engine-files.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    Assert-ClipRelayFiles -Directory (Join-Path $hostRoot 'engine') -Files $engine.files
    foreach ($file in $engine.files.PSObject.Properties) {
        if ($manifest.files.PSObject.Properties['remote-desktop/engine/' + $file.Name].Value -cne $file.Value) { throw 'Package engine differs from pinned build.' }
    }
    foreach ($kind in @('viewer','network')) {
        $name = if ($kind -eq 'viewer') { 'remote-viewer' } else { 'desktop-network' }
        $runtime = Join-Path $Directory $name
        & (Join-Path $Directory 'electron/stage-viewer.ps1') -Kind $kind -Artifact $runtime -Destination $runtime -VerifyOnly
    }
}

function New-ClipRelayInstallConfiguration {
    param([object]$Existing, [string]$Peer, [int]$Port, [bool]$PeerProvided, [bool]$PortProvided)
    if ($null -ne $Existing -and $Existing -isnot [pscustomobject]) { throw 'Existing configuration must be an object.' }
    $config = [ordered]@{}
    if ($null -ne $Existing) {
        foreach ($property in $Existing.PSObject.Properties) { $config[$property.Name] = $property.Value }
    }
    $defaults = [ordered]@{peer='';port=47632;notifications=$true;accessToken='';deviceId=[Guid]::NewGuid().ToString('N');deviceName=[Environment]::MachineName;discoveryEnabled=$true;legacyReceiverEnabled=$false}
    foreach ($key in $defaults.Keys) { if (!$config.Contains($key)) { $config[$key] = $defaults[$key] } }
    if ($PortProvided) { $config.port = $Port }
    if ([int]$config.port -lt 1 -or [int]$config.port -gt 65535) { throw 'Existing port is invalid.' }
    if (!$config.Contains('peers')) {
        $config.peers = @()
        if (!$PeerProvided) { $Peer = [string]$config.peer }
        $PeerProvided = ![string]::IsNullOrWhiteSpace($Peer)
    }
    if ($PeerProvided) {
        if ($Peer.Contains('://') -or $Peer.Contains('/') -or $Peer.Contains('\')) { throw 'Peer must be a host name or IP address.' }
        # Add only the explicitly requested legacy target. Preserve paired identities.
        $config.peers = @($config.peers | Where-Object {
            !$_.PSObject.Properties['id'] -or $_.id -ne 'installed-peer' -or
            ($_.PSObject.Properties['transport'] -and $_.transport -eq 'paired') -or
            ($_.PSObject.Properties['pairedOwner'] -and $_.pairedOwner)
        })
        if (![string]::IsNullOrWhiteSpace($Peer)) {
            $peerId = 'installed-peer'
            if (@($config.peers | Where-Object { $_.PSObject.Properties['id'] -and $_.id -eq $peerId }).Count) { $peerId += '-' + [Guid]::NewGuid().ToString('N') }
            $config.peers += [pscustomobject]@{id=$peerId;name='接收设备';address=$Peer.Trim();port=[int]$config.port;accessToken=$config.accessToken;enabled=$true;requiresAuth=$false;platform='';transport='legacy'}
        }
        $config.peer = $Peer.Trim()
    }
    return [pscustomobject]$config
}

function Write-ClipRelayInstallConfiguration {
    param([string]$Path, [object]$Configuration)
    $temporary = $Path + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
    try {
        [IO.File]::WriteAllText($temporary, ($Configuration | ConvertTo-Json -Depth 64), [Text.UTF8Encoding]::new($false))
        if (Test-Path -LiteralPath $Path) { [IO.File]::Replace($temporary, $Path, [NullString]::Value) }
        else { [IO.File]::Move($temporary, $Path) }
    } finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
    }
}
