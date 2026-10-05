function Show-RemoteDesktopSettings {
    param([Windows.Forms.IWin32Window]$Owner = $null)
    $moduleRoot = Join-Path $PSScriptRoot 'remote-desktop'
    if (!(Test-Path -LiteralPath $moduleRoot)) { $moduleRoot = $PSScriptRoot }
    try {
        if (!('ClipRelay.Remote.ControlClient' -as [type])) {
            Add-Type -Path (Join-Path $moduleRoot 'bin\ClipRelay.Remote.Client.dll')
        }
    } catch {
        [Windows.Forms.MessageBox]::Show('远控组件尚未安装，请重新运行 ClipRelay 安装程序。', 'ClipRelay') | Out-Null
        return
    }
    $form = New-Object Windows.Forms.Form
    $form.Text = 'ClipRelay · 手机远控'
    $form.Name = 'RemoteDesktopSettings'
    $form.Size = New-Object Drawing.Size(700, 660)
    $form.MinimumSize = $form.Size
    $form.StartPosition = 'CenterScreen'
    $form.Font = New-Object Drawing.Font('Microsoft YaHei UI', 10)
    $form.BackColor = [Drawing.Color]::FromArgb(245,247,250)
    $form.FormBorderStyle = 'FixedDialog'
    $form.MaximizeBox = $false

    $addLabel = {
        param($text,$x,$y,$w,$h)
        $label = New-Object Windows.Forms.Label
        $label.Text=$text; $label.Location=New-Object Drawing.Point($x,$y); $label.Size=New-Object Drawing.Size($w,$h)
        $form.Controls.Add($label); return $label
    }.GetNewClosure()
    $addButton = {
        param($text,$name,$x,$y,$w)
        $button = New-Object Windows.Forms.Button
        $button.Text=$text; $button.Name=$name; $button.AccessibleName=$text
        $button.Location=New-Object Drawing.Point($x,$y); $button.Size=New-Object Drawing.Size($w,36)
        $form.Controls.Add($button); return $button
    }.GetNewClosure()
    $title = & $addLabel '手机远控' 24 20 300 32
    $title.Font=New-Object Drawing.Font('Microsoft YaHei UI',18,[Drawing.FontStyle]::Bold)
    $status = & $addLabel '正在连接后台服务…' 24 62 315 26
    $status.AutoEllipsis=$true
    $status.Name='RemoteDesktopStatus'
    $toggle = & $addButton '开启远控' 'RemoteDesktopToggle' 510 45 140
    $networkButton = & $addButton '外网配对' 'RemoteNetworkOpen' 354 45 140
    $showNetworkCommand = Get-Command Show-RemoteNetworkSettings
    $networkButton.Add_Click({ & $showNetworkCommand -Owner $form }.GetNewClosure())
    $hint = & $addLabel '手机打开“连接电脑”，会自动发现本机；下方地址仅供手动排查。' 24 100 620 28
    $addresses = New-Object Windows.Forms.TextBox
    $addresses.Name='RemoteDesktopAddresses'; $addresses.ReadOnly=$true; $addresses.Multiline=$true
    $addresses.Location=New-Object Drawing.Point(24,132); $addresses.Size=New-Object Drawing.Size(626,58)
    $ips = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notmatch '^(127\.|169\.254\.)' } | Select-Object -ExpandProperty IPAddress -Unique)
    $addresses.Text=($ips | ForEach-Object { "${_}:48789" }) -join '    '
    $form.Controls.Add($addresses)
    $pairTitle = & $addLabel '首次配对 · 核对手机上的确认标识，再允许这台手机' 24 210 620 26
    $pending = New-Object Windows.Forms.ListBox
    $pending.Name='RemoteDesktopPairings'; $pending.DisplayMember='label'
    $pending.Location=New-Object Drawing.Point(24,244); $pending.Size=New-Object Drawing.Size(420,70)
    $form.Controls.Add($pending)
    $pin = New-Object Windows.Forms.TextBox
    $pin.Name='RemoteDesktopPin'; $pin.AccessibleName='手机配对 PIN'; $pin.MaxLength=4
    $pin.Location=New-Object Drawing.Point(462,244); $pin.Size=New-Object Drawing.Size(188,30)
    $form.Controls.Add($pin)
    $verification = & $addLabel '' 462 244 188 30
    $verification.Name='RemoteDesktopVerification'; $verification.Visible=$false
    $verification.Font=New-Object Drawing.Font('Consolas',12,[Drawing.FontStyle]::Bold)
    $pending.Add_SelectedIndexChanged({
        $automatic=$null -ne $pending.SelectedItem -and $pending.SelectedItem.automatic
        $pin.Visible=!$automatic; $verification.Visible=$automatic
        $verification.Text=if ($automatic) {$pending.SelectedItem.verification} else {''}
    }.GetNewClosure())
    $pair = & $addButton '授权这台手机' 'RemoteDesktopPair' 462 282 188
    $clientTitle = & $addLabel '已授权的手机' 24 337 600 26
    $clients = New-Object Windows.Forms.ListBox
    $clients.Name='RemoteDesktopClients'; $clients.DisplayMember='label'
    $clients.Location=New-Object Drawing.Point(24,370); $clients.Size=New-Object Drawing.Size(420,96)
    $form.Controls.Add($clients)
    $revoke = & $addButton '撤销选中授权' 'RemoteDesktopRevoke' 462 370 188
    $disconnect = & $addButton '断开当前远控' 'RemoteDesktopDisconnect' 462 422 188
    $message = & $addLabel '配对授权后，手机下次可直接连接。关闭远控会停止接收连接。' 24 486 626 50
    $message.Name='RemoteDesktopMessage'
    $license = & $addLabel '内置 Sunshine 远控引擎 · GPLv3 开源组件' 24 562 465 26
    $license.ForeColor=[Drawing.Color]::DimGray
    $close = & $addButton '完成' 'RemoteDesktopClose' 550 554 100
    $close.Add_Click({ $form.Close() }.GetNewClosure())
    $ui = @{ Task=$null; Action=''; Enabled=$false; Running=$false; Next=[DateTime]::MinValue; Poll=0; Pairings=''; Clients='' }
    $submit = {
        param($request)
        if ($null -ne $ui.Task) { return }
        $ui.Action=[string]$request.action
        $ui.Task=[ClipRelay.Remote.ControlClient]::RequestAsync(($request | ConvertTo-Json -Compress))
        $ui.Next=[DateTime]::UtcNow.AddSeconds(2)
    }.GetNewClosure()
    $toggle.Add_Click({
        if ($null -ne $ui.Task) { return }
        & $submit @{action=$(if ($ui.Enabled) {'disable'} else {'enable'})}
    }.GetNewClosure())
    $pair.Add_Click({
        if ($null -eq $pending.SelectedItem) {
            $message.Text='请先在手机上点选这台电脑，等待配对请求出现。'; return
        }
        if ($null -ne $ui.Task) { return }
        $selected=$pending.SelectedItem
        if ($selected.automatic) {
            $message.Text='正在允许这台手机…'
            & $submit @{action='lanPairApprove';id=$selected.id}
            return
        }
        if ($pin.Text -notmatch '^\d{4}$') { $message.Text='旧版手机需要输入手机显示的四位 PIN。'; return }
        $message.Text='正在确认配对…'
        & $submit @{action='pair';id=$selected.id;pin=$pin.Text;name=$selected.name}
    }.GetNewClosure())
    $revoke.Add_Click({
        if ($null -eq $clients.SelectedItem -or $null -ne $ui.Task) { return }
        & $submit @{action='unpair';uuid=$clients.SelectedItem.uuid}
    }.GetNewClosure())
    $disconnect.Add_Click({ & $submit @{action='disconnect'} }.GetNewClosure())
    $timer = New-Object Windows.Forms.Timer
    $timer.Interval=150
    $timer.Add_Tick({
        if ($form.IsDisposed) { return }
        if ($null -ne $ui.Task -and $ui.Task.IsCompleted) {
            $action=$ui.Action
            try {
                $reply=$ui.Task.GetAwaiter().GetResult() | ConvertFrom-Json
                if (!$reply.ok) { throw $reply.error }
                $data=$reply.data
                switch ($action) {
                    'status' {
                        $ui.Enabled=$data.enabled; $ui.Running=$data.ready
                        $toggle.Text=if ($ui.Enabled) {'关闭远控'} else {'开启远控'}
                        $status.Text=if ($ui.Running) {'远控已开启 · 等待手机连接或正在串流'} elseif ($ui.Enabled) {'引擎正在启动…'} else {'远控已关闭'}
                    }
                    'pairings' {
                        $signature=$data.pairings | ConvertTo-Json -Compress
                        if ($signature -ne $ui.Pairings) {
                            $ui.Pairings=$signature; $pending.Items.Clear()
                            foreach ($entry in $data.pairings) {
                                $name=if ([string]::IsNullOrWhiteSpace($entry.name)) {'ClipRelay 手机'} else {$entry.name}
                                $automatic=$null -ne $entry.PSObject.Properties['automatic'] -and [bool]$entry.automatic
                                $code=if ($automatic) {[string]$entry.verification} else {''}
                                [void]$pending.Items.Add([PSCustomObject]@{id=$entry.id;name=$name;automatic=$automatic;verification=$code;label=($name+' · '+$entry.address)})
                            }
                            if ($pending.Items.Count -gt 0) {$pending.SelectedIndex=0}
                        }
                    }
                    'clients' {
                        $signature=$data.named_certs | ConvertTo-Json -Compress
                        if ($signature -ne $ui.Clients) {
                            $ui.Clients=$signature; $clients.Items.Clear()
                            foreach ($entry in $data.named_certs) {
                                [void]$clients.Items.Add([PSCustomObject]@{uuid=$entry.uuid;label=$entry.name})
                            }
                            if ($clients.Items.Count -gt 0) {$clients.SelectedIndex=0}
                        }
                    }
                    'pair' {
                        if (!$data.status) { throw '配对未完成，请确认 PIN 后重新发起。' }
                        $pin.Clear(); $message.Text='配对成功。现在可以在手机上打开电脑桌面。'
                    }
                    'lanPairApprove' { $message.Text='已允许这台手机，正在自动完成配对；以后无需输入地址或 PIN。' }
                    'unpair' { $message.Text='已撤销选中的手机授权。' }
                    'disconnect' { $message.Text='已请求断开当前远控。' }
                    'enable' { $message.Text='正在准备远控。就绪后，在手机“连接电脑”列表中点选本机即可。' }
                    'disable' { $message.Text='远控已关闭。' }
                }
            } catch {
                $message.Text='操作未完成：'+$_.Exception.Message
                if ($action -eq 'status') { $status.Text='后台服务未就绪，请重新运行 ClipRelay 安装程序。' }
            } finally { $ui.Task=$null; $ui.Action='' }
        }
        $busy=$null -ne $ui.Task
        $toggle.Enabled=!$busy; $pair.Enabled=!$busy -and $ui.Running; $revoke.Enabled=!$busy -and $ui.Running; $disconnect.Enabled=!$busy -and $ui.Running
        if (!$busy -and [DateTime]::UtcNow -ge $ui.Next) {
            $ui.Poll=($ui.Poll+1)%3
            $action=if (!$ui.Running -or $ui.Poll -eq 0) {'status'} elseif ($ui.Poll -eq 1) {'pairings'} else {'clients'}
            & $submit @{action=$action}
        }
    }.GetNewClosure())
    $form.Add_Shown({ $timer.Start() }.GetNewClosure())
    try {
        if ($null -ne $Owner) { [void]$form.ShowDialog($Owner) } else { [void]$form.ShowDialog() }
    } finally { $timer.Stop(); $timer.Dispose(); $form.Dispose() }
}

