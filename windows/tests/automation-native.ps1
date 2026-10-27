$ErrorActionPreference='Stop'
$root=Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$directory=Join-Path $root '.tools/ai-control'
New-Item -ItemType Directory -Force -Path $directory | Out-Null
$binary=Join-Path $directory 'automation-native-test.exe'
$wpf=Join-Path $env:SystemRoot 'Microsoft.NET/Framework64/v4.0.30319/WPF'
$sources=@('automation.cs','automation-browser.cs','automation-windows.cs','input-focus.cs','desktop-user.cs') | ForEach-Object {Join-Path (Join-Path $root 'windows/remote-desktop') $_}
& "$env:SystemRoot/Microsoft.NET/Framework64/v4.0.30319/csc.exe" /nologo /codepage:65001 /target:exe /platform:x64 /main:AutomationNativeTest "/out:$binary" /r:System.Web.Extensions.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll "/r:$wpf/UIAutomationClient.dll" "/r:$wpf/UIAutomationTypes.dll" "/r:$wpf/WindowsBase.dll" (Join-Path $PSScriptRoot 'automation-native.cs') @sources
if($LASTEXITCODE -ne 0){throw 'Native automation tests did not compile.'}
& $binary
exit $LASTEXITCODE
