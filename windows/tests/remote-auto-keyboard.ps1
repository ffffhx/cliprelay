[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$StatePath, [int]$DurationSeconds=20, [switch]$WaitForActivation, [switch]$ActivateOnce, [switch]$ShowForPhoneTest)
# Optional single activation or bounded topmost display for a phone test;
# never reclaims focus, moves the cursor, or extends beyond the bounded duration.
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
Add-Type -ReferencedAssemblies System.Windows.Forms -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class KeyboardTargetNative { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId); } public class KeyboardTargetForm : System.Windows.Forms.Form { protected override bool ShowWithoutActivation { get { return true; } } }'
[void][KeyboardTargetNative]::SetProcessDPIAware()
$form=if ($WaitForActivation) { New-Object KeyboardTargetForm } else { New-Object Windows.Forms.Form }
$form.Text='ClipRelay keyboard test - closes on focus loss'
$form.ClientSize=New-Object Drawing.Size(620,310)
$form.StartPosition='Manual'; $form.Location=New-Object Drawing.Point(40,100)
$form.FormBorderStyle='FixedDialog'; $form.MaximizeBox=$false; $form.TopMost=[bool]$ShowForPhoneTest
$form.Font=New-Object Drawing.Font('Segoe UI',12)
$button=New-Object Windows.Forms.Button
$button.Text='Normal button'; $button.SetBounds(20,20,260,48); $form.Controls.Add($button)
$edit=New-Object Windows.Forms.TextBox
$edit.SetBounds(20,95,570,32); $form.Controls.Add($edit)
$alternate=New-Object Windows.Forms.TextBox
$alternate.SetBounds(20,95,570,32); $alternate.Visible=$false; $form.Controls.Add($alternate)
$session=New-Object Windows.Forms.Label
$session.Text='Switch session (autofocus)'; $session.SetBounds(310,20,285,48); $form.Controls.Add($session)
$readOnly=New-Object Windows.Forms.TextBox
$readOnly.ReadOnly=$true; $readOnly.Text='Read-only text'; $readOnly.SetBounds(20,155,570,32); $form.Controls.Add($readOnly)
$label=New-Object Windows.Forms.Label
$label.Text='Blank area: preserve the editor focus without opening the keyboard.'
$label.SetBounds(20,215,570,60); $form.Controls.Add($label)
$state=@{foreground=$false; closed=$false; clicks=0; activated=$false; sessions=0; blankClicks=0; inputFocused=$false; closeReason='requested'}
$save={ [IO.File]::WriteAllText($StatePath,($state | ConvertTo-Json -Depth 3),[Text.UTF8Encoding]::new($false)) }.GetNewClosure()
$bounds={param($control) $r=$control.RectangleToScreen($control.ClientRectangle); return @($r.Left,$r.Top,$r.Right,$r.Bottom)}
$button.Add_Click({$state.clicks++; & $save}.GetNewClosure())
$session.Add_Click({
    $state.sessions++
    if ($state.sessions % 2 -eq 1) {
        $alternate.Visible=$true; $alternate.BringToFront(); [void]$alternate.Focus(); $edit.Visible=$false
    } else {
        $edit.Visible=$true; $edit.BringToFront(); [void]$edit.Focus(); $alternate.Visible=$false
    }
    & $save
}.GetNewClosure())
$label.Add_Click({$state.blankClicks++; & $save}.GetNewClosure())
$state.deadline=[DateTime]::UtcNow.AddSeconds($(if ($WaitForActivation) {180} else {[Math]::Min(45,[Math]::Max(5,$DurationSeconds))}))
$timer=New-Object Windows.Forms.Timer; $timer.Interval=50
$timer.Add_Tick({
    $state.foreground=[KeyboardTargetNative]::GetForegroundWindow() -eq $form.Handle
    $state.inputFocused=$edit.Focused -or $alternate.Focused
    if ($state.foreground -and !$state.activated) {
        $state.activated=$true
        if ($WaitForActivation) { $state.deadline=[DateTime]::UtcNow.AddSeconds([Math]::Min(45,[Math]::Max(5,$DurationSeconds))) }
    }
    & $save
    if ($state.activated -and !$state.foreground) {
        [uint32]$foregroundPid=0
        [void][KeyboardTargetNative]::GetWindowThreadProcessId([KeyboardTargetNative]::GetForegroundWindow(), [ref]$foregroundPid)
        $state.closeReason='focus_lost'
        try { $state.foregroundProcess=[Diagnostics.Process]::GetProcessById($foregroundPid).ProcessName } catch {}
        $form.Close()
    } elseif ([DateTime]::UtcNow -ge $state.deadline) { $state.closeReason='timeout'; $form.Close() }
}.GetNewClosure())
$form.Add_Shown({
    $state.hwnd=$form.Handle.ToInt64()
    $state.inputBounds=& $bounds $edit; $state.buttonBounds=& $bounds $button; $state.readOnlyBounds=& $bounds $readOnly
    $state.sessionBounds=& $bounds $session; $state.blankBounds=& $bounds $label
    $button.Select(); & $save; $timer.Start()
    if ($ActivateOnce) { [void][KeyboardTargetNative]::SetForegroundWindow($form.Handle) }
}.GetNewClosure())
try { [void]$form.ShowDialog() } finally {
    $state.closed=$true; $state.foreground=$false; & $save
    $timer.Stop(); $timer.Dispose(); $form.Dispose()
}
