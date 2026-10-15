$ErrorActionPreference='Stop'
$repository=(Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$output=Join-Path $repository '.tools\uu-parity\session-lock-tests.exe'
$wpf=Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\WPF'
& "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /codepage:65001 /target:exe /platform:x64 /main:SessionLockTests "/out:$output" /r:System.Web.Extensions.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll "/r:$wpf\UIAutomationClient.dll" "/r:$wpf\UIAutomationTypes.dll" "/r:$wpf\WindowsBase.dll" (Join-Path $PSScriptRoot 'session-lock.cs') (Join-Path $repository 'windows\remote-desktop\session-lock.cs') (Join-Path $repository 'windows\remote-desktop\privacy-screen.cs') (Join-Path $repository 'windows\remote-desktop\desktop-user.cs') (Join-Path $repository 'windows\remote-desktop\input-focus.cs')
if ($LASTEXITCODE -ne 0) { throw 'Session lock test build failed' }
& $output
if ($LASTEXITCODE -ne 0) { throw 'Session lock tests failed' }
