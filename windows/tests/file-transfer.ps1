[CmdletBinding()]
param([string]$TestWorkerOutput = '')
$ErrorActionPreference = 'Stop'
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$temporary = Join-Path ([IO.Path]::GetTempPath()) ('cliprelay-file-tests-' + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($temporary) | Out-Null
try {
    $binary = Join-Path $temporary 'file-transfer-tests.exe'
    $compiler = Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
    & $compiler /nologo /target:exe /platform:x64 /optimize+ /main:FileTransferTests "/out:$binary" /r:System.Web.Extensions.dll `
        (Join-Path $PSScriptRoot 'file-transfer.cs') (Join-Path $repository 'windows\remote-desktop\file-transfer.cs') `
        (Join-Path $repository 'windows\remote-desktop\desktop-user.cs')
    if ($LASTEXITCODE -ne 0) { throw 'File-transfer test compilation failed.' }
    & $binary
    if ($LASTEXITCODE -ne 0) { throw 'File-transfer tests failed.' }
    if ($TestWorkerOutput) { Copy-Item -LiteralPath $binary -Destination ([IO.Path]::GetFullPath($TestWorkerOutput)) -Force }
} finally {
    $resolved = [IO.Path]::GetFullPath($temporary)
    $base = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if (!$resolved.StartsWith($base, [StringComparison]::OrdinalIgnoreCase) -or !(Split-Path $resolved -Leaf).StartsWith('cliprelay-file-tests-')) { throw 'Unsafe test cleanup path.' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
