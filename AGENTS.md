# ClipRelay agent notes

启动、重启、安装后拉起，都必须用**独立进程**。ClipRelay 是常驻托盘/后台服务，不能挂在 agent 终端、当前 shell、或这条命令的 Job 上。命令结束、会话结束、终端关掉，App 都要还在跑。

## 禁止

- 不要 `powershell.exe -File .\windows\cliprelay.ps1` 当这条 agent 命令的前台或后台任务来跑（`background: true` 也不行，进程仍属于这次会话）。
- 不要 `Start-Process` 完还在同一个 shell 里等它。Windows 上 agent 终端的 Job Object 会在命令结束时杀掉子孙进程。
- 不要给托盘进程重定向 stdout/stderr、不要 `| Tee-Object`、不要 `Start-Transcript`。重定向会让 STA / NotifyIcon 进程异常退出。
- 不要用 `pwsh`。必须是系统自带的 `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`，并带 `-STA`。

## Windows：正确启动

已安装时优先走 `%LOCALAPPDATA%\ClipRelay`（配置、图标、开机快捷方式都在这）。启动命令必须和开机项一致：

```
C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe
  -NoProfile -STA -WindowStyle Hidden -ExecutionPolicy Bypass
  -File "%LOCALAPPDATA%\ClipRelay\cliprelay.ps1"
```

独立成功的标志：Grok 这次会话、agent 终端、以及任何弹出的 PowerShell / Windows Terminal 窗口都可以关掉，托盘图标和 `47632` 还在。那种黑窗口就是 ClipRelay 自己的控制台，关掉等于杀进程，不算独立。

从 agent 终端拉起时不要直接 WMI 跑 `cliprelay.ps1`：`-WindowStyle Hidden` 挡不住 Windows 11 把 `powershell.exe` 接到 Windows Terminal；WMI 的 `DETACHED_PROCESS` 会让托盘进程立刻退出。正确做法是 WMI 先拉一个立刻退出的 helper，helper 再用 `CreateNoWindow` 拉客户端：

```powershell
$inner = @'
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"
$psi.Arguments = "-NoProfile -STA -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$env:LOCALAPPDATA\ClipRelay\cliprelay.ps1`""
$psi.WorkingDirectory = "$env:LOCALAPPDATA\ClipRelay"
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
[void][System.Diagnostics.Process]::Start($psi)
'@
$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($inner))
$helperCmd = "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -WindowStyle Hidden -EncodedCommand $encoded"
$startup = ([wmiclass]'Win32_ProcessStartup').CreateInstance()
$startup.ShowWindow = 0
$result = ([wmiclass]'Win32_Process').Create($helperCmd, "$env:LOCALAPPDATA\ClipRelay", $startup)
```

停旧进程时跳过当前 `$PID`，也不要匹配带 `-NonInteractive` 的 agent 命令，否则会把正在执行的这条 shell 杀掉。

备选：用开机快捷方式，由 Explorer 拉起（同样不挂在当前终端上）：

```powershell
$lnk = Join-Path ([Environment]::GetFolderPath('Startup')) 'ClipRelay.lnk'
cmd.exe /c start "" "$lnk"
```

临时从仓库跑、不安装时，同样用 WMI `Win32_Process.Create`，`-File` 指向仓库里的 `windows\cliprelay.ps1`，需要的话加 `-Peer`。不要在 agent 终端里直接 `-File` 常驻。

安装用 `windows\install.ps1`；它内部的 `Start-Process` 只适合用户自己打开的 PowerShell。从 agent 跑安装脚本之后，仍要按上面的 WMI / 快捷方式再确认进程已独立起来。

## 验收

启动命令**退出之后**再查，两条都要成立：

1. 仍有 `powershell.exe ... -File ...\cliprelay.ps1` 进程
2. `0.0.0.0:47632`（或配置的端口）仍在 LISTENING

命令还没退出就看到监听，不算独立成功。本地可 `POST http://127.0.0.1:47632/push`，body 为 `{"text":"..."}`，应返回 `200 ok`。

配置在 `%LOCALAPPDATA%\ClipRelay\config.json`。改对端请改这个文件或让用户用托盘设置，不要为了启动把 App 绑回终端。

## 其他端

- Mac：只操作已安装的 Hammerspoon（拷/改 `~/.hammerspoon/init.lua` 后 Reload）。不要在终端里挂一个 lua 进程当客户端。
- Android：在 Termux 里跑 `receiver.py` / `send.sh`，不要把接收端塞进 agent 终端前台长驻。
