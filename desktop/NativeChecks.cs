using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;

namespace ProductDiagnosis
{
    internal static class NativeChecks
    {
        private static void Require(bool condition, string message)
        {
            if (!condition) throw new InvalidOperationException(message);
        }

        internal static void Run(string root)
        {
            Require(ReportData.Format(null) == "—" && ReportData.Format(0) == "0", "空值和零值未区分。");
            Require(ReportData.Rate("0.125") == "12.50%" && ReportData.Rate("0.25") == "25.00%", "百分比格式不正确。");
            Require(!Assembly.GetExecutingAssembly().GetReferencedAssemblies().Any(x => x.Name.IndexOf("Automation", StringComparison.OrdinalIgnoreCase) >= 0), "EXE 不应依赖脚本宿主。");

            string[] expected = { "中文 店铺", "B0ASIN0001", "末尾\\", "a\"b", "" };
            string json = RunNode(root, new[] { "-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", "--" }.Concat(expected).ToArray());
            string[] actual = ReportData.Items(ReportData.Serializer().DeserializeObject(json)).Select(ReportData.Text).ToArray();
            Require(expected.SequenceEqual(actual), "传给 Node 的中文或特殊字符参数不正确。");
            string help = RunNode(root, new[] { Path.Combine(root, "browser.js"), "--help" });
            Require(help.IndexOf("fnsku", StringComparison.OrdinalIgnoreCase) >= 0 && help.Contains("--country"), "采集模块或 Playwright 依赖无法加载。");
            string countries = RunNode(root, new[] { "-e", "process.stdout.write(JSON.stringify(require('./shared').COUNTRIES))" });
            Require(NativeWindow.CountryOptions().SequenceEqual(ReportData.Items(ReportData.Serializer().DeserializeObject(countries)).Select(ReportData.Text)), "两端国家候选不一致。");
            CheckAutomationRunner(root);
            string mcpHelp = RunNode(root, new[] { Path.Combine(root, "collector.cjs"), "--help" });
            Require(mcpHelp.Contains("--source") && mcpHelp.Contains("--currency"), "统一采集入口缺失。");
            Require(ReportData.ReadBundle(Path.Combine(root, "examples", "mcp-demo.json")).Rows.Count == 1, "MCP 结果兼容读取失败。");

            string sample = Path.Combine(root, "examples", "browser-demo.json");
            if (File.Exists(sample))
            {
                CollectionBundle bundle = ReportData.ReadBundle(sample);
                Require(bundle.Rows.Count == 1, "合成示例数量不正确。");
                object raw = bundle.Rows[0].Raw;
                var variants = ReportData.Variants(raw, "CAD");
                Require(ReportData.Number(ReportData.Value(raw, "volume")) == 12 && variants.Count == 2 && variants.Sum(x => x.Sales ?? 0) == 12, "合成示例或关联 MSKU 读取不完整。");
                Require(ReportData.Rate(ReportData.Value(raw, "return_goods_rate")) == "8.33%", "退货率字段读取错误。");
                Require(ReportData.Rate(ReportData.Value(raw, "return_rate")) == "16.67%", "退款率字段读取错误。");
            }
        }

        private static void CheckAutomationRunner(string root)
        {
            string dataRoot = Path.Combine(root, ".private", "desktop-tests", "scheduler-中文 " + Guid.NewGuid().ToString("N"));
            string config = Path.Combine(dataRoot, ".private", "automation", "tasks.json");
            Directory.CreateDirectory(Path.GetDirectoryName(config));
            File.WriteAllText(config, "{\"enabled\":false,\"tasks\":[]}");
            Require(RunAutomationTick(root, dataRoot) == 0, "无到期任务的后台检查失败。");
            Require(!Directory.Exists(Path.Combine(dataRoot, ".private", "automation", "runs")), "空闲检查不应发起采集。");

            File.WriteAllText(config, "{\"enabled\":true,\"tasks\":null}");
            Require(RunAutomationTick(root, dataRoot) != 0, "后台失败退出码未传递给系统调度器。");
            string log = Path.Combine(dataRoot, ".private", "automation", "logs", "scheduler-error.log");
            Require(File.Exists(log) && File.ReadAllText(log).Contains("任务配置损坏"), "后台错误未写入日志。");
        }

        private static int RunAutomationTick(string root, string dataRoot)
        {
            using (var process = new Process { StartInfo = new ProcessStartInfo {
                FileName = Path.Combine(root, "PulsarFetch.exe"),
                Arguments = "--automation-tick --data " + NativeWindow.QuoteArgument(dataRoot),
                WorkingDirectory = root, UseShellExecute = false
            } })
            {
                // Do not hide the launcher here: its GUI subsystem must be sufficient.
                process.Start();
                if (!process.WaitForExit(20000)) { process.Kill(); throw new TimeoutException("后台入口未退出。"); }
                return process.ExitCode;
            }
        }

        private static string RunNode(string root, string[] arguments)
        {
            using (var process = new Process { StartInfo = NativeWindow.NodeStartInfo(root, arguments) })
            {
                process.Start();
                var output = process.StandardOutput.ReadToEndAsync();
                var error = process.StandardError.ReadToEndAsync();
                if (!process.WaitForExit(20000)) { process.Kill(); throw new TimeoutException("Node 运行时检查超时。"); }
                if (process.ExitCode != 0) throw new InvalidOperationException("采集模块启动失败：" + error.Result);
                return output.Result;
            }
        }
    }
}
