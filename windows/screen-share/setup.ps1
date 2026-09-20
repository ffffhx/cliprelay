[CmdletBinding()]
param([string]$Destination = $PSScriptRoot)
$ErrorActionPreference = 'Stop'
$version = '44.4.3'
$runtime = Join-Path $Destination 'engine'
if ((Test-Path (Join-Path $runtime 'electron.exe')) -and (Test-Path (Join-Path $runtime 'version')) -and ((Get-Content (Join-Path $runtime 'version') -Raw).Trim() -eq $version)) { return }
$architecture = if ([Environment]::Is64BitOperatingSystem) { 'x64' } else { 'ia32' }
$staging = Join-Path ([IO.Path]::GetTempPath()) ('cliprelay-electron-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $staging -Force | Out-Null
try {
    $name = "electron-v$version-win32-$architecture.zip"
    $base = "https://github.com/electron/electron/releases/download/v$version"
    $archive = Join-Path $staging $name
    $sums = (Invoke-WebRequest -UseBasicParsing "$base/SHASUMS256.txt").Content
    $expected = (($sums -split "`n" | Where-Object { $_ -match ('\s+\*?' + [regex]::Escape($name) + '\s*$') }) -split '\s+')[0]
    if ($expected -notmatch '^[a-f0-9]{64}$') { throw 'Cannot verify the video engine download.' }
    Invoke-WebRequest -UseBasicParsing "$base/$name" -OutFile $archive
    if ((Get-FileHash $archive -Algorithm SHA256).Hash -ine $expected) { throw 'Video engine checksum mismatch.' }
    New-Item -ItemType Directory -Path $runtime -Force | Out-Null
    Expand-Archive -LiteralPath $archive -DestinationPath $runtime -Force
} finally {
    $resolved = [IO.Path]::GetFullPath($staging)
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if ($resolved.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -and (Split-Path $resolved -Leaf).StartsWith('cliprelay-electron-')) {
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}
