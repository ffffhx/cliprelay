# ClipRelay agent notes

## 后台操作与验收

默认保留用户当前前台窗口和输入焦点。构建、CLI/API 和应用界面验收优先在后台完成；应用启动、重启或热更新使用后台/不激活入口，优先复用已有开发实例，不为验收自动打开控制中心、置前应用窗口或打开 DevTools。独立进程、隐藏终端不等于应用不会抢前台；交付可用实例不等于自动激活窗口。纯文档或 Agent 指引修改不启动界面。

Chrome 浏览器工具的焦点操作已获用户持续授权：在已授权的浏览器任务和已选定的 Profile 内，可直接启动 Chrome、打开或切换 Tab、置前浏览器窗口和取得输入焦点，无需仅因可能抢焦点再次询问。此授权优先于 Skill 的默认后台规则，不允许擅自更换 Profile 或绕过接管、暂停和其他会话占用。

需要通过 desktop 工具（如 ppilot desktop、Computer Use）进行真实前台输入、置前窗口或操作系统弹窗时，先说明具体原因和影响，在已有明确授权下执行；没有授权时等用户同意。此询问要求不适用于上述 Chrome 浏览器工具操作。其他应用意外抢焦点时停止重复触发并修正方式，不能先抢焦点再切回作为后台验收。

## 开发与正式更新

日常使用 `npm run dev` 的本地开发版，其他用户使用正式安装包。开发版界面修改自动刷新，后台修改提示用户结束当前连接后再重启；开发版不安装线上正式更新。Windows/macOS 的 main 提交通过各自完整检查后自动发布 GitHub Releases，此流程已获用户授权。Windows 复用更新服务和保留配置的安装器；macOS 暂时检测、下载并引导安装，待 Apple 签名接入后再支持自动替换。不要为了自动发布而跳过原生组件、包内校验或串流验收。

## 本地构建产物保留规则

应用状态和正常退出/重启优先使用仓库内 `npm run app -- status|quit|restart`；Windows 安装版可用安装目录的 `app.ps1 -Action status|quit|restart`。开发版切换使用 `npm run dev -- --restart`。命令返回 accepted 表示已受理，仍需检查原 PID 退出及重启后的新 PID；旧进程没有接口时需正常退出一次，不能强杀替代。

- 新的验收、解压和临时打包目录统一放在 `.tools/artifacts/acceptance/<任务-时间>/`；任务结束后清理完整安装副本，只保留必要的小型报告。不要再按任务名在 `.tools` 顶层累积完整安装包。
- 要保留的发布包及其校验清单放在 `.tools/artifacts/packages/{windows,android,macos}/<版本-时间>/`，每个平台默认最多保留最近 2 份。Windows/macOS 各 2 GiB、Android 1 GiB；超过预算先清理较旧版本，最新一份保留并报告超限。
- 验收目录最多保留最近 2 次、最长 7 天、合计 2 GiB。最近 24 小时有修改、进程正在引用、带 `.keep` 标记的目录由清理器跳过；任务完成后确认不再使用的临时副本应当场清理，不必等到过期。
- 本地构建/验收前运行 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/clean_artifacts.ps1` 查看占用；任务结束后运行同一命令加 `-Apply` 执行保留规则，并报告清理结果。Windows 默认打包入口成功后也会执行此规则；自定义输出路径需调用方负责收尾。
- 清理器只自动管理上述专用目录。禁止整删 `.tools`、SDK/NDK、源码工作树、当前安装、配置、密钥、备份或测试共用工具；不跟随 junction/symlink。需要暂时保留某个构建时，在该目录写 `.keep` 并注明原因，使用结束后移除。
- 旧布局只能按逐项审查的仓库相对路径 JSON 清单，使用 `-ReviewedPlan <清单>` 先预览、再加 `-Apply`。清理记录保存在 `.tools/cleanup-reports/`，不要把用户配置或密钥写进记录。

启动、重启、安装后拉起，都必须用**独立进程**。ClipRelay 是常驻托盘/后台服务，不能挂在 agent 终端、当前 shell、或这条命令的 Job 上。命令结束、会话结束、终端关掉，App 都要还在跑。

## 禁止

- 不要 `powershell.exe -File .\windows\cliprelay.ps1` 当这条 agent 命令的前台或后台任务来跑（`background: true` 也不行，进程仍属于这次会话）。
- 不要 `Start-Process` 完还在同一个 shell 里等它。Windows 上 agent 终端的 Job Object 会在命令结束时杀掉子孙进程。
- 不要给托盘进程重定向 stdout/stderr、不要 `| Tee-Object`、不要 `Start-Transcript`。重定向会让 STA / NotifyIcon 进程异常退出。
- 不要用 `pwsh`。必须是系统自带的 `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`，并带 `-STA`。

## Windows：正确启动

Electron 版优先使用 `%LOCALAPPDATA%\ClipRelay\start.ps1`（系统 PowerShell 5.1、`-NoProfile -STA -ExecutionPolicy Bypass`）；从仓库运行使用 `windows/start.ps1`，需要打开设置时加 `-OpenSettings`。先运行 `windows/electron/setup.ps1` 准备 runtime。启动脚本内部通过 WMI 启动立即退出的 helper，再用 `CreateNoWindow` 启动 `desktop/ClipRelay.exe`，不要将 EXE 直接挂在 agent Job 上。安装器和登录自启均使用 Electron 入口。

Electron 拥有 HTML/CSS 窗口，原 PowerShell 作为它的后台子进程保留剪贴板和网络行为。不要单独重启这个子进程；通过托盘退出后，再调用 `start.ps1`。验收时额外确认 `desktop/ClipRelay.exe` 主进程存在、命名管道断开后后台会退出。

以下命令仅适用于尚未迁移、没有 `desktop/ClipRelay.exe` 的旧安装：

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

安装用 `windows\install.ps1`；新安装器末尾调用 `start.ps1`。安装命令退出后仍须确认应用和监听独立存活。

## 验收

启动命令**退出之后**再查，两条都要成立：

1. 仍有 `powershell.exe ... -File ...\cliprelay.ps1` 进程
2. `0.0.0.0:47632`（或配置的端口）仍在 LISTENING

命令还没退出就看到监听，不算独立成功。本地可 `POST http://127.0.0.1:47632/push`，body 为 `{"text":"..."}`，应返回 `200 ok`。

配置在 `%LOCALAPPDATA%\ClipRelay\config.json`。改对端请改这个文件或让用户用托盘设置，不要为了启动把 App 绑回终端。

## 其他端

- Mac：Electron 版通过 Finder 或 `open /path/to/ClipRelay.app` 独立启动，不把 `npm start` 挂在 agent 终端。切换前停用 Hammerspoon 中的旧 ClipRelay，保留配置供首次导入。仅维护旧安装时才修改 `~/.hammerspoon/init.lua` 并 Reload；不要在终端挂一个 lua 进程当客户端。用户已明确本次暂不要求 Mac 真机验证。
- Android：使用 `android-app/` 原生 APK，由 App 的前台服务保持接收；不要把接收端塞进 agent 终端前台长驻。
