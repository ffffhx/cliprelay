<p align="center">
  <img src="assets/logo.png" alt="ClipRelay Logo" width="128" height="128" />
</p>

# ClipRelay

Mac、Windows 与 Android 手机在同一局域网内互传文本和截图的小工具。选中或截图即发，对方直接粘贴。

- Mac 端基于 [Hammerspoon](https://www.hammerspoon.org/)，每台 Mac 一个 `init.lua`，无需构建。
- Windows 端基于系统自带的 PowerShell 5.1 和 .NET，无需安装第三方运行时。
- Android 端使用仓库维护的原生 APK，工程位于 `android-app/`，接收电脑发送的文本和截图。

## 工作原理

- 每台设备运行一个 HTTP 服务（默认端口 `47632`）；文本使用 `POST /push`，JPEG 截图使用 `POST /push-image`。
- Windows、Mac 和原生 Android 的接收服务启动后会通过 mDNS/DNS-SD 发布 `_cliprelay._tcp.local`；扫描端向局域网查询该服务，并从结果中取得设备名、地址、端口和是否需要访问密钥。
- Mac 按下 `Ctrl+Alt+G` 后，脚本模拟 `Cmd+C` 获取选中文本、恢复原剪贴板，再发送给对端。
- Windows 直接监听普通的 `Ctrl+C`：当前应用照常完成复制，ClipRelay 把新文本并行发送给所有启用的接收设备；若没有发生新复制，则发送剪贴板当前文本。
- Windows 按 `Ctrl+Alt+F12` 时，在内存中截取并编码所有显示器一次，再把同一份 JPEG 并行发送给所有启用设备；不打开截图界面、不写文件，也不改本机剪贴板。
- 对端收到后写入系统剪贴板并弹出通知，直接按 `Cmd+V` 或 `Ctrl+V` 即可粘贴。
- 各平台使用相同协议；Windows 和 Mac 支持发送与接收，Android 当前支持接收；Windows 可维护最多 16 个广播目标，Mac 可从菜单栏扫描并选择单个接收方，手动地址始终保留为回退方案。
- mDNS 声明包含随机设备 ID、显示名称、协议版本、平台、端口和认证状态，不包含访问密钥、剪贴板内容或历史记录。
- 原生 Android 默认使用“品牌 + 型号”作为发现名称（例如 `realme RMX5002` 或 `OnePlus PHK110`），并在 TXT 记录中分别声明 `brand` 和 `model`；设置页仍可覆盖成自定义名称。

## Mac 端

```bash
brew install --cask hammerspoon
mkdir -p ~/.hammerspoon
cp init.lua ~/.hammerspoon/init.lua
```

1. 打开 Hammerspoon，按提示授予「辅助功能」权限
   （系统设置 → 隐私与安全性 → 辅助功能）。
2. 默认可先保留顶部的 `DEFAULT_PEER`；启动后点击菜单栏的 `ClipRelay` → `扫描局域网设备…`
   选择对端。所选地址、端口和访问密钥会持久保存。mDNS 不可用时，再把 `DEFAULT_PEER`
   改为对端的局域网 IP 或 `.local` 主机名。
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
- 左键点击托盘图标可打开深色“设备链路”控制台，查看并一键复制本机主机名（`.local`）或局域网 IP；
- 控制台集中显示本机监听状态、文本/截图快捷键及冲突状态、广播链路和最近一次传输结果；
- 左侧设备列表可直接开关每台目标，通过 `···` 编辑或移除设备；支持添加和扫描最多 16 个目标，名称、地址、端口和访问密钥独立配置；全部关闭时暂停发送，本机仍可接收；
- 支持修改本机监听端口、接收密钥、通知和开机自启，并可并行检测所有广播设备。

在仓库根目录打开 PowerShell，执行（初始地址之后可由扫描结果替换）：

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
到本机并广播；按 `Ctrl+Alt+F12` 会静默广播整个虚拟桌面的 JPEG 截图。接收的文本或
截图会进入剪贴板。

配置保存在 `%LOCALAPPDATA%\ClipRelay\config.json`。左键点击托盘图标，或右键选择
`设置 / 配置对方设备...`：在“这台电脑”中切换本机主机名 (`.local`) 与局域网 IPv4，点击 `复制` 后发给对方；
左侧列表始终显示所有已保存设备，开关决定该设备是否接收广播，停用后仍留在列表中。点击 `+ 添加` 可手动添加，点击 `扫描添加设备` 可发现局域网目标并合并到列表；通过每行的 `··· → 编辑设备 / 移除设备` 管理名称、地址、端口和密钥，修改立即保存。检测连接只探测已启用设备，不会修改任何剪贴板。
“检测全链路连接”会先在后台扫描局域网，按设备 ID 更新已有目标的 IP 和端口并自动保存，再检测连接；不会自动新增目标，也不会改动名称、密钥或启用状态。未发现的设备仍按已保存地址检测，扫描失败时也会回退到已保存地址。
在设置中可修改“局域网发现名称”或关闭“允许局域网发现”；这两项变化会在保存后重启后台服务。
广播时单台设备离线不会阻止其他设备接收；界面会显示“全部送达”“部分送达”或“全部失败”，并保留逐设备结果。
如果修改监听端口，ClipRelay 会申请更新专用网络防火墙规则并自动重启；这一步可能出现 UAC 确认。
设备列表中某个目标的访问密钥，需要与该目标自己的“接收密钥”一致；主窗口的“本机接收密钥”只保护发往这台 Windows 电脑的请求。留空则兼容未启用认证的旧客户端。
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

## Android 端（原生 APK）

原生工程位于 [`android-app/`](android-app/)，支持 Android 8.0 及以上版本。App 会运行一个
带常驻通知的前台接收服务，支持文本 `/push` 和截图 `/push-image`。收到内容后会：

- 将文本或截图写入手机系统剪贴板；
- 弹出可关闭内容预览的通知；
- 在 App 内保留最近 30 条文本与截图，点击进入无系统栏的沉浸式全屏，左右滑动切换；全屏图片支持 1×–5× 双指缩放与放大后拖动，拖到左右边缘后松手，再向外滑动可切换相邻的图片或文字；轻点内容可显示复制、关闭及横竖屏控制；
- 根据设置在手机重启或 App 更新后恢复接收。

文本全屏阅读默认渲染 Markdown，支持标题、列表、引用、表格、链接及带语法高亮的代码块。
顶部可切换“查看原文 / Markdown 预览”，全文复制始终保留原始 Markdown；代码块支持横向滚动和“复制代码”。
轻点正文可显示或隐藏控制栏，字号调整、横竖屏和左右切换历史仍可使用。此功能渲染收到的文本，不涉及 `.md` 文件传输。
全屏控制栏直接覆盖正文，显示或隐藏时不改变正文位置。阅读期间收到新文本或图片时，会显示
“收到 N 条新内容 · 点击查看”，约 4.5 秒后收为“新内容 N”提示，直到点击查看或忽略；手动滑到新内容并停下时也会扣除对应提醒，全部看过后自动消失。不自动跳走当前阅读记录。

收到的图片可在历史卡片或全屏预览的控制栏点击“保存到相册”，原图会复制到 `Pictures/ClipRelay`，清空接收历史不会删除已保存的相册图片。Android 8–9 首次保存时需允许存储权限。
本次打开 App 期间，操作成功的内容会显示“已保存”或“已复制”，列表与全屏同步；切到后台或旋转屏幕保留状态，关闭 App 页面或结束进程后重新打开恢复默认文案。“已复制”仍可再次复制，“已保存”不重复写入相册。

### 使用 APK

1. 安装由 GitHub Actions 产出的 `ClipRelay-android-debug` APK，或按下节自行构建。
2. 手机与电脑连接同一个可信局域网，打开 App，点击“开始接收”。
3. 按系统提示允许“本地网络”和通知权限。部分厂商还需把 ClipRelay 的电池策略改为“不受限制”。
4. App 会显示 `192.168.x.x:47632` 一类地址，并在“允许局域网发现”开启时自动声明自己。在 Windows 托盘面板左侧点击“扫描添加设备”即可添加手机；扫描不到时仍可点击“+ 添加”手动填写 IP。
5. 在电脑正常按 `Ctrl+C` 可发送文本；按 `Ctrl+Alt+F12` 可发送所有显示器的截图。收到的内容会直接进入手机剪贴板。

访问密钥默认为空。若在 Android 启用，Windows 的对应广播设备也要填写相同密钥，发送请求会携带
`X-ClipRelay-Token: <密钥>`；缺失或错误的密钥会收到 `401`。

### 本地构建

需要 JDK 17 和 Android SDK Platform 37。在 Windows PowerShell 中：

```powershell
cd android-app
.\gradlew.bat lintDebug testDebugUnitTest assembleDebug
adb install -r .\app\build\outputs\apk\debug\app-debug.apk
```

可安装的 Debug APK 位于 `android-app/app/build/outputs/apk/debug/app-debug.apk`。正式分发时
请使用自己的 Android 签名密钥构建并签名 Release APK；不要把签名文件提交到仓库。

已有正式版的真机可使用相同签名的 QA 构建运行 Markdown 界面测试：配置本地签名后，执行
`./gradlew connectedQaAndroidTest -PcliprelayTestBuildType=qa`。测试覆盖预览/原文切换、字号、代码复制、
横向滚动与横屏，并在 App 的外部文件目录保存 `markdown-*-qa.png` 截图；测试结束后安装正式 Release 包。
手动验收文本见 [`android-app/markdown-preview-demo.md`](android-app/markdown-preview-demo.md)。

### App 自动更新

正式版会在启动时检查更新，接收服务运行期间每 24 小时再检查一次。发现新版后，App 会显示
更新说明并下载 APK；下载完成后需要按 Android 系统提示确认安装。安装包必须满足以下条件才会
交给系统安装器：

- `versionCode` 高于当前版本；
- 包名仍为 `com.cliprelay.app`；
- APK 签名与已安装版本一致；
- 文件 SHA-256 与发布清单一致。

更新源默认是腾讯云 HTTPS 服务，版本清单和 APK 都从腾讯云下载，手机无需连接 GitHub。部署说明见
[`deploy/README.md`](deploy/README.md)。推送 `android-app/`、正式发布工作流或版本脚本的改动到 `main`
后，`.github/workflows/android-release.yml` 会自动运行测试、构建签名 APK、创建
`android-v<versionName>` 标签，并发布 APK 与更新清单。无需手动修改版本号：如果当前版本不高于
已发布版本，工作流会递增补丁号和 `versionCode`，验证构建成功后将版本修改提交回 `main`；
手动指定的更高版本号会保留。没有未发布的 Android 改动时，重复运行不会产生新版本。
发布任务串行执行，并取最新 `main`；构建期间分支有新提交时不会强推覆盖，后续任务会处理最新代码。
随后 Android Cloud Sync 会同步文件到腾讯云，并校验线上版本和 APK 哈希；失败时可单独重跑同步工作流。
手工推送形如 `android-v0.6.0` 的标签或从 Actions 手动运行工作流仍可作为发布兜底。
仓库需要预先配置
`CLIPRELAY_KEYSTORE_BASE64`、`CLIPRELAY_STORE_PASSWORD`、`CLIPRELAY_KEY_ALIAS`、
`CLIPRELAY_KEY_PASSWORD` 四个 Actions Secrets；这些值必须始终对应首次正式安装使用的签名密钥。
手工标签必须等于 `android-v<versionName>`，且指向本次构建的提交，否则发布工作流会直接失败。

OPPO、realme 等带厂商后台管理的手机，还需要在 ClipRelay 的“耗电管理”中开启“允许应用自启动”
和“允许完全后台行为”。否则厂商系统可能拦截 `MY_PACKAGE_REPLACED`，导致 App 更新后要手动打开一次
才能恢复接收。标准 Android 设备不需要额外设置。

Android APK 当前支持接收电脑发送的文本和截图，尚未提供“手机 → 电脑”的发送功能。

## 配置项

Mac 配置位于 `init.lua` 顶部：

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| `DEFAULT_PEER` | `peer-mac.local` | 尚未扫描选择设备时使用的手动回退地址 |
| `LOCAL_PORT` | `47632` | 本机 HTTP 接收服务和 mDNS 声明端口 |
| `HOTKEY_MODS` / `HOTKEY_KEY` | `ctrl` `alt` + `g` | 全局热键，冲突可改 |

Mac 扫描选择的 `peer`、`peerPort`、`peerToken`，以及稳定的 `deviceId` 和发现开关保存在 Hammerspoon 的 `hs.settings` 中。

Windows 配置位于 `%LOCALAPPDATA%\ClipRelay\config.json`：

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| `peer` | 安装时的 `-Peer` | 兼容旧版本的首个启用目标地址；实际广播以 `peers` 为准 |
| `peers` | 从 `peer` 自动迁移 | 广播目标数组；手动项包含名称、地址、端口、访问密钥和启用状态，扫描项还会保存设备 ID、平台和认证状态 |
| `port` | `47632` | 本机接收服务端口 |
| `notifications` | `true` | 是否在收到文本时弹出系统气泡通知（设为 `false` 进入静默同步模式） |
| `accessToken` | 空 | 本机接收密钥；本机在非空时拒绝缺失或错误的 `X-ClipRelay-Token` |
| `deviceId` | 首次安装生成的 UUID | 用于扫描去重和排除本机，不随设备名称或 IP 改变 |
| `deviceName` | Windows 计算机名 | mDNS 中显示的发现名称 |
| `discoveryEnabled` | `true` | 是否通过 mDNS 向当前局域网声明本机 ClipRelay 服务 |

Windows 当前监听不带其他修饰键的 `Ctrl+C`。按键不会被 ClipRelay 拦截，前台应用
仍按原方式完成复制；剪贴板更新后发送新文本，等待约 300 毫秒仍未更新时发送剪贴板当前文本。
剪贴板为空或只有图片、文件等非文本内容时不发送。可以先点击网页的“复制”按钮，再在没有选中文本的位置按 `Ctrl+C` 发送；
若当前应用把 `Ctrl+C` 解释为复制整行等操作，则发送该操作产生的新文本。左键点击
托盘图标可打开设备链路控制台，配置广播设备、本机端口、本机接收密钥、开机自启和接收气泡通知（静默模式）；也可右键托盘图标快速切换通知状态或选择 `退出 ClipRelay`。
同一段文本在 1 秒内连续按普通 `Ctrl+C` 只发送一次；不同文本仍会立即逐条发送，发送失败也不会阻止下一次重试。
广播设备列表变化后，防抖签名也会随之变化；新增目标不会被上一条单设备发送记录误抑制。

截图快捷键固定为 `Ctrl+Alt+F12`。它会被注册为全局热键，不再传给前台应用。
ClipRelay 启动时会检测系统级热键冲突：
注册成功时托盘菜单显示“可用”；如果已被其他程序占用，托盘菜单显示冲突并弹出一次警告，
截图功能保持停用，但 `Ctrl+C` 文本同步和接收服务会继续运行。截图覆盖
整个 Windows 虚拟桌面（所有显示器），以质量 88 的 JPEG 在内存中只编码一次，再通过并行的 `/push-image`
请求广播；发送端不调用系统截图 UI、不写临时文件、不修改本机剪贴板，成功或失败也不会弹通知。
接收端会拒绝超过 25 MiB、格式错误或像素尺寸异常的图片。

## 注意

- 仅适用于可信内网：HTTP 为明文。访问密钥可以阻止未授权的 ClipRelay 请求，但不能加密文本或截图；密钥留空时，同网段其他设备可以往你的剪贴板推入文本或图片，也可能看到传输中的截图。
- Windows 端每次用 `Ctrl+C` 复制的文本都会自动发给配置的对端。复制密码、令牌等敏感
  内容前，请先从系统托盘退出 ClipRelay；鼠标右键菜单复制和 `Ctrl+Shift+C` 不会触发发送。
- Mac 之间可以使用 `.local` 主机名，避免 DHCP 导致 IP 变化。
- 部分 Windows/Android 环境无法稳定解析 `.local`，此时请使用局域网 IP，并在路由器中配置 DHCP 静态租约。
- mDNS 标准使用 `224.0.0.251:5353`（IPv4）或 `ff02::fb:5353`（IPv6）组播，只在当前链路内工作；ClipRelay 当前从发现结果中选择 IPv4 作为发送地址。访客 Wi-Fi、AP 隔离、部分 VPN、防火墙或路由器的组播过滤会导致扫描不到；这不影响按 IP 手动配置。
- 首次使用如 macOS 防火墙弹窗询问 Hammerspoon 是否接受传入连接，选择允许。
- Android 13 及以上版本可能显示系统自带的剪贴板浮层；应用无法可靠关闭这个系统提示。
- Windows 安装器创建的防火墙规则只允许“专用网络”；请勿为了使用本工具把公共网络改成专用网络。

## License

[MIT](LICENSE)
