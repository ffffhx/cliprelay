# ClipRelay 官网

中文静态官网，无框架、无构建依赖。发布目录为 `dist/`，Sites 项目标识保存在 `.openai/hosting.json`。官网代码由 Sites 的独立源码仓库维护，不推送 ClipRelay 主仓库中尚未发布的应用改动。

## 本地预览

```powershell
node preview.mjs
```

默认只监听 `127.0.0.1:4173`。退出预览进程后停止服务。

## 内容维护

- `dist/index.html`：文案、平台状态、正式版本下载入口。
- `dist/styles.css`：响应式布局与视觉样式。
- `dist/app.js`：移动导航、功能切换与命令复制。
- `dist/assets/logo.png`：复用 ClipRelay 项目标识。

发布新应用版本后运行 `node refresh-releases.mjs`，从公开 GitHub Releases 与云端更新清单核对版本和下载地址并更新页面，再按 Sites 工作流发布官网。脚本不发布应用版本，不上传安装包。官网将开发中的 AI 接口与正式下载版本分开描述；Windows 0.4.3 正式发布后还需人工核对并更新相关功能状态文案。

macOS 分别显示 Apple Silicon 与 Intel 下载，核对 Release 中的 `macos-update.json`、两个 ZIP 的地址与大小。当前展示完整功能、未公证、串流验收后置的发布状态；签名、公证、功能范围或验收状态变化时，刷新脚本会停止，需先更新对应说明再发布页面。

页面中的设备和窗口是功能示意，不代表实时设备状态。页面不读取设备目录、不发起远控，也不收集访客信息；功能操作仅发生在用户安装的应用中。
