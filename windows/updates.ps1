# The update channel is separate from Android and never depends on LAN peers.
$script:relayUpdateBase = 'https://124-221-36-36.anyip.dev:8443/cliprelay/windows'
$script:relayUpdateState = $null
$script:relayUpdateBalloon = $false

function Initialize-RelayUpdater {
    if ($null -ne $script:relayUpdateState) { return }
    if (-not ('ClipRelay.UpdateTransfer' -as [type])) {
        Add-Type -Path (Join-Path $PSScriptRoot 'update-client.cs')
    }
    $version = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'version.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $directory = Join-Path $env:LOCALAPPDATA 'ClipRelay'
    $saved = $null
    $statePath = Join-Path $directory 'update-state.json'
    try { $saved = Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 -ErrorAction Stop | ConvertFrom-Json } catch {}
    $script:relayUpdateState = [PSCustomObject]@{
        Current = $version; Release = $null; Transfer = $null; Operation = ''; Error = ''
        Checked = $false; NextCheck = [DateTime]::UtcNow.AddSeconds(10); FilePath = ''
        StatePath = $statePath; DownloadDirectory = (Join-Path $directory 'Downloads')
        Notify = ($null -eq $saved -or (Get-PropertyValue $saved 'notify') -ne $false)
        LastNotified = [int](Get-PropertyValue $saved 'lastNotified')
    }
}

function Save-RelayUpdatePreferences {
    $state = $script:relayUpdateState
    try {
        [IO.Directory]::CreateDirectory((Split-Path $state.StatePath)) | Out-Null
        @{ notify = $state.Notify; lastNotified = $state.LastNotified } |
            ConvertTo-Json | Set-Content -LiteralPath $state.StatePath -Encoding UTF8
    } catch { }
}

function ConvertFrom-RelayUpdateManifest {
    param([string]$Json)
    if ($Json.Length -gt 131072) { throw '更新说明过大。' }
    $info = $Json | ConvertFrom-Json
    $code = Get-PropertyValue $info 'versionCode'
    $name = Get-PropertyValue $info 'versionName'
    $size = Get-PropertyValue $info 'sizeBytes'
    $hash = Get-PropertyValue $info 'sha256'
    $notes = Get-PropertyValue $info 'releaseNotes'
    $url = Get-PropertyValue $info 'downloadUrl'
    if (($code -isnot [int] -and $code -isnot [long]) -or $code -le 0 -or $code -gt [int]::MaxValue -or
        $name -isnot [string] -or $name -cnotmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$' -or
        ($size -isnot [int] -and $size -isnot [long]) -or $size -le 0 -or $size -gt 512MB -or
        $hash -isnot [string] -or $hash -cnotmatch '^[a-f0-9]{64}$' -or
        $notes -isnot [string] -or [string]::IsNullOrWhiteSpace($notes) -or $notes.Length -gt 20000) {
        throw '更新信息不完整，请稍后重试。'
    }
    # An exact, versioned URL prevents arbitrary schemes, redirects, paths and hosts.
    $expected = "$script:relayUpdateBase/ClipRelay-Windows-$name.zip"
    if ($url -isnot [string] -or $url -cne $expected) { throw '安装包地址不属于 ClipRelay 更新服务。' }
    return [PSCustomObject]@{ versionCode=[int]$code; versionName=$name; sizeBytes=[long]$size; sha256=$hash; releaseNotes=$notes; downloadUrl=$url }
}

function Start-RelayUpdateCheck {
    $state = $script:relayUpdateState
    if ($null -eq $state -or $null -ne $state.Transfer) { return }
    $state.Error = ''
    $state.Operation = 'check'
    $state.NextCheck = [DateTime]::UtcNow.AddMinutes(15)
    $state.Transfer = [ClipRelay.UpdateTransfer]::Check("$script:relayUpdateBase/update.json")
}

