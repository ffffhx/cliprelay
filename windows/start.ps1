[CmdletBinding()]
param([switch]$OpenSettings, [int]$Port = 0, [string]$Peer = '', [int]$DebugPort = 0)
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$executable = Join-Path $PSScriptRoot 'desktop\ClipRelay.exe'
if (!(Test-Path -LiteralPath $executable)) { throw 'Run windows\electron\setup.ps1 to prepare the Electron application first.' }
if ($Port -lt 0 -or $Port -gt 65535) { throw 'Invalid port.' }
if ($DebugPort -ne 0 -and ($DebugPort -lt 1024 -or $DebugPort -gt 65535)) { throw 'Invalid Agent debug port.' }
if ($Peer -and ($Peer -match '[\s/\\:"\x00-\x1f]' -or $Peer.StartsWith('-'))) { throw 'Invalid peer address.' }
$arguments = if ($OpenSettings) { '--open-settings' } else { '--background' }
if ($Port) { $arguments += ' --port ' + $Port }
if ($Peer) { $arguments += ' --peer "' + $Peer + '"' }
if ($DebugPort) { $arguments += ' --remote-debugging-port=' + $DebugPort + ' --remote-debugging-address=127.0.0.1' }
# WMI releases the application from the invoking terminal's Job Object. The
# helper exits immediately, with no inherited console or redirected streams.
$inner = @'
$psi = New-Object Diagnostics.ProcessStartInfo
$psi.FileName = '__EXE__'
$psi.Arguments = '__ARGS__'
$psi.WorkingDirectory = '__ROOT__'
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
$psi.EnvironmentVariables.Remove('ELECTRON_RUN_AS_NODE')
$psi.EnvironmentVariables.Remove('CHROME_CRASHPAD_PIPE_NAME')
[void][Diagnostics.Process]::Start($psi)
'@
$inner = $inner.Replace('__EXE__', $executable.Replace("'", "''")).Replace('__ARGS__', $arguments.Replace("'", "''")).Replace('__ROOT__', $PSScriptRoot.Replace("'", "''"))
$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($inner))
$powerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$startup = ([wmiclass]'Win32_ProcessStartup').CreateInstance()
$startup.ShowWindow = 0
$result = ([wmiclass]'Win32_Process').Create("`"$powerShell`" -NoProfile -STA -WindowStyle Hidden -EncodedCommand $encoded", $PSScriptRoot, $startup)
if ($result.ReturnValue -ne 0) { throw "ClipRelay launch failed: $($result.ReturnValue)" }
Write-Host 'ClipRelay launched independently of this terminal.'
