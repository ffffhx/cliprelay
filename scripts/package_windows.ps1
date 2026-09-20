[CmdletBinding()]
param([string]$OutputDirectory = (Join-Path (Split-Path $PSScriptRoot) '.tools\windows-release'))
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$source = Join-Path (Split-Path $PSScriptRoot) 'windows'
$version = Get-Content (Join-Path $source 'version.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$notes = (Get-Content (Join-Path $source 'release-notes.txt') -Raw -Encoding UTF8).Trim()
if ($version.versionName -cnotmatch '^\d+\.\d+\.\d+$' -or $version.versionCode -isnot [int] -or $version.versionCode -le 0 -or !$notes -or $notes.Length -gt 20000) {
    throw 'Set a valid version and release notes before packaging.'
}
& (Join-Path $source 'screen-share\setup.ps1') -Destination (Join-Path $source 'screen-share')
$output = [IO.Path]::GetFullPath($OutputDirectory)
[IO.Directory]::CreateDirectory($output) | Out-Null
$staging = Join-Path ([IO.Path]::GetTempPath()) ('cliprelay-package-' + [Guid]::NewGuid().ToString('N'))
$package = Join-Path $staging 'ClipRelay-Windows'
[IO.Directory]::CreateDirectory($package) | Out-Null
try {
    # Explicit allowlist: never bundle config, history, tokens, keys or test files.
    foreach ($name in @('cliprelay.ps1','install.ps1','uninstall.ps1','cliprelay.ico','updates.ps1','update-client.cs','version.json','release-notes.txt')) {
        Copy-Item -LiteralPath (Join-Path $source $name) -Destination (Join-Path $package $name)
    }
    $video = Join-Path $package 'screen-share'
    [IO.Directory]::CreateDirectory($video) | Out-Null
    foreach ($name in @('main.js','preload.js','package.json','share.html','share.css','share.js','bridge.ps1','setup.ps1','RESEARCH.md')) {
        Copy-Item -LiteralPath (Join-Path $source "screen-share\$name") -Destination (Join-Path $video $name)
    }
    Copy-Item -LiteralPath (Join-Path $source 'screen-share\engine') -Destination $video -Recurse
    $launcher = "@echo off`r`ncd /d `"%~dp0`"`r`n`"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`" -NoProfile -STA -ExecutionPolicy Bypass -File `"%~dp0install.ps1`"`r`npause`r`n"
    [IO.File]::WriteAllText((Join-Path $package 'Install.cmd'), $launcher, [Text.Encoding]::ASCII)
    [IO.File]::WriteAllText((Join-Path $package 'Readme.txt'), "先解压整个文件夹，再双击 Install.cmd。`r`n更新会保留设备列表、访问密钥、本机端口及开机启动设置。`r`n首次安装后，从托盘打开控制中心，添加或扫描另一台设备。`r`n版本更新：控制中心右下角或托盘菜单。`r`n", [Text.UTF8Encoding]::new($true))
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    Add-Type -AssemblyName System.IO.Compression
    $archive = Join-Path $output "ClipRelay-Windows-$($version.versionName).zip"
    if (Test-Path -LiteralPath $archive) { throw "Package already exists: $archive. Use a new output directory or version." }
    # .NET Framework's CreateFromDirectory uses legacy entry encoding/separators.
    $zip = [IO.Compression.ZipFile]::Open($archive, [IO.Compression.ZipArchiveMode]::Create, [Text.Encoding]::UTF8)
    try {
        foreach ($file in Get-ChildItem -LiteralPath $staging -Recurse -File) {
            $entry = $file.FullName.Substring($staging.Length + 1).Replace('\','/')
            [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $file.FullName, $entry, [IO.Compression.CompressionLevel]::Optimal)
        }
    } finally { $zip.Dispose() }
    $manifest = [ordered]@{
        versionCode=$version.versionCode; versionName=$version.versionName
        downloadUrl="https://124-221-36-36.anyip.dev:8443/cliprelay/windows/ClipRelay-Windows-$($version.versionName).zip"
        sha256=(Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
        sizeBytes=(Get-Item -LiteralPath $archive).Length; releaseNotes=$notes
    }
    if ($manifest.sizeBytes -gt 512MB) { throw 'Package exceeds the update service size limit.' }
    [IO.File]::WriteAllText((Join-Path $output 'windows-update.json'), ($manifest | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
    Write-Host "Prepared $archive"
}
finally {
    $resolved = [IO.Path]::GetFullPath($staging)
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if ($resolved.StartsWith($tempRoot,[StringComparison]::OrdinalIgnoreCase) -and (Split-Path $resolved -Leaf).StartsWith('cliprelay-package-')) {
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}
