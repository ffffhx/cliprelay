# ClipRelay

Mac 与 Android 手机在同一局域网内互传文本的小工具。选中即发，对方直接粘贴。

- Mac 端基于 [Hammerspoon](https://www.hammerspoon.org/)，每台 Mac 一个 `init.lua`，无需构建。
- Android 端基于 [Termux](https://termux.dev/)，脚本在 `android/` 目录，双向实时互传。

## 工作原理

- 每台 Mac 的 Hammerspoon 加载配置后，自带一个 HTTP 服务（默认端口 `47632`）。
- 按下热键（默认 `Ctrl+Alt+G`）：脚本模拟一次 `Cmd+C` 拿到选中文本，恢复本地剪贴板原内容，然后 POST 给对方 Mac。
- 对方收到后写入对方剪贴板并弹系统通知，直接 `Cmd+V` 即可。
- 双向互发，两边配置相同，仅 `PEER` 各填对方的局域网 IP。

## 安装（两台 Mac 各做一次）

```bash
brew install --cask hammerspoon
mkdir -p ~/.hammerspoon
cp init.lua ~/.hammerspoon/init.lua
```

1. 打开 Hammerspoon，按提示授予「辅助功能」权限
   （系统设置 → 隐私与安全性 → 辅助功能）。
2. 编辑 `~/.hammerspoon/init.lua`，把顶部的 `PEER` 改成对方 Mac 的局域网 IP
   （在对方机器上用 `ipconfig getifaddr en0` 查询）。
3. 点 Hammerspoon 菜单栏图标 → Reload Config，看到「ClipRelay 已启动」即就绪。

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
# 编辑 send.sh 顶部的 PEER 为 Mac 的局域网 IP
```

- **启动接收端**（收 Mac 发来的文本，写剪贴板 + 通知）：

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

在 `init.lua` 顶部：

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| `PEER` | `192.168.1.100` | 对方 Mac 的局域网 IP |
| `PORT` | `47632` | HTTP 服务端口，两边需一致 |
| `HOTKEY_MODS` / `HOTKEY_KEY` | `ctrl` `alt` + `g` | 全局热键，冲突可改 |

## 注意

- 仅适用于可信内网：HTTP 明文、无鉴权，同网段任何人都能往你的剪贴板推内容。
- 对方 Mac 的 IP 可能因 DHCP 变化，连不上时先确认 IP 再改配置。
- 首次使用如 macOS 防火墙弹窗询问 Hammerspoon 是否接受传入连接，选择允许。
