# Android 腾讯云更新源

手机更新清单：`https://124-221-36-36.anyip.dev:8443/cliprelay/update.json`。
APK 同样通过这个 HTTPS 地址下载，手机不需要连接 GitHub。

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

发布脚本只接受 `update.json` 和对应的 `ClipRelay-X.Y.Z.apk` 两个普通文件，
验证摘要后先原子写入 APK，再原子更新清单中的腾讯云下载地址。
旧版本不会覆盖新版本，同一 versionCode 也不能替换成不同 APK。
手机仍然校验 APK 包名、版本号、SHA-256 和已安装应用的签名。

Linux 上运行 `python3 deploy/test_cliprelay_publish.py` 验证发布、摘要失败、
降级保护、同版本覆盖及归档路径处理。

首次迁移需要通过 USB 覆盖安装使用新更新源的签名版本，之后可在手机内检查、下载、安装更新。

Caddy 路由依据：[handle_path](https://caddyserver.com/docs/caddyfile/directives/handle_path)、
[file_server](https://caddyserver.com/docs/caddyfile/directives/file_server)。
