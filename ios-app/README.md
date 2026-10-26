# iPhone / iPad 开发版

此目录接入 ClipRelay 的局域网控制端。原生串流基础固定为 Moonlight iOS
`02dc9780496eeeac6d01c8bbdccb8b6fe71ef28a`；协议核心与桌面端固定在同一提交。
改动由 `upstream.patch`、`common.patch` 和 `native/` 组成，准备脚本会校验上游及子模块版本、应用补丁并登记 Xcode 源文件。

## 已实现的入口

- 手动添加电脑（IP / 主机名，默认端口 **48789**），并保留局域网 Bonjour 发现。
- 在 App 中显示两端核对标识，由电脑端的连接策略批准请求；原生证书、PIN 和签名交换完成后才保存配对。
- 请求反馈绑定证书及独立回执，能显示拒绝、过期和取消；点取消、切到后台或切换电脑会中止请求，迟到结果不再修改界面或保存配对。
- 客户端身份保存在本机钥匙串，私钥不写入 Documents 或偏好设置。已配对连接固定服务器证书，证书变化、撤权或 TLS 失败不会回退到 HTTP。
- 复用原生画面解码、音频播放、触控、鼠标、键盘和手柄入口。串流要求加密 RTSP 以及视频、音频和控制通道加密；退出或失去前台时停止串流，尚未完成的启动会取消。
- 长按已配对且在线的电脑 → **剪贴板收发…**：输入/粘贴文字或 PNG，发送到电脑；也可读取电脑内容，再点“复制到本机”。只响应明确操作，不在后台读取系统剪贴板。

本轮完成范围为局域网首版，不包含内置外网组网、后台自动剪贴板同步、文件传输、终端、隐私屏等桌面端扩展能力。iOS 作为控制端，不作为被控端。

## 构建

需要 macOS 和包含 iOS SDK 的 Xcode。准备源码可以独立执行：

```bash
python3 scripts/prepare_ios_client.py --source .tools/ios-source
python3 scripts/build_ios_client.py --source .tools/ios-source --sdk iphoneos
# 或构建模拟器版本
python3 scripts/build_ios_client.py --source .tools/ios-source --sdk iphonesimulator
```

准备脚本只接受固定版本的干净上游检出；已经准备过的目录会核对输入和文件哈希。
修改集成源码后请使用新的源码目录，避免覆盖手工改动。构建输出目录默认也必须尚不存在，可用 `--output` 指定新目录。

GitHub Actions 的 **iOS Client Development Build** 同时构建 `iphoneos` 和 `iphonesimulator`，附带源码、许可、构建日志、文件哈希和构建回执。
`protocol` 作业使用 macOS Foundation / Security 和本机生成的测试证书，检查真实双向 TLS、证书替换、重定向、响应大小、取消及配对状态校验。
`pairing` 作业直接编译生产配对、HTTP、加密及工具模块，使用模拟电脑完成原生握手，并检查错误核对码、畸形挑战、错误签名、拒绝、过期和取消。
这些检查不需要 iOS 设备，也不代表真机验收。

## 设备到位后安装

1. 在 Mac 上准备源码，打开 `.tools/ios-source/Moonlight.xcodeproj`，选择 **Moonlight** scheme 和实际 iPhone / iPad。
2. 在 Signing & Capabilities 中选择自己的开发团队，使用唯一的 Bundle Identifier，开启自动签名。项目及 Info.plist 默认均为 `com.cliprelay.controller`；更改时请保持一致。
3. 由 Xcode 构建并运行到设备。CI 产物未签名，不能直接把 ZIP 安装到 iPhone。
4. 电脑开启 ClipRelay 远程访问，手机与电脑连接同一局域网；允许本地网络访问后添加电脑，核对标识并在电脑允许连接。
5. 选择电脑上的 Desktop / 应用开始远控。可从屏幕左边缘滑动退出，三指轻点打开上游软键盘入口；也可使用外接键盘、鼠标或手柄。

设备安装签名、系统权限、配对与撤权界面、真实画面、声音、触控、多指操作、横竖屏/安全区域、键盘、锁屏恢复及剪贴板系统提示均留待真机验收。
`build-receipt.json` 的 `physicalDeviceAccepted` 和 `streamingAccepted` 在本轮始终为 `false`，不会用编译成功代替。

## 许可

集成客户端及新增原生模块按 GPL-3.0-or-later 发布。固定的上游源码、子模块和原有许可随开发构建归档，版本与许可索引见 `upstream.json`。
