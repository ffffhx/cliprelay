param([string]$ReportPath='')
$ErrorActionPreference='Stop'
$repository=(Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$root=Join-Path $repository '.tools\uu-parity'
[void][IO.Directory]::CreateDirectory($root)
if(!$ReportPath){$ReportPath=Join-Path $root 'service-process-access-report.json'}
$output=Join-Path $root 'service-process-access-tests.exe'
& "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /target:exe /platform:x64 /r:System.Web.Extensions.dll "/out:$output" (Join-Path $PSScriptRoot 'service-process-access.cs') (Join-Path $repository 'windows\remote-desktop\service-process-access.cs')
if($LASTEXITCODE -ne 0){throw 'Process access fixture build failed'}
$testId=[Guid]::NewGuid().ToString('N')
$folder=Join-Path $root ('service-process-access-'+$testId)
[void][IO.Directory]::CreateDirectory($folder)
$taskName='ClipRelay-Process-Access-Test-'+$testId
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$action=New-ScheduledTaskAction -Execute $output -Argument ('--server '+$sid+' "'+$folder+'"')
$principal=New-ScheduledTaskPrincipal -UserId 'S-1-5-18' -LogonType ServiceAccount -RunLevel Highest
function Wait-Receipt([string]$name){
 $deadline=[DateTime]::UtcNow.AddSeconds(15)
 while([DateTime]::UtcNow -lt $deadline){
  if(Test-Path (Join-Path $folder 'server-error.json')){throw (Get-Content (Join-Path $folder 'server-error.json') -Raw)}
  if(Test-Path (Join-Path $folder $name)){
   try{return (Get-Content (Join-Path $folder $name) -Raw | ConvertFrom-Json)}catch{}
  }
  Start-Sleep -Milliseconds 100
 }
 throw "Missing process fixture receipt: $name"
}
try{
 Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal | Out-Null
 Start-ScheduledTask -TaskName $taskName
 $ready=Wait-Receipt 'ready.json'
 & $output --client $ready.pid (Join-Path $folder 'before.json')
 if($LASTEXITCODE -ne 0){throw 'Restricted baseline client failed'}
 $before=Get-Content (Join-Path $folder 'before.json') -Raw | ConvertFrom-Json
 if(@($before.results | Where-Object {$_.opened}).Count){throw 'Fixture baseline unexpectedly permits operator access'}
 [IO.File]::WriteAllText((Join-Path $folder 'grant'),'grant')
 $grant=Wait-Receipt 'granted.json'
 & $output --client $ready.pid (Join-Path $folder 'after.json')
 if($LASTEXITCODE -ne 0){throw 'Restricted operator client failed'}
 $after=Get-Content (Join-Path $folder 'after.json') -Raw | ConvertFrom-Json
 foreach($row in $after.results){
  $allowed=$row.access -in @('0x00101000','0x00001000')
  if($row.opened -ne $allowed){throw ('Unexpected process access: '+$row.access)}
  if($allowed -and (!$row.exitCodeQueried -or $row.exitCode -ne 259)){throw 'Live process query failed'}
  if($row.access -eq '0x00101000' -and $row.wait -ne 258){throw 'Live process wait failed'}
 }
 [ordered]@{passed=$true;systemFixture=$true;restrictedDesktopToken=$true;before=$before;after=$after;grant=$grant;evidenceDirectory=$folder} | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $ReportPath -Encoding UTF8
 Write-Host 'PASS: ordinary operator can query/wait; memory, terminate and DACL write remain denied; existing ACEs preserved.'
}finally{
 [IO.File]::WriteAllText((Join-Path $folder 'stop'),'stop')
 $deadline=[DateTime]::UtcNow.AddSeconds(5)
 while((Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue).State -eq 'Running' -and [DateTime]::UtcNow -lt $deadline){Start-Sleep -Milliseconds 100}
 if((Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue).State -eq 'Running'){Stop-ScheduledTask -TaskName $taskName}
 Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
}
