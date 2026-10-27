$ErrorActionPreference='Stop'
$root=Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$output=Join-Path $root '.tools/ai-control'
New-Item -ItemType Directory -Force -Path $output | Out-Null
$native=Join-Path $root 'windows/remote-desktop'
$manifest=Get-Content -LiteralPath (Join-Path $native 'files.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$sources=@($manifest.serviceSources | ForEach-Object {Join-Path $native $_})
$wpf=Join-Path $env:SystemRoot 'Microsoft.NET/Framework64/v4.0.30319/WPF'
& "$env:SystemRoot/Microsoft.NET/Framework64/v4.0.30319/csc.exe" /nologo /codepage:65001 /target:exe /platform:x64 /optimize+ "/out:$output/ClipRelay.Remote.Service.exe" /r:System.ServiceProcess.dll /r:System.Management.dll /r:System.Web.Extensions.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll "/r:$wpf/UIAutomationClient.dll" "/r:$wpf/UIAutomationTypes.dll" "/r:$wpf/WindowsBase.dll" @sources
if($LASTEXITCODE -ne 0){throw 'Automation worker compilation failed.'}