function Start-RelayUpdateDownload {
    $state = $script:relayUpdateState
    if ($null -ne $state.Transfer -or $null -eq $state.Release) { return }
    $release = $state.Release
    $path = Join-Path $state.DownloadDirectory "ClipRelay-Windows-$($release.versionName).zip"
    $state.Error = ''; $state.FilePath = ''; $state.Operation = 'download'
    $state.Transfer = [ClipRelay.UpdateTransfer]::Download($release.downloadUrl, $path, $release.sizeBytes, $release.sha256)
}

function Update-RelayUpdateState {
    $state = $script:relayUpdateState
    if ($null -eq $state) { return }
    if ($null -ne $state.Transfer -and $state.Transfer.Done) {
        $transfer = $state.Transfer
        $state.Transfer = $null
        try {
            if ($transfer.Error) { throw $transfer.Error }
            if ($state.Operation -eq 'check') {
                $release = ConvertFrom-RelayUpdateManifest $transfer.Content
                $state.Checked = $true
                if ($release.versionCode -gt $state.Current.versionCode) {
                    # A stale CDN/response must not roll a known newer offer back.
                    if ($null -eq $state.Release -or $release.versionCode -gt $state.Release.versionCode) {
                        $state.Release = $release; $state.FilePath = ''
                    }
                    elseif ($release.versionCode -eq $state.Release.versionCode -and $release.sha256 -ne $state.Release.sha256) {
                        throw '同一版本的安装包发生变化，请稍后重试。'
                    }
                }
            }
            else { $state.FilePath = $transfer.FilePath }
        } catch { $state.Error = [string]$_.Exception.Message }
        finally { $transfer.Dispose(); $state.Operation = '' }
        if (!$state.Error -and $null -ne $state.Release -and $state.Notify -and $state.LastNotified -lt $state.Release.versionCode) {
            $state.LastNotified = $state.Release.versionCode
            Save-RelayUpdatePreferences
            if ($null -ne $script:notifyIcon) {
                $script:relayUpdateBalloon = $true
                $script:notifyIcon.ShowBalloonTip(8000, "ClipRelay $($state.Release.versionName) 已发布", '点击查看更新内容并下载。', [Windows.Forms.ToolTipIcon]::Info)
            }
        }
    }
    if ($null -eq $state.Transfer -and [DateTime]::UtcNow -ge $state.NextCheck) { Start-RelayUpdateCheck }
    if ($null -ne $script:updateMenuItem) {
        $script:updateMenuItem.Text = if ($null -ne $state.Release) { "发现新版 $($state.Release.versionName) · 查看更新" } else { "版本更新 · v$($state.Current.versionName)" }
    }
}

function Get-RelayUpdateSnapshot {
    $state = $script:relayUpdateState
    return [PSCustomObject]@{
        CurrentVersion = $state.Current.versionName; Release = $state.Release
        Operation = $state.Operation; Error = $state.Error; Checked = $state.Checked
        Received = $(if ($null -ne $state.Transfer) { $state.Transfer.Received } else { 0 })
        FilePath = $state.FilePath; Notify = $state.Notify
    }
}

function Set-RelayUpdateNotifications {
    param([bool]$Enabled)
    $script:relayUpdateState.Notify = $Enabled
    Save-RelayUpdatePreferences
}

