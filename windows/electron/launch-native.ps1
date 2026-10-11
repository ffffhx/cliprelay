[CmdletBinding()]
param([string]$ClientPath, [string]$HostPipe, [int]$Port = 0, [string]$Peer = '')
$ErrorActionPreference = 'Stop'
# Only this short wrapper belongs to Node's child-process streams. The native
# tray must have CreateNoWindow and no redirected stdin/stdout/stderr.
$psi = New-Object Diagnostics.ProcessStartInfo
$psi.FileName = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$psi.Arguments = '-NoProfile -STA -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $ClientPath + '" -ElectronHostPipe "' + $HostPipe + '"'
if ($Port -gt 0) { $psi.Arguments += ' -Port ' + $Port }
if ($Peer) { $psi.Arguments += ' -Peer "' + $Peer + '"' }
$psi.WorkingDirectory = Split-Path -Parent $ClientPath
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
$client = [Diagnostics.Process]::Start($psi)
try { $client.WaitForExit(); exit $client.ExitCode } finally { $client.Dispose() }
