[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$CompilerDirectory,
    [Parameter(Mandatory=$true)][string]$CryptoDll,
    [string]$OpusDll = '',
    [string]$OutputDirectory = '.tools\uu-parity\engine-stream-client'
)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$native = Join-Path $root 'android-app\remote-engine\src\main\jni\moonlight-core'
$core = Join-Path $native 'moonlight-common-c'
$output = [IO.Path]::GetFullPath((Join-Path $root $OutputDirectory))
$compiler = Join-Path $CompilerDirectory 'clang.exe'
$dlltool = Join-Path $CompilerDirectory 'llvm-dlltool.exe'
$exports = Join-Path $CompilerDirectory 'llvm-readobj.exe'
foreach ($required in @($compiler,$dlltool,$exports,$CryptoDll)) {
    if (!(Test-Path -LiteralPath $required -PathType Leaf)) { throw "Missing build dependency: $required" }
}
New-Item -ItemType Directory -Path $output -Force | Out-Null
$cryptoName = Split-Path $CryptoDll -Leaf
$definitions = @(('LIBRARY ' + $cryptoName), 'EXPORTS')
$symbols = & $exports --coff-exports $CryptoDll
if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect OpenSSL exports' }
foreach ($line in $symbols) {
    if ($line -match '^\s+Name: ([A-Za-z_][A-Za-z0-9_]*)$') { $definitions += $matches[1] }
}
if ($definitions.Count -lt 20) { throw 'OpenSSL DLL has too few exports' }
$definition = Join-Path $output 'crypto.def'
[IO.File]::WriteAllLines($definition, $definitions, [Text.Encoding]::ASCII)
$library = Join-Path $output 'crypto.lib'
& $dlltool -m i386:x86-64 -d $definition -l $library -D $cryptoName
if ($LASTEXITCODE -ne 0) { throw 'Cannot create OpenSSL import library' }
$sources = @(Get-ChildItem -LiteralPath (Join-Path $core 'src') -Filter '*.c' | ForEach-Object FullName)
$sources += @(Get-ChildItem -LiteralPath (Join-Path $core 'enet') -Filter '*.c' | ForEach-Object FullName)
$sources += @((Join-Path $core 'nanors\rs.c'), (Join-Path $core 'nanors\deps\obl\oblas_common.c'),
    (Join-Path $core 'nanors\deps\obl\oblas_lite.c'), (Join-Path $PSScriptRoot 'engine_stream_client.c'))
$includes = @('src','enet\include','nanors','nanors\deps','nanors\deps\obl') | ForEach-Object { '-I' + (Join-Path $core $_) }
$includes += '-I' + (Join-Path $native 'openssl\include')
$includes += '-I' + (Join-Path $native 'opus\include')
$executable = Join-Path $output 'engine-stream-client.exe'
& $compiler -std=c11 -O2 -DNDEBUG -DHAS_SOCKLEN_T -DHAS_QOS_FLOWID -DHAS_PQOS_FLOWID -D_WIN32_WINNT=0x0601 @includes @sources $library -lws2_32 -lwinmm -lgdi32 -luser32 -o $executable
if ($LASTEXITCODE -ne 0) { throw 'Native stream test client build failed' }
Copy-Item -LiteralPath $CryptoDll -Destination (Join-Path $output $cryptoName)
if ($OpusDll) {
    $opusLicense=Join-Path (Split-Path $OpusDll) 'COPYING'
    if (!(Test-Path -LiteralPath $opusLicense -PathType Leaf)) {throw 'The fixture Opus DLL must include its adjacent COPYING license'}
    Copy-Item -LiteralPath $OpusDll -Destination (Join-Path $output 'cliprelay-test-opus.dll')
    Copy-Item -LiteralPath $opusLicense -Destination (Join-Path $output 'OPUS-LICENSE')
}
Get-FileHash -LiteralPath $executable -Algorithm SHA256
