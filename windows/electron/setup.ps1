[CmdletBinding()]
param([string]$Destination = '')
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$windowsRoot = Split-Path $PSScriptRoot
if (!$Destination) { $Destination = Join-Path $windowsRoot 'desktop' }
$engine = Join-Path $windowsRoot 'screen-share\engine'
& (Join-Path $windowsRoot 'screen-share\setup.ps1') -Destination (Join-Path $windowsRoot 'screen-share')
$output = [IO.Path]::GetFullPath($Destination)
if ($output -ieq [IO.Path]::GetFullPath($engine)) { throw 'Desktop output must not overwrite the source runtime.' }
New-Item -ItemType Directory -Path $output -Force | Out-Null
# Do not copy a configured application or any data from a developer machine.
# This directory contains only the official checksum-verified Electron runtime.
foreach ($item in Get-ChildItem -LiteralPath $engine) {
    if ($item.Name -in @('electron.exe', 'resources')) { continue }
    Copy-Item -LiteralPath $item.FullName -Destination $output -Recurse -Force
}
Copy-Item -LiteralPath (Join-Path $engine 'electron.exe') -Destination (Join-Path $output 'ClipRelay.exe') -Force
if (!(Test-Path -LiteralPath (Join-Path $PSScriptRoot 'node_modules\@electron\packager'))) {
    & npm.cmd --prefix $PSScriptRoot ci --ignore-scripts
    if ($LASTEXITCODE -ne 0) { throw 'Electron build dependencies could not be installed.' }
}
& node (Join-Path $PSScriptRoot 'brand-windows.cjs') (Join-Path $output 'ClipRelay.exe')
if ($LASTEXITCODE -ne 0) { throw 'Electron application branding failed.' }
$appDirectory = Join-Path $output 'resources\app'
New-Item -ItemType Directory -Path $appDirectory -Force | Out-Null
foreach ($name in @('main.js','native-host.cjs','windows.cjs','preload.js','launch-native.ps1','package.json','desktop-client.cjs')) {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination $appDirectory -Force
}
$clientFiles = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'windows-files.json') -Raw -Encoding UTF8 | ConvertFrom-Json
foreach ($name in $clientFiles | Where-Object { $_.StartsWith('mac/') -or $_.StartsWith('renderer/') }) {
    $clientTarget = Join-Path $appDirectory $name
    [IO.Directory]::CreateDirectory((Split-Path $clientTarget)) | Out-Null
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination $clientTarget -Force
}
$manifest = Get-Content -LiteralPath (Join-Path $appDirectory 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$manifest.version = (Get-Content -LiteralPath (Join-Path $windowsRoot 'version.json') -Raw -Encoding UTF8 | ConvertFrom-Json).versionName
[IO.File]::WriteAllText((Join-Path $appDirectory 'package.json'), ($manifest | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
Write-Host "Prepared Electron application: $(Join-Path $output 'ClipRelay.exe')"