function Show-RemoteNetworkSettings {
    param([Windows.Forms.IWin32Window]$Owner = $null)
    $form=New-Object Windows.Forms.Form
    $form.Text='ClipRelay · 外网连接'; $form.Name='RemoteNetworkSettings'
    $form.Size=New-Object Drawing.Size(620,620); $form.StartPosition='CenterParent'
    $form.FormBorderStyle='FixedDialog'; $form.MaximizeBox=$false
    $form.Font=New-Object Drawing.Font('Microsoft YaHei UI',10)
    $form.BackColor=[Drawing.Color]::FromArgb(245,247,250)
    $label={param($text,$x,$y,$w,$h)
        $c=New-Object Windows.Forms.Label; $c.Text=$text; $c.Location=New-Object Drawing.Point($x,$y); $c.Size=New-Object Drawing.Size($w,$h); $form.Controls.Add($c); $c
    }.GetNewClosure()
    $button={param($text,$name,$x,$y,$w)
        $c=New-Object Windows.Forms.Button; $c.Text=$text; $c.Name=$name; $c.AccessibleName=$text; $c.Location=New-Object Drawing.Point($x,$y); $c.Size=New-Object Drawing.Size($w,34); $form.Controls.Add($c); $c
    }.GetNewClosure()
    $title=& $label '手机在外面，也能连接这台电脑' 24 22 530 32
    $title.Font=New-Object Drawing.Font('Microsoft YaHei UI',14,[Drawing.FontStyle]::Bold)
    $hint=& $label '只需在 ClipRelay 内配对，无需注册账号。' 24 64 520 26
    $status=& $label '正在读取连接状态…' 24 105 350 44
    $status.Name='RemoteNetworkStatus'
    $toggle=& $button '开启外网连接' 'RemoteNetworkToggle' 410 101 166
    $codeTitle=& $label '在手机“连接电脑 → 外网配对”中输入配对码' 24 156 540 26
    $code=New-Object Windows.Forms.TextBox; $code.ReadOnly=$true; $code.Name='RemoteNetworkCode'
    $code.Location=New-Object Drawing.Point(24,190); $code.Size=New-Object Drawing.Size(330,48)
    $code.Font=New-Object Drawing.Font('Consolas',22,[Drawing.FontStyle]::Bold); $code.TextAlign='Center'
    $form.Controls.Add($code)
    $makeCode=& $button '生成配对码' 'RemoteNetworkNewCode' 376 192 200
    $expiry=& $label '配对码五分钟内有效，只能使用一次。' 24 244 540 24
    $pendingTitle=& $label '等待确认的手机' 24 281 350 24
    $pending=New-Object Windows.Forms.ListBox; $pending.Name='RemoteNetworkPending'; $pending.DisplayMember='label'
    $pending.Location=New-Object Drawing.Point(24,311); $pending.Size=New-Object Drawing.Size(330,65); $form.Controls.Add($pending)
    $approve=& $button '允许这台手机' 'RemoteNetworkApprove' 376 311 200
    $peerTitle=& $label '已允许的外网设备' 24 390 350 24
    $peers=New-Object Windows.Forms.ListBox; $peers.Name='RemoteNetworkPeers'; $peers.DisplayMember='label'
    $peers.Location=New-Object Drawing.Point(24,421); $peers.Size=New-Object Drawing.Size(330,65); $form.Controls.Add($peers)
    $revoke=& $button '撤销外网连接' 'RemoteNetworkRevoke' 376 421 200
    $message=& $label '开启后随 ClipRelay 后台运行。首次连接仍需确认手机上的远控 PIN。' 24 506 552 54
    $message.Name='RemoteNetworkMessage'
    $ui=@{Task=$null; Action=''; Enabled=$false; Ready=$false; Next=[DateTime]::MinValue; Pending=''; Peers=''}
    $submit={param($request)
        if ($null -ne $ui.Task) {return}
        $ui.Action=[string]$request.action
        $ui.Task=[ClipRelay.Remote.ControlClient]::RequestAsync(($request|ConvertTo-Json -Compress))
        $ui.Next=[DateTime]::UtcNow.AddSeconds(2)
    }.GetNewClosure()
    $toggle.Add_Click({& $submit @{action=$(if($ui.Enabled){'networkDisable'}else{'networkEnable'})}}.GetNewClosure())
    $makeCode.Add_Click({& $submit @{action='networkCode'}}.GetNewClosure())
    $approve.Add_Click({if($null -ne $pending.SelectedItem){& $submit @{action='networkApprove';id=$pending.SelectedItem.id}}}.GetNewClosure())
    $revoke.Add_Click({if($null -ne $peers.SelectedItem){& $submit @{action='networkRevoke';id=$peers.SelectedItem.id}}}.GetNewClosure())
    $timer=New-Object Windows.Forms.Timer; $timer.Interval=200
    $timer.Add_Tick({
        if($form.IsDisposed){return}
        if($null -ne $ui.Task -and $ui.Task.IsCompleted){
            try{
                $reply=$ui.Task.GetAwaiter().GetResult()|ConvertFrom-Json
                if(!$reply.ok){throw $reply.error}
                $data=$reply.data
                switch($ui.Action){
                    'networkStatus'{
                        $ui.Enabled=$data.state -ne 'disabled'; $ui.Ready=[bool]$data.ready
                        $toggle.Text=if($ui.Enabled){'关闭外网连接'}else{'开启外网连接'}
                        $status.Text=if($ui.Ready){'外网连接已就绪'}elseif(!$ui.Enabled){'外网连接已关闭'}elseif($data.error){'正在恢复外网连接…'}else{'正在连接服务…'}
                        foreach($entry in @(@{Items=@($data.pending);List=$pending;Key='Pending'},@{Items=@($data.peers);List=$peers;Key='Peers'})){
                            $signature=$entry.Items|ConvertTo-Json -Compress
                            if($signature -ne $ui[$entry.Key]){
                                $ui[$entry.Key]=$signature; $entry.List.Items.Clear()
                                foreach($device in $entry.Items){
                                    if($null -eq $device){continue}
                                    $labelText=[string]$device.name
                                    if($entry.Key -eq 'Pending'){$labelText+=' · '+([string]$device.id).Substring(0,6).ToUpperInvariant()}
                                    [void]$entry.List.Items.Add([PSCustomObject]@{id=$device.id;label=$labelText})
                                }
                                if($entry.List.Items.Count -gt 0){$entry.List.SelectedIndex=0}
                            }
                        }
                    }
                    'networkCode'{$code.Text=$data.value; $expiry.Text='有效至 '+([DateTime]$data.expires).ToLocalTime().ToString('HH:mm:ss');$message.Text='输入配对码后，请核对手机和电脑显示的六位标识，再允许连接。'}
                    'networkApprove'{$code.Clear();$message.Text='已允许这台手机。请回到手机完成远控 PIN 配对。'}
                    'networkRevoke'{$message.Text='已撤销该手机的外网连接。局域网远控授权可在上一页管理。'}
                    'networkEnable'{$message.Text='正在准备外网连接，就绪后可以生成配对码。'}
                    'networkDisable'{$code.Clear();$message.Text='外网连接已关闭。'}
                }
            }catch{$message.Text='操作未完成：'+$_.Exception.Message}finally{$ui.Task=$null;$ui.Action=''}
        }
        $busy=$null -ne $ui.Task
        $toggle.Enabled=!$busy;$makeCode.Enabled=!$busy -and $ui.Ready;$approve.Enabled=!$busy -and $ui.Ready;$revoke.Enabled=!$busy -and $ui.Ready
        if(!$busy -and [DateTime]::UtcNow -ge $ui.Next){& $submit @{action='networkStatus'}}
    }.GetNewClosure())
    $form.Add_Shown({$timer.Start()}.GetNewClosure())
    try{if($null -ne $Owner){[void]$form.ShowDialog($Owner)}else{[void]$form.ShowDialog()}}finally{$timer.Stop();$timer.Dispose();$form.Dispose()}
}

