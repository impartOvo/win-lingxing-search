# win-lingxing-search

领星 ERP 商品数据采集与查看工具。Windows 原生 C# / WPF 桌面界面，深灰背景、蓝色强调色；双击 EXE 启动，日常运行不调用 PowerShell。

## 下载运行

从本仓库 Releases 下载 Windows x64 ZIP，解压到有写入权限的目录，双击 `商品诊断.exe`。

- 系统：Windows x64，.NET Framework 4.8 / 4.8.1，已安装 Google Chrome。
- 便携包包含 Node 运行时与 Playwright 依赖，保留完整目录。
- 第一次采集在应用打开的专用 Chrome 中自行登录领星；无需官方付费 API。
- 点击「采集条件」，填写标识、匹配方式、国家、店铺和日期，点击「开始采集」。
- 可按 ASIN、父 ASIN、SKU、MSKU、FNSKU、SPU 或品名查询，支持模糊和精确搜索。
- FNSKU 会先从 Listing 解析为 MSKU，再查询产品表现；仍匹配多条时会报错。
- 结果页提供指标卡片、流量与转化、库存与退款、关联 MSKU 明细；历史页可重开本机结果。

当前版本查询「产品表现」的时间段汇总。没有采集逐日趋势、退货原因明细或店铺检查报告；领星页面或内部请求变化后可能需要更新采集代码。

## 源码构建

需要 Windows、Node.js 20 或以上、npm，以及 .NET Framework C# 编译器。锁文件固定了已验证的依赖版本。

```powershell
npm ci
powershell.exe -NoProfile -ExecutionPolicy Bypass -File desktop/build-exe.ps1
```

PowerShell 仅用于开发构建。构建后运行 `商品诊断.exe`，界面直接启动，并通过随附 Node 进程采集；不会通过 PowerShell 唤醒应用。

开发构建自动复制本机 Node 到 `runtime/`。自行分发运行时与依赖时保留各自许可证；官方便携包包含对应许可证。

## 命令行与对比实验

```powershell
node browser.js --type parent_asin --value B0ASIN0001 --match exact --country 加拿大 --from 2025-01-01 --to 2025-01-30
node browser.js --type name --value "示例品名" --match fuzzy --country 德国 --period prev30
node crawler.js
```

示例标识为占位符，使用时替换为自己的商品。`crawler.js` 复用浏览器已观察到的只读请求模板，用于同条件取数对比。登录失效时先运行浏览器版。两个脚本均保存独立结果，直连版不自动进入桌面结果视图。

## 数据与迁移

- `results/browser-时间.json`：查询条件、范围、采集状态、行数和耗时。
- `results/browser-data-时间.json`：领星返回的实际指标。
- `.private/`：登录状态、浏览器配置、请求模板与本地日志，仅在本机生成。
- 同一次采集有两个 JSON 文件，不表示有两个商品。父体行还可能包含多个款式与多个 MSKU。
- 支持读 JSON 的 AI 可分析上传的结果；分析时同时提供查询记录和数据文件。
- 迁移 Windows 电脑：复制完整应用目录，删除目标副本整个 `.private/`，首次采集重新登录。保留 `results/` 可保留历史；新电脑重新创建快捷方式。
- 当前 EXE 仅支持 Windows，不能直接在 macOS 运行；Mac 版需要单独适配界面和运行时。

不要公开 `.private/` 或真实业务结果。源码仓库与发布包不包含账户、登录信息、真实报表、原桌面快捷方式或业务截图。`examples/` 是完全合成的数据。

## 文件结构

| 文件 | 用途 |
|---|---|
| `desktop/App.cs` | 原生 Windows 界面控制和采集进程管理 |
| `desktop/ReportData.cs` | JSON 读取、字段与展示模型 |
| `desktop/NativeChecks.cs` | 参数、合成数据、模块连接自检 |
| `launcher.xaml` | 深色 WPF 界面，构建时嵌入 EXE |
| `browser.js` | Playwright 复用登录态、筛选报表、读取响应和翻页 |
| `crawler.js` | 复用本地已捕获的只读请求进行对比 |
| `shared.js` | 参数校验与公共取数工具 |
| `launcher.ps1`、`ui-data.ps1` | 早期界面源码参考，EXE 不依赖它们 |

[会话整理](docs/session-summary.md) · [字段说明](docs/data-format.md) · [隐私发布流程](docs/privacy.md)

## 许可证

本项目原创代码采用 MIT。Node.js、Playwright 等第三方组件按各自许可证分发，见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
