[CmdletBinding()]
param()
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Web.Extensions,System.ServiceProcess
$repo = Split-Path (Split-Path $PSScriptRoot)
$fixture = Join-Path $repo ('.tools\code-rotation-' + [Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($fixture)
$settingsFile = Join-Path $fixture 'service.json'
$helperFile = Join-Path $fixture 'helper.cjs'
$logFile = Join-Path $fixture 'requests.jsonl'
$helper = @'
const fs=require('node:fs'),readline=require('node:readline');
let current='12345678',lost=false;
readline.createInterface({input:process.stdin}).on('line',line=>{
  const req=JSON.parse(line);fs.appendFileSync(process.argv[2],JSON.stringify(req)+'\n');
  if(req.action!=='device-code-rotate'||req.previous!=='12345678')throw Error('Unexpected request');
  if(current===req.previous)current='87654321';
  if(!lost){lost=true;process.stdout.write(JSON.stringify({ok:false,error:'Simulated lost response'})+'\n');return;}
  process.stdout.write(JSON.stringify({ok:true,data:{value:current}})+'\n');
});
'@
[IO.File]::WriteAllText($helperFile,$helper,[Text.UTF8Encoding]::new($false))
$assembly = [Reflection.Assembly]::LoadFrom((Join-Path $repo 'windows\remote-desktop\bin\ClipRelay.Remote.Service.exe'))
$type = $assembly.GetType('ClipRelay.Remote.HostService',$true)
$instanceFlags = [Reflection.BindingFlags]'Instance,NonPublic'
$staticFlags = [Reflection.BindingFlags]'Static,NonPublic'
$pathField = $type.GetField('SettingsPath',$staticFlags)
# This is an isolated, non-started service object. Redirect its private path
# before calling any method that could persist; never touch installed state.
$pathField.SetValue($null,$settingsFile)
if ($pathField.GetValue($null) -cne $settingsFile) { throw 'Test settings path was not isolated.' }
$json = New-Object Web.Script.Serialization.JavaScriptSerializer
$config = $json.DeserializeObject('{"deviceCode":"12345678","requireDeviceCode":true,"enabled":true,"networkEnabled":true}')
[IO.File]::WriteAllText($settingsFile,$json.Serialize($config),[Text.UTF8Encoding]::new($false))
$psi = New-Object Diagnostics.ProcessStartInfo
$psi.FileName = (Get-Command node.exe).Source
$psi.Arguments = '"' + $helperFile + '" "' + $logFile + '"'
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
$psi.RedirectStandardInput = $true
$psi.RedirectStandardOutput = $true
$worker = [Diagnostics.Process]::Start($psi)
$service = $null
try {
    $workerId = $worker.Id
    $service = [Activator]::CreateInstance($type)
    $type.GetField('settings',$instanceFlags).SetValue($service,$config)
    $type.GetField('networkChild',$instanceFlags).SetValue($service,$worker)
    $method = $type.GetMethod('DeviceCode',$instanceFlags)
    $failed = $false
    try { [void]$method.Invoke($service,@($true)) } catch { $failed = $_.Exception.ToString().Contains('Simulated lost response') }
    if (!$failed) { throw 'Lost response did not surface as a failure.' }
    $pending = $json.DeserializeObject([IO.File]::ReadAllText($settingsFile))
    if (!$pending.deviceCodeUpdating -or $pending.deviceCode -ne '12345678') { throw 'Retry state was not durably saved.' }
    # Recreate the in-memory service as after a crash. A read resumes the exact
    # pending update instead of returning the obsolete code or rotating again.
    $service.Dispose()
    $service = [Activator]::CreateInstance($type)
    $type.GetField('settings',$instanceFlags).SetValue($service,$pending)
    $type.GetField('networkChild',$instanceFlags).SetValue($service,$worker)
    $result = $method.Invoke($service,@($false))
    if ($result.value -ne '87654321') { throw 'Pending update did not recover.' }
    $saved = $json.DeserializeObject([IO.File]::ReadAllText($settingsFile))
    if ($saved.deviceCodeUpdating -or $saved.deviceCode -ne '87654321' -or !$saved.enabled -or !$saved.networkEnabled -or !$saved.requireDeviceCode) { throw 'Rotation changed unrelated settings.' }
    [void]$method.Invoke($service,@($false))
    if (@(Get-Content -LiteralPath $logFile).Count -ne 2) { throw 'Read unexpectedly rotated the device code again.' }
    if ($worker.HasExited -or $worker.Id -ne $workerId) { throw 'Rotation stopped the active network helper.' }
    Write-Output 'PASS: lost response and service restart recover the same code; ordinary reads do not rotate; existing network helper and connection settings are preserved.'
} finally {
    if (!$worker.HasExited) { $worker.Kill(); [void]$worker.WaitForExit(3000) }
    $worker.Dispose()
    if ($null -ne $service) { $service.Dispose() }
}
