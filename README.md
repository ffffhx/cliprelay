# ClipRelay

两台 Mac 在同一局域网内互传选中文本的小工具。选中即发，对方直接 Cmd+V 粘贴。

基于 [Hammerspoon](https://www.hammerspoon.org/)，每台 Mac 一个 `init.lua`，无需构建。

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