function Open-RelayUpdateDownload {
    $path = $script:relayUpdateState.FilePath
    if ($path -and (Test-Path -LiteralPath $path)) {
        Start-Process -FilePath 'explorer.exe' -ArgumentList "/select,`"$path`""
    }
    else { $script:relayUpdateState.FilePath = ''; $script:relayUpdateState.Error = '安装包已移走，请重新下载。' }
}

function Stop-RelayUpdater {
    if ($null -ne $script:relayUpdateState -and $null -ne $script:relayUpdateState.Transfer) {
        $script:relayUpdateState.Transfer.Dispose()
    }
}

function Show-RelayUpdates {
    param([Windows.Forms.Form]$Owner = $null)
    $existing = @([Windows.Forms.Application]::OpenForms | Where-Object Name -eq 'ClipRelayUpdates')
    if ($existing.Count -gt 0) { $existing[0].Activate(); return }
    $snapshotCommand = Get-Command Get-RelayUpdateSnapshot
    $checkCommand = Get-Command Start-RelayUpdateCheck
    $downloadCommand = Get-Command Start-RelayUpdateDownload
    $openCommand = Get-Command Open-RelayUpdateDownload
    $notifyCommand = Get-Command Set-RelayUpdateNotifications
    $colors = @{ Background=[Drawing.ColorTranslator]::FromHtml('#111318'); Surface=[Drawing.ColorTranslator]::FromHtml('#171a24'); Raised=[Drawing.ColorTranslator]::FromHtml('#202534'); Border=[Drawing.ColorTranslator]::FromHtml('#262c3c'); Text=[Drawing.ColorTranslator]::FromHtml('#f1f5f9'); Muted=[Drawing.ColorTranslator]::FromHtml('#94a3b8'); Blue=[Drawing.ColorTranslator]::FromHtml('#3b82f6'); Cyan=[Drawing.ColorTranslator]::FromHtml('#38bdf8'); Danger=[Drawing.ColorTranslator]::FromHtml('#fb7185') }
    $form = New-Object ClipRelay.RelayForm
    $form.Name = 'ClipRelayUpdates'; $form.Text = 'ClipRelay 版本更新'
    $form.ClientSize = [Drawing.Size]::new(560, 520)
    $form.BackColor = $colors.Background
    $form.StartPosition = [Windows.Forms.FormStartPosition]::CenterScreen
    $form.ShowInTaskbar = $null -eq $Owner
    if ($null -ne $script:appIcon) { $form.Icon = $script:appIcon }
    $label = {
        param($Text,$X,$Y,$Width,$Height,$Size,$Color,$Bold=$false)
        $control = New-Object Windows.Forms.Label
        $control.Text=$Text; $control.SetBounds($X,$Y,$Width,$Height)
        $style = if ($Bold) { [Drawing.FontStyle]::Bold } else { [Drawing.FontStyle]::Regular }
        $control.Font=[Drawing.Font]::new('Microsoft YaHei UI',$Size,$style)
        $control.ForeColor=$Color; $control.BackColor=[Drawing.Color]::Transparent
        $form.Controls.Add($control); return $control
    }.GetNewClosure()
    $button = {
        param($Text,$X,$Y,$Width,$Primary=$false)
        $control=New-Object ClipRelay.RelayButton
        $control.Text=$Text; $control.SetBounds($X,$Y,$Width,40)
        $control.Font=[Drawing.Font]::new('Microsoft YaHei UI',9,[Drawing.FontStyle]::Bold)
        $control.FillColor=if($Primary){$colors.Blue}else{$colors.Surface}
        $control.BackColor=$control.FillColor; $control.TextColor=$colors.Text
        $control.HoverColor=$colors.Raised; $control.BorderColor=$colors.Border
        $form.Controls.Add($control); return $control
    }.GetNewClosure()
    $brand=& $label 'CLIP / RELAY' 26 18 300 20 8.5 $colors.Cyan $true
    $brand.Font=[Drawing.Font]::new('Cascadia Mono',8.5,[Drawing.FontStyle]::Bold)
    $heading=& $label '版本更新' 24 47 450 40 21 $colors.Text $true
    $heading.Name='UpdateHeading'
    $version=& $label '' 26 96 508 24 9 $colors.Muted
    $version.Name='UpdateVersion'
    foreach($control in @($brand,$heading)){[ClipRelay.NativeMethods]::AttachDrag($control,$form)}
    $close=& $button '×' 498 12 36
    $close.Name='CloseUpdates'; $close.Add_Click({$form.Close()}.GetNewClosure())
    $null=& $label '本次更新' 26 140 400 24 10 $colors.Text $true
    $notes=New-Object Windows.Forms.RichTextBox
    $notes.Name='ReleaseNotes'; $notes.SetBounds(26,174,508,164)
    $notes.Multiline=$true; $notes.ReadOnly=$true; $notes.ScrollBars='Vertical'; $notes.BorderStyle='None'; $notes.DetectUrls=$false
    $notes.BackColor=$colors.Surface; $notes.ForeColor=$colors.Text
    $notes.Font=[Drawing.Font]::new('Microsoft YaHei UI',10)
    $form.Controls.Add($notes)
    $status=& $label '' 26 352 508 42 9 $colors.Muted
    $status.Name='UpdateStatus'
    $null=& $label '发现新版时通知我' 26 405 400 24 9 $colors.Muted
    $notify=New-Object ClipRelay.RelayToggle
    $notify.Name='UpdateNotifications'; $notify.AccessibleName='发现新版时通知我'
    $notify.Location=[Drawing.Point]::new(490,402); $notify.OnColor=$colors.Blue
    $notify.Checked=(& $snapshotCommand).Notify
    $notify.Add_CheckedChanged({& $notifyCommand -Enabled $notify.Checked}.GetNewClosure())
    $form.Controls.Add($notify)
    $check=& $button '检查更新' 24 456 124
    $check.Name='CheckUpdates'
    $later=& $button '稍后' 282 456 90
    $later.Add_Click({$form.Close()}.GetNewClosure()); $form.CancelButton=$later
    $download=& $button '下载新版' 384 456 152 $true
    $download.Name='DownloadUpdate'
    $render={
        $snapshot=& $snapshotCommand
        $available=$null -ne $snapshot.Release
        $heading.Text=if($available){'有新版本可以下载'}else{'版本更新'}
        $version.Text=if($available){"v$($snapshot.CurrentVersion)  →  v$($snapshot.Release.versionName)    ·    Windows"}else{"当前版本 v$($snapshot.CurrentVersion)    ·    Windows"}
        $content=if($available){$snapshot.Release.releaseNotes}else{'发布新版本后，这里会显示更新内容。'}
        $content=$content -replace '\r?\n',"`r`n"
        if($notes.Text -ne $content){$notes.Text=$content}
        $check.Enabled=!$snapshot.Operation
        $download.Enabled=$available -and !$snapshot.Operation
        $download.Text=if($snapshot.FilePath){'打开下载位置'}elseif($snapshot.Operation -eq 'download'){'正在下载…'}else{'下载新版'}
        $status.ForeColor=if($snapshot.Error){$colors.Danger}else{$colors.Muted}
        $status.Text=if($snapshot.Error){$snapshot.Error}
            elseif($snapshot.Operation -eq 'download'){"正在下载 {0:N1} / {1:N1} MB，关闭窗口后仍会继续。" -f ($snapshot.Received/1MB),($snapshot.Release.sizeBytes/1MB)}
            elseif($snapshot.Operation -eq 'check'){'正在检查更新…'}
            elseif($snapshot.FilePath){'下载完成并已校验。解压后双击 Install.cmd，保留现有设备设置。'}
            elseif($available){"安装包 {0:N1} MB · 下载后由你选择安装时间。" -f ($snapshot.Release.sizeBytes/1MB)}
            elseif($snapshot.Checked){'已是最新版本。运行期间每 15 分钟自动检查。'}
            else{'运行期间每 15 分钟自动检查，也可以立即检查。'}
    }.GetNewClosure()
    $check.Add_Click({& $checkCommand; & $render}.GetNewClosure())
    $download.Add_Click({if((& $snapshotCommand).FilePath){& $openCommand}else{& $downloadCommand}; & $render}.GetNewClosure())
    $timer=New-Object Windows.Forms.Timer
    $timer.Interval=250; $timer.Add_Tick($render)
    $form.Add_FormClosed({$timer.Stop();$timer.Dispose();$form.Dispose()}.GetNewClosure())
    & $render
    $form.EnableDpiLayout()
    if($null -ne $Owner){$form.Show($Owner)}else{$form.Show()}
    $timer.Start()
    if(-not (& $snapshotCommand).Checked){& $checkCommand}
}
