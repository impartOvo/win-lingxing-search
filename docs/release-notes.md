# v1.2.2 · Windows 与 macOS

- 普通采集不再保存完整网络记录或自动保存爬虫模板，保留必要登录态和正常业务报表。
- `--save-template` 主动启用爬虫模板，过滤 Cookie 及无关请求头；模板仍包含身份令牌，仅限本机保存。`--diagnostics` 仅保存请求路径、状态与数据结构摘要。
- 采集开始时移除旧模板和旧网络记录，不删除历史报表与登录态。
- 两端从同一国家列表读取 22 个候选，仍可手动输入。
- Windows EXE 的版本由 package.json 生成；新增 GitHub 自动编译、打包前自检、解压后自检与 SHA256 校验。
- Mac 增加 `--collect-once` 实际账号采集回归入口，自动输出测试报告和退出码。首次登录仍由使用者在专用 Chrome 中完成。
- 普通提交只生成构建产物，版本标签与 package.json 一致且三种平台包检查全部通过后才发布；不会自动覆盖已有 Release。

Windows：解压 `windows-x64.zip`，双击「商品诊断.exe」，需 Windows x64、.NET Framework 4.8/4.8.1 和 Google Chrome。

macOS：按芯片下载 `mac-arm64.zip` 或 `mac-x64.zip`，将 .app 拖到应用程序。需要 macOS 13+ 与 Google Chrome。当前为 ad-hoc 签名，未经过 Apple Developer ID 签名或公证。

构建机执行合成数据自检和应用启动检查，不登录实际领星账号；实际采集需在自己的电脑验证。JSON 结果格式保持兼容。
