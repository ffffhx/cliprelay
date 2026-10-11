[CmdletBinding()]
param([ValidateSet('native','renderer')][string]$Mode = 'native')
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$windowsRoot = Split-Path $PSScriptRoot
$repo = Split-Path $windowsRoot
$fixture = Join-Path $repo ('.tools\electron-qa-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixture -Force | Out-Null
foreach ($file in @('cliprelay.ps1','cliprelay.ico','updates.ps1','update-client.cs','version.json')) {
    Copy-Item -LiteralPath (Join-Path $windowsRoot $file) -Destination $fixture
}
foreach ($folder in @('electron','screen-share','remote-desktop')) {
    New-Item -ItemType Directory -Path (Join-Path $fixture $folder) -Force | Out-Null
}
foreach ($file in @('bridge.ps1','native-bridge.cs')) { Copy-Item -LiteralPath (Join-Path $windowsRoot "electron\$file") -Destination (Join-Path $fixture 'electron') }
foreach ($file in @('bridge.ps1')) { Copy-Item -LiteralPath (Join-Path $windowsRoot "screen-share\$file") -Destination (Join-Path $fixture 'screen-share') }
foreach ($file in @('ui.ps1','remote-client.cs')) { Copy-Item -LiteralPath (Join-Path $windowsRoot "remote-desktop\$file") -Destination (Join-Path $fixture 'remote-desktop') }
# Isolate the only global side effect of saving settings. Never rewrite the
# user's login shortcut from a test fixture, even if the test fails midway.
$client = Join-Path $fixture 'cliprelay.ps1'
$source = [IO.File]::ReadAllText($client)
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseInput($source,[ref]$tokens,[ref]$errors)
$setter = $ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Set-StartupRegistration'},$true)
if ($null -eq $setter) { throw 'Cannot isolate startup registration.' }
$source = $source.Remove($setter.Extent.StartOffset,$setter.Extent.EndOffset-$setter.Extent.StartOffset).Insert($setter.Extent.StartOffset,'function Set-StartupRegistration { param([bool]$Enabled) }')
[IO.File]::WriteAllText($client,$source,[Text.UTF8Encoding]::new($true))
$config = @{peer='';peers=@();port=47931;notifications=$false;accessToken='';deviceId='electron-qa';deviceName='Electron migration QA';discoveryEnabled=$false}
[IO.File]::WriteAllText((Join-Path $fixture 'config.json'),($config | ConvertTo-Json),[Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText((Join-Path $fixture '.electron-test-fixture'),'startup-registration-disabled')
$engine = Join-Path $windowsRoot 'screen-share\engine\electron.exe'
if (!(Test-Path -LiteralPath $engine)) { & (Join-Path $windowsRoot 'screen-share\setup.ps1') }
$test = Join-Path $PSScriptRoot $(if($Mode -eq 'native'){'electron-live.cjs'}else{'electron-renderer-live.cjs'})
$arguments = '"' + $test + '" --root="' + $fixture + '" --force-device-scale-factor=1'
$inner = @'
$psi = New-Object Diagnostics.ProcessStartInfo
$psi.FileName = '__ENGINE__'
$psi.Arguments = '__ARGS__'
$psi.WorkingDirectory = '__ROOT__'
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
$psi.EnvironmentVariables.Remove('ELECTRON_RUN_AS_NODE')
$psi.EnvironmentVariables.Remove('CHROME_CRASHPAD_PIPE_NAME')
[void][Diagnostics.Process]::Start($psi)
'@
$inner = $inner.Replace('__ENGINE__',$engine.Replace("'","''")).Replace('__ARGS__',$arguments.Replace("'","''")).Replace('__ROOT__',$fixture.Replace("'","''"))
$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($inner))
$startup = ([wmiclass]'Win32_ProcessStartup').CreateInstance(); $startup.ShowWindow=0
$executable = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$result = ([wmiclass]'Win32_Process').Create("`"$executable`" -NoProfile -STA -WindowStyle Hidden -EncodedCommand $encoded",$fixture,$startup)
if ($result.ReturnValue -ne 0) { throw 'Could not launch isolated Electron test.' }
Write-Output $fixture
