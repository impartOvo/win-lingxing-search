using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;

namespace ProductDiagnosis
{
    internal static class MonitoringRunner
    {
        internal static object Call(string root, string dataRoot, object packet)
        {
            var info = NativeWindow.NodeStartInfo(root, new[] { Path.Combine(root, "workspace.cjs"), "--data", dataRoot });
            info.RedirectStandardInput = true;
            using (var process = new Process { StartInfo = info }) {
                process.Start(); var output = process.StandardOutput.ReadToEndAsync(); var error = process.StandardError.ReadToEndAsync();
                using (var writer = new StreamWriter(process.StandardInput.BaseStream, new UTF8Encoding(false))) writer.Write(ReportData.Serializer().Serialize(packet));
                if (!process.WaitForExit(240000)) { process.Kill(); throw new TimeoutException("工作台操作超时，请检查连接或查看日志。"); }
                if (process.ExitCode != 0) throw new InvalidOperationException(error.Result.Trim());
                return ReportData.Serializer().DeserializeObject(output.Result);
            }
        }
        internal static bool Notify(IEnumerable<object> notifications)
        {
            var list = notifications.ToList(); if (!list.Any()) return false;
            using (var icon = new System.Windows.Forms.NotifyIcon()) {
                bool shown = false;
                icon.BalloonTipShown += delegate { shown = true; };
                icon.Icon = System.Drawing.Icon.ExtractAssociatedIcon(System.Reflection.Assembly.GetExecutingAssembly().Location);
                icon.Text = "PulsarFetch"; icon.Visible = true;
                string title = list.Count == 1 ? ReportData.TextAt(list[0], "title") : "PulsarFetch · " + list.Count + " 项提醒";
                string text = string.Join("\n", list.Take(3).Select(n => ReportData.TextAt(n, "message")));
                icon.ShowBalloonTip(6000, title, text.Length > 220 ? text.Substring(0, 220) + "…" : text, System.Windows.Forms.ToolTipIcon.Info);
                var until = DateTime.UtcNow.AddSeconds(7);
                while (DateTime.UtcNow < until) { System.Windows.Forms.Application.DoEvents(); System.Threading.Thread.Sleep(50); }
                icon.Visible = false;
                return shown;
            }
        }
        internal static int Run(string root, string[] args)
        {
            string dataRoot = root;
            try {
                if (args.Length == 3 && args[1] == "--data") dataRoot = Path.GetFullPath(args[2]);
                else if (args.Length != 1) throw new ArgumentException("无效的监控入口参数。");
                var state = Call(root, dataRoot, new { module = "monitoring", request = new { action = "tick" } });
                var notifications = ReportData.Items(ReportData.Value(state, "pendingNotifications")).ToArray();
                if (notifications.Length > 0) {
                    if (Notify(notifications)) Call(root, dataRoot, new { module = "monitoring", request = new { action = "ack-notifications", ids = notifications.Select(n => ReportData.TextAt(n, "id")).ToArray(),
                        versions = notifications.ToDictionary(n => ReportData.TextAt(n, "id"), n => ReportData.Value(n, "notifyVersion")) } });
                }
                return 0;
            } catch (Exception error) {
                try { var file = Path.Combine(dataRoot, ".private", "monitoring", "background-errors.log"); Directory.CreateDirectory(Path.GetDirectoryName(file)); File.AppendAllText(file, DateTimeOffset.Now.ToString("o") + " " + error.Message + Environment.NewLine, new UTF8Encoding(false)); } catch (IOException) { } catch (UnauthorizedAccessException) { }
                return 1;
            }
        }
    }
}
