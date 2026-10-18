$ErrorActionPreference='Stop'
$repository=(Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$output=Join-Path $repository '.tools\uu-parity\clipboard-exchange-tests.exe'
$wpf=Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\WPF'
& "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /target:exe /platform:x64 /main:ClipboardExchangeTests "/out:$output" /r:System.Web.Extensions.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll "/r:$wpf\UIAutomationClient.dll" "/r:$wpf\UIAutomationTypes.dll" "/r:$wpf\WindowsBase.dll" (Join-Path $PSScriptRoot 'clipboard-exchange.cs') (Join-Path $repository 'windows\remote-desktop\clipboard-exchange.cs') (Join-Path $repository 'windows\remote-desktop\desktop-user.cs') (Join-Path $repository 'windows\remote-desktop\input-focus.cs')
if ($LASTEXITCODE -ne 0) { throw 'Clipboard test build failed' }
& $output
if ($LASTEXITCODE -ne 0) { throw 'Clipboard tests failed' }
