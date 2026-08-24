<p align="center">
  <img src="assets/logo.png" alt="ClipRelay Logo" width="128" height="128" />
</p>

# ClipRelay

Mac、Windows 与 Android 手机在同一局域网内互传文本的小工具。选中即发，对方直接粘贴。

- Mac 端基于 [Hammerspoon](https://www.hammerspoon.org/)，每台 Mac 一个 `init.lua`，无需构建。
- Windows 端基于系统自带的 PowerShell 5.1 和 .NET，无需安装第三方运行时。
- Android 端基于 [Termux](https://termux.dev/)，脚本在 `android/` 目录，双向实时互传。

## 工作原理

- 每台设备运行一个 HTTP 服务（默认端口 `47632`），统一接收 `POST /push`。
- Mac 按下 `Ctrl+Alt+G` 后，脚本模拟 `Cmd+C` 获取选中文本、恢复原剪贴板，再发送给对端。
- Windows 直接监听普通的 `Ctrl+C`：当前应用照常完成复制，剪贴板更新后 ClipRelay 同时把新文本发送给对端。
- 对端收到后写入系统剪贴板并弹出通知，直接按 `Cmd+V` 或 `Ctrl+V` 即可粘贴。
- 各平台使用相同协议，可以任意互传；每台设备只需把 `PEER` 配成接收方的局域网 IP 或主机名。

## Mac 端

```bash
brew install --cask hammerspoon
mkdir -p ~/.hammerspoon
cp init.lua ~/.hammerspoon/init.lua
```

1. 打开 Hammerspoon，按提示授予「辅助功能」权限
   （系统设置 → 隐私与安全性 → 辅助功能）。
2. 编辑 `~/.hammerspoon/init.lua`，把顶部的 `PEER` 改成对端设备的局域网 IP 或 `.local`
   主机名。Mac 上可运行 `scutil --get LocalHostName`，假设输出
   `Alice-Mac`，则填写 `Alice-Mac.local`。也可以直接填写局域网 IP。
3. 点 Hammerspoon 菜单栏图标 → Reload Config，看到「ClipRelay 已启动」即就绪。

也可以使用一键安装脚本：

```bash
curl -fsSL https://raw.githubusercontent.com/ffffhx/cliprelay/main/mac-bootstrap.sh \
  | bash -s -- Alice-Mac.local
```

## Windows 端

支持 Windows 10/11，使用系统自带的 Windows PowerShell 5.1。安装脚本会：

- 把客户端和配置写入 `%LOCALAPPDATA%\ClipRelay`；
- 注册当前用户登录自启；
- 为监听端口添加仅限“专用网络”的入站防火墙规则；
- 安装后立即启动，系统托盘出现 ClipRelay 图标即表示运行中；
- 左键点击托盘图标可打开中文设置面板，查看并一键复制本机主机名（`.local`）或局域网 IP 发给对方；
- 支持随时修改对端设备地址，并可一键检测与对方的实时连通性，保存后立即生效。

在仓库根目录打开 PowerShell，执行（把 IP 换成接收方设备的局域网 IP）：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File .\windows\install.ps1 -Peer 192.168.1.100
```

也可以不克隆仓库，直接安装：

```powershell
$source = (Invoke-WebRequest -UseBasicParsing `
  "https://raw.githubusercontent.com/ffffhx/cliprelay/main/windows/install.ps1").Content
& ([scriptblock]::Create($source)) -Peer "192.168.1.100"
```

添加防火墙规则时会出现一次 UAC 确认。安装完成后，正常按 `Ctrl+C` 即会同时复制
到本机并发送；接收的文本会进入剪贴板并弹出通知。局域网内建议优先使用 IP，避免
Windows 或 Android 环境无法解析 `.local`。

配置保存在 `%LOCALAPPDATA%\ClipRelay\config.json`。左键点击托盘图标，或右键选择
`设置 / 配置对方设备...`：窗口顶部显示本机主机名 (`.local`) 与局域网 IPv4，点击 `复制` 后发给对方；
在对方设备地址输入框填写对方的局域网 IP 或主机名（如 `Alice-Mac.local`），点击 `检测连接` 确认通畅后保存即可，无需重新安装或重启。
卸载命令：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File "$env:LOCALAPPDATA\ClipRelay\uninstall.ps1"
```

如只想临时运行、不安装自启或防火墙规则：

```powershell
powershell.exe -NoProfile -STA -ExecutionPolicy Bypass `
  -File .\windows\cliprelay.ps1 -Peer 192.168.1.100
```

## Android 端（Termux）

需要三个 App（建议从 F-Droid 安装，Play 商店版本已停更）：

- **Termux**：跑脚本本体
- **Termux:API**：读写剪贴板、弹通知
- **Termux:Widget**（可选）：把"发送"做成桌面一键小部件
- **Termux:Boot**（可选）：开机自动启动接收端

在 Termux 里执行：

```bash
pkg install python curl jq termux-api
mkdir -p ~/cliprelay
# 把本仓库 android/receiver.py 和 android/send.sh 拷到 ~/cliprelay/
chmod +x ~/cliprelay/send.sh
# 编辑 send.sh 顶部的 PEER 为接收方设备的局域网 IP 或 .local 主机名
```

- **启动接收端**（收对端设备发来的文本，写剪贴板 + 通知）：

  ```bash
  termux-wake-lock
  python ~/cliprelay/receiver.py
  ```

- **发送**（把手机剪贴板推到 Mac）：

  ```bash
  ~/cliprelay/send.sh
  ```

  一键化：`mkdir -p ~/.shortcuts && cp ~/cliprelay/send.sh ~/.shortcuts/`，
  然后在桌面添加 Termux:Widget 小部件，点一下即发。

- **开机自启**（可选）：`mkdir -p ~/.termux/boot && cp android/boot-cliprelay.sh ~/.termux/boot/`

另：在系统设置里把 Termux 的电池优化关掉，否则后台会被杀。

## 配置项

Mac 配置位于 `init.lua` 顶部：

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| `PEER` | `peer-mac.local` | 对方设备的局域网 IP 或 `.local` 主机名 |
| `PORT` | `47632` | HTTP 服务端口，两边需一致 |
| `HOTKEY_MODS` / `HOTKEY_KEY` | `ctrl` `alt` + `g` | 全局热键，冲突可改 |

Windows 配置位于 `%LOCALAPPDATA%\ClipRelay\config.json`：

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| `peer` | 安装时的 `-Peer` | 接收方设备的局域网 IP 或主机名 |
| `port` | `47632` | HTTP 服务端口，两边需一致 |

Windows 当前监听不带其他修饰键的 `Ctrl+C`。按键不会被 ClipRelay 拦截，前台应用
仍按原方式完成复制；只有检测到剪贴板确实更新且内容为文本时才会发送。左键点击
托盘图标可配置对端并检测连通性；如需临时退出，可右键单击图标并选择 `退出 ClipRelay`。

## 注意

- 仅适用于可信内网：HTTP 明文、无鉴权，同网段任何人都能往你的剪贴板推内容。
- Windows 端每次用 `Ctrl+C` 复制的文本都会自动发给配置的对端。复制密码、令牌等敏感
  内容前，请先从系统托盘退出 ClipRelay；鼠标右键菜单复制和 `Ctrl+Shift+C` 不会触发发送。
- Mac 之间可以使用 `.local` 主机名，避免 DHCP 导致 IP 变化。
- 部分 Windows/Android 环境无法稳定解析 `.local`，此时请使用局域网 IP，并在路由器中配置 DHCP 静态租约。
- 首次使用如 macOS 防火墙弹窗询问 Hammerspoon 是否接受传入连接，选择允许。
- Windows 安装器创建的防火墙规则只允许“专用网络”；请勿为了使用本工具把公共网络改成专用网络。

## License

[MIT](LICENSE)
