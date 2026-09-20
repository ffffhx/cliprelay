# ClipRelay 腾讯云更新源

手机更新清单：`https://124-221-36-36.anyip.dev:8443/cliprelay/update.json`。
APK 同样通过这个 HTTPS 地址下载，手机不需要连接 GitHub。

Windows 使用独立清单：`https://124-221-36-36.anyip.dev:8443/cliprelay/windows/update.json`。
安装包位于同目录的 `ClipRelay-Windows-X.Y.Z.zip`，不会覆盖 Android 清单。

## 发布

提高 Android `versionCode` 和 `versionName` 后推送到 main，原有 Android Release
工作流构建签名包并发布 GitHub Release。随后 Android Cloud Sync 下载发布文件，
校验 SHA-256，通过 SSH 将文件推送到腾讯云；服务器无需访问 GitHub。
Cloud Sync 可以单独手动重跑，用于补发已有 Release。

仓库配置：

- Secret `CLIPRELAY_UPDATES_SSH_KEY`：专用发布私钥。
- Variable `CLIPRELAY_UPDATES_KNOWN_HOSTS`：固定的服务器 SSH 公钥记录。

发布账号 `cliprelay-updates` 无 sudo 权限，SSH 公钥使用
`restrict,command="/usr/local/bin/cliprelay-publish"`，只能接收发布归档，不能执行任意命令。
私钥不能进入 Git 或手机 APK。

## 服务器

- 静态文件目录：`/srv/cliprelay-updates`。
- 发布脚本：`/usr/local/bin/cliprelay-publish`，来源为本目录的 `cliprelay-publish.py`。
- Caddy 在现有 `room_services` 中通过 `handle_path /cliprelay/*` 提供文件，
  清单使用 `Cache-Control: no-store`，隐藏 `.publish*` 临时文件。
- 使用现有 `8443` HTTPS 入口；当前网络访问 `443` 会重置连接。
- HTTPS 证书沿用服务器现有 `/etc/caddy/anyip/` 证书和维护方式。

Android 发布只接受 `update.json` 和对应的 `ClipRelay-X.Y.Z.apk` 两个普通文件，
验证摘要后先原子写入 APK，再原子更新清单中的腾讯云下载地址。
旧版本不会覆盖新版本，同一 versionCode 也不能替换成不同 APK。
手机仍然校验 APK 包名、版本号、SHA-256 和已安装应用的签名。

## Windows 发布

现有服务器已于 2026-09-20 启用 Windows 渠道并发布 v0.1.0。首次启用步骤已完成；
以后发布继续使用同一更新地址和发布账号。

首次启用 Windows 渠道前，需要把本目录新版 `cliprelay-publish.py` 安装到服务器
`/usr/local/bin/cliprelay-publish`（保持 root 拥有、755 权限），复用现有发布账号和 HTTPS 静态目录。
请确保 Windows 清单也设置 `Cache-Control: no-store`；客户端自身同时禁用清单缓存。
现有 Caddy `handle_path /cliprelay/*` 中，将私有文件匹配改为
`@private path /.publish* /windows/.publish*`，并增加
`header /windows/update.json Cache-Control "no-store"`。
先验证 Caddy 配置，再 reload，保留同一入口下其他服务的配置。
更新客户端初次连到尚未发布的渠道时，会显示「暂未发布 Windows 版本」。

每次发布：

1. 同时提高 `windows/version.json` 的 `versionCode` 和 `versionName`，例如 `2` / `0.1.1`。
2. 在 `windows/release-notes.txt` 写面向朋友的更新内容。这里的原文会显示在客户端里。
3. 提交并推送代码，在 GitHub Actions 手动运行 `Windows Release`，或推送与版本匹配的
   `windows-vX.Y.Z` 标签。工作流运行 Windows 测试，打包包含视频引擎的 ZIP，
   发布独立 Windows Release，再复用现有 SSH 发布凭据同步到云端。
4. 确认工作流 `sync` 成功；朋友的客户端会在下一次检查时显示新版。

云端同步失败时可重跑任务。相同版本会复用已经发布的安装包，不会重新生成并替换；
代码有新改动必须提高版本号。Windows Release 使用 `--latest=false`，保留现有 Android
Release 的 latest 入口；Windows 更新检查只读取自己的云端清单。
工作流触发方式依据 [GitHub 文档](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_dispatch)。

本地准备安装包（不发布）：

```powershell
powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File scripts/package_windows.ps1
```

输出在 `.tools/windows-release/`：ZIP 和 `windows-update.json`。打包脚本使用文件白名单，
不包含本机配置、设备地址、访问密钥、历史记录或 SSH 密钥。安装包约 160 MB，视频引擎占大部分体积。
Windows 包与清单构成恰好两个普通文件的 tar，通过现有受限 SSH `publish` 命令上传；
发布脚本校验大小、SHA-256、版本和更新说明，先写包再原子替换 `windows/update.json`。
Windows 同样禁止降级或用不同安装包覆盖同一版本。

验证客户端：`powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File windows/tests/updates.ps1`；
增加 `-Network` 可验证现有云端 HTTPS 下载和损坏文件拒绝，不会发布测试版本。
Linux 上执行 `python3 deploy/test_cliprelay_publish.py` 同时验证 Android / Windows 两个渠道。

Linux 上运行 `python3 deploy/test_cliprelay_publish.py` 验证发布、摘要失败、
降级保护、同版本覆盖及归档路径处理。

首次迁移需要通过 USB 覆盖安装使用新更新源的签名版本，之后可在手机内检查、下载、安装更新。

Caddy 路由依据：[handle_path](https://caddyserver.com/docs/caddyfile/directives/handle_path)、
[file_server](https://caddyserver.com/docs/caddyfile/directives/file_server)。
