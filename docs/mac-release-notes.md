macOS 商品诊断应用，支持 macOS 13 Ventura 或以上。

- Apple 芯片（M 系列）下载 `mac-arm64.zip`；Intel Mac 下载 `mac-x64.zip`。
- 解压后把 `Lingxing Search.app` 拖入「应用程序」，双击启动。
- 内置运行时，无需自行安装 Node、Python 或 .NET；需要安装 Google Chrome。
- 深色背景、蓝色强调色、侧栏导航、采集条件、结果卡片、关联 MSKU、历史与日志。
- 第一次采集在专用 Chrome 中自行登录领星；登录状态和结果存储在用户数据目录，可在应用中点击「打开数据目录」。

本版使用临时（ad-hoc）签名，未使用 Apple Developer ID 签名或公证。首次打开可能被 macOS 拦截：确认下载来源后，在系统设置「隐私与安全性」中按系统提示允许本应用。不要关闭系统整体安全保护。

构建在两种架构的 macOS 15 环境上执行数据测试、Chrome 连接检查、应用启动及 IPC 检查、代码签名完整性检查和 ZIP 解压后的应用启动检查。构建机没有领星账号，因此不声称完成了 Mac 上的真实账号报表采集；首次登录后的取数需要在使用者的 Mac 上验证。

发布包不携带真实业务数据或登录状态。原项目代码 MIT；Electron、Chromium、Playwright 等按随附的各自许可证分发。SHA-256 见校验文件。
