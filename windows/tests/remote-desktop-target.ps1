[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$StatePath, [int]$DurationSeconds=60)
# Interactive test surface. Only this window receives test clicks and text.
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type 'using System; using System.Runtime.InteropServices; public static class RemoteTestDpi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); }'
[void][RemoteTestDpi]::SetProcessDPIAware()
Add-Type -Path (Join-Path (Split-Path $PSScriptRoot) 'remote-desktop\bin\ClipRelay.Remote.Client.dll')
$StatePath=[IO.Path]::GetFullPath($StatePath)
$form=New-Object Windows.Forms.Form
$form.Text='ClipRelay remote input test'
$form.FormBorderStyle='FixedDialog';$form.WindowState='Normal';$form.TopMost=$false
$form.ClientSize=New-Object Drawing.Size(740,460)
$form.StartPosition='Manual';$form.Location=New-Object Drawing.Point(20,80)
$form.MaximizeBox=$false
$form.AutoScaleMode='None'
$form.BackColor=[Drawing.Color]::FromArgb(18,28,46)
$form.Font=New-Object Drawing.Font('Segoe UI',12)
$title=New-Object Windows.Forms.Label
$title.Text='ClipRelay remote input test - close this window at any time'
$title.ForeColor=[Drawing.Color]::White;$title.SetBounds(20,20,700,45)
$form.Controls.Add($title)
$button=New-Object Windows.Forms.Button
$button.Text='CLICK TEST';$button.BackColor=[Drawing.Color]::White;$button.SetBounds(20,90,240,70)
$form.Controls.Add($button)
$textBox=New-Object Windows.Forms.TextBox
$textBox.SetBounds(20,200,680,40)
$form.Controls.Add($textBox)
$result=New-Object Windows.Forms.Label
$result.ForeColor=[Drawing.Color]::LightGreen;$result.SetBounds(20,275,680,55)
$form.Controls.Add($result)
$clock=New-Object Windows.Forms.Label
$clock.ForeColor=[Drawing.Color]::LightSkyBlue;$clock.SetBounds(20,365,680,50)
$form.Controls.Add($clock)
$state=@{clicks=0;rightClicks=0;wheel=0;text='';keys=@();foreground=$false;activated=$false;started=[DateTime]::UtcNow.ToString('o')}
$save={
    $result.Text="Clicks: $($state.clicks)    Right clicks: $($state.rightClicks)    Wheel: $($state.wheel)"
    [IO.File]::WriteAllText($StatePath,($state|ConvertTo-Json -Depth 4),[Text.UTF8Encoding]::new($false))
}.GetNewClosure()
$button.Add_Click({$state.clicks++;& $save}.GetNewClosure())
$button.Add_MouseDown({param($sender,$event) if($event.Button -eq 'Right'){$state.rightClicks++;& $save}}.GetNewClosure())
$form.Add_MouseDown({param($sender,$event) if($event.Button -eq 'Right'){$state.rightClicks++;& $save}}.GetNewClosure())
$form.Add_MouseWheel({param($sender,$event) $state.wheel+=$event.Delta;& $save}.GetNewClosure())
$textBox.Add_TextChanged({$state.text=$textBox.Text;& $save}.GetNewClosure())
$form.KeyPreview=$true
$form.Add_KeyDown({param($sender,$event) $state.keys+= $event.KeyCode.ToString();& $save}.GetNewClosure())
$deadline=[DateTime]::UtcNow.AddSeconds($DurationSeconds)
$timer=New-Object Windows.Forms.Timer
$timer.Interval=100
$timer.Add_Tick({
    $clock.Text=[DateTime]::Now.ToString('HH:mm:ss.fff')+' - live desktop video'
    $foreground=[RemoteTestDpi]::GetForegroundWindow() -eq $form.Handle
    if($foreground -ne $state.foreground){$state.foreground=$foreground;& $save}
    if($foreground){$state.activated=$true}
    if($state.activated -and !$foreground){$form.Close()}
    if([DateTime]::UtcNow -gt $deadline){$form.Close()}
}.GetNewClosure())
$form.Add_Shown({
    $state.buttonBounds=$button.RectangleToScreen($button.ClientRectangle).ToString()
    $state.inputBounds=$textBox.RectangleToScreen($textBox.ClientRectangle).ToString()
    $button.Select()
    $buttonCenter=$button.PointToScreen([Drawing.Point]::new(120,35))
    [Windows.Forms.Cursor]::Position=$buttonCenter
    & $save;$timer.Start()
}.GetNewClosure())
try {[void]$form.ShowDialog()} finally {
    $timer.Stop();$timer.Dispose();$form.Dispose()
    [void][ClipRelay.Remote.ControlClient]::Request('{"action":"disconnect"}')
}
