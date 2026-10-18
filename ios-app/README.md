# iOS 控制端开发

此目录开始补齐 iPhone / iPad 控制端。串流基础固定为 Moonlight iOS
`02dc9780496eeeac6d01c8bbdccb8b6fe71ef28a`，其 `moonlight-common-c` 与现有桌面端相同。
版本、子模块及许可证见 `upstream.json`；原生构建入口为
`scripts/build_ios_client.py` 和 `.github/workflows/ios-client.yml`。

当前阶段只准备模拟器和 iOS 设备 SDK 的开发构建。构建不会签名或安装到真实设备，
也尚未接入 ClipRelay 的证书绑定、两端核对码、电脑端批准和撤销流程。
上游 PIN 配对界面目前仍在，不能据此宣称已经支持连接 ClipRelay。

后续接入必须保留服务器证书固定、唯一客户端身份、配对到期及取消、当前串流归属和
加密传输要求，再验收实际视频、音频和触摸输入。iOS 控制端完成状态必须由这些运行证据确认，
不能以编译成功代替。源码和原有许可证随开发构建保留；发布与真机签名另行处理。