function Start-RemotePairingNotifier {
    param($NotifyIcon)
    $moduleRoot=Join-Path $PSScriptRoot 'remote-desktop'
    if (!(Test-Path -LiteralPath $moduleRoot)) { $moduleRoot=$PSScriptRoot }
    try { if (!('ClipRelay.Remote.ControlClient' -as [type])) { Add-Type -Path (Join-Path $moduleRoot 'bin\ClipRelay.Remote.Client.dll') } }
    catch { return $null }
    $state=@{Task=$null;Seen='';Next=[DateTime]::MinValue}
    $showSettings=Get-Command Show-RemoteDesktopSettings
    $NotifyIcon.Add_BalloonTipClicked({
        if ($NotifyIcon.BalloonTipTitle -eq 'ClipRelay · 配对请求') {
            $NotifyIcon.BalloonTipTitle=''
            if ($null -eq [Windows.Forms.Application]::OpenForms['RemoteDesktopSettings']) { & $showSettings }
        }
    }.GetNewClosure())
    $timer=New-Object Windows.Forms.Timer
    $timer.Interval=500
    $timer.Add_Tick({
        if ($null -ne $state.Task -and $state.Task.IsCompleted) {
            try {
                $reply=$state.Task.GetAwaiter().GetResult() | ConvertFrom-Json
                if ($reply.ok) {
                    $pending=@($reply.data.pairings)
                    $signature=($pending | ForEach-Object { $_.id }) -join ','
                    if ($signature -ne $state.Seen -and $pending.Count -gt 0 -and $null -eq [Windows.Forms.Application]::OpenForms['RemoteDesktopSettings']) {
                        $script:relayUpdateBalloon=$false
                        $NotifyIcon.BalloonTipTitle='ClipRelay · 配对请求'
                        $NotifyIcon.BalloonTipText=$pending[0].name+' 请求连接电脑。确认标识：'+$pending[0].verification+'。点击核对并允许。'
                        $NotifyIcon.ShowBalloonTip(10000)
                    }
                    $state.Seen=$signature
                }
            } catch {} finally { $state.Task=$null; $state.Next=[DateTime]::UtcNow.AddSeconds(3) }
        }
        if ($null -eq $state.Task -and [DateTime]::UtcNow -ge $state.Next) {
            $state.Task=[ClipRelay.Remote.ControlClient]::RequestAsync('{"action":"lanPairings"}')
        }
    }.GetNewClosure())
    $timer.Start()
    return $timer
}
