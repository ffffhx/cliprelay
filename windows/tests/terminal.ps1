param([switch]$Native)
$ErrorActionPreference='Stop'
$repository=(Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$output=Join-Path $repository '.tools\uu-parity\terminal-tests.exe'
$sources=@('terminal.cs','terminal-native.cs','terminal-mouse.cs','desktop-user.cs') | ForEach-Object {Join-Path (Join-Path $repository 'windows\remote-desktop') $_}
& "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /codepage:65001 /target:exe /platform:x64 /main:TerminalTests "/out:$output" /r:System.Web.Extensions.dll (Join-Path $PSScriptRoot 'terminal.cs') (Join-Path $PSScriptRoot 'terminal-mouse.cs') $sources
if($LASTEXITCODE -ne 0){throw 'Terminal test build failed'}
& $output
if($LASTEXITCODE -ne 0){throw 'Terminal policy tests failed'}
& node (Join-Path $PSScriptRoot 'terminal-mouse-parser.cjs') $output
if($LASTEXITCODE -ne 0){throw 'Terminal mouse parser compatibility failed'}
if($Native){& python (Join-Path $PSScriptRoot 'terminal_native.py') $output;if($LASTEXITCODE -ne 0){throw 'Native terminal tests failed'}}
