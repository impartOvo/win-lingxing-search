using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading.Tasks;
using System.Windows.Controls;

namespace ProductDiagnosis
{
    internal sealed partial class NativeWindow
    {
        private bool mcpBusy;
        private int mcpRevision;
        private void InitializeMcp()
        {
            foreach (string name in new[] { "SourceBox", "AutoSourceBox" }) {
                Get<ComboBox>(name).ItemsSource = new[] { "浏览器采集", "MCP 直接采集" };
                Get<ComboBox>(name).SelectedIndex = 0;
            }
            foreach (string name in new[] { "CurrencyBox", "AutoCurrencyBox" }) {
                Get<ComboBox>(name).ItemsSource = new[] { "自动", "EUR", "USD", "CAD", "GBP", "MXN", "CNY", "PLN", "SEK", "TRY", "BRL", "JPY" };
                Get<ComboBox>(name).SelectedIndex = 0;
            }
            Get<ComboBox>("McpHeaderBox").ItemsSource = new[] { "X-Mcp-Key", "Authorization" };
            Get<ComboBox>("McpHeaderBox").SelectedIndex = 0;
            Get<ComboBox>("McpTransportBox").ItemsSource = new[] { "auto", "http", "sse" };
            Get<ComboBox>("McpTransportBox").SelectedIndex = 0;
            Click("McpSaveButton", () => McpOperation("save"));
            Click("McpImportButton", () => McpOperation("import-codex"));
            Click("McpTestButton", () => McpOperation("test"));
        }
        private string SourceValue(string name) { return Get<ComboBox>(name).SelectedIndex == 1 ? "mcp" : "browser"; }
        private string CurrencyValue(string name) { string value = Get<ComboBox>(name).Text.Trim().ToUpperInvariant(); return value == "自动" ? "" : value; }
        private object McpCall(object request)
        {
            string dataRoot = options.SmokeTest ? automationDataRoot : root;
            var info = NodeStartInfo(root, new[] { Path.Combine(root, "mcp", "cli.cjs"), "--data", dataRoot });
            info.RedirectStandardInput = true;
            using (var process = new Process { StartInfo = info }) {
                EnsureSessionActive();
                process.Start();
                var output = process.StandardOutput.ReadToEndAsync(); var error = process.StandardError.ReadToEndAsync();
                using (var writer = new StreamWriter(process.StandardInput.BaseStream, new UTF8Encoding(false))) writer.Write(ReportData.Serializer().Serialize(request));
                if (!process.WaitForExit(180000)) { process.Kill(); throw new TimeoutException("MCP 连接操作超时，请检查网络。"); }
                if (process.ExitCode != 0) throw new InvalidOperationException(error.Result.Trim());
                return ReportData.Serializer().DeserializeObject(output.Result);
            }
        }
        private async void McpOperation(string action)
        {
            if (mcpBusy) return;
            mcpBusy = true;
            mcpRevision++;
            foreach (string name in new[] { "McpSaveButton", "McpImportButton", "McpTestButton" }) Get<Button>(name).IsEnabled = false;
            try {
                object request = action == "save" ? (object)new { action, url = Get<TextBox>("McpUrlBox").Text, key = Get<PasswordBox>("McpKeyBox").Password,
                    header = Get<ComboBox>("McpHeaderBox").SelectedItem, transport = Get<ComboBox>("McpTransportBox").SelectedItem } : new { action };
                SetText("McpNotice", action == "test" ? "正在验证独立连接与只读查询…" : "正在处理…");
                object state = await Task.Run(() => McpCall(request));
                Get<PasswordBox>("McpKeyBox").Clear();
                ApplyMcpState(state);
                SetText("McpNotice", action == "test" ? "连接成功 · 国家 " + ReportData.TextAt(state, "countries") + " · 店铺 " + ReportData.TextAt(state, "shops") + " · 产品表现查询已就绪" : "连接已保存。请选择 MCP 通道采集；原有任务通道保持不变。");
            } catch (Exception error) { SetText("McpNotice", error.Message); }
            finally { mcpBusy = false; foreach (string name in new[] { "McpSaveButton", "McpImportButton", "McpTestButton" }) Get<Button>(name).IsEnabled = true; }
        }
        private async void RefreshMcp()
        {
            if (mcpBusy) return;
            int revision = mcpRevision;
            try { object state = await Task.Run(() => McpCall(new { action = "status" })); if (revision == mcpRevision && !mcpBusy) ApplyMcpState(state); }
            catch (Exception error) { SetText("McpNotice", error.Message); }
        }
        private void ApplyMcpState(object state)
        {
            Get<TextBox>("McpUrlBox").Text = ReportData.TextAt(state, "url");
            Get<ComboBox>("McpHeaderBox").SelectedItem = ReportData.TextAt(state, "header");
            Get<ComboBox>("McpTransportBox").SelectedItem = ReportData.TextAt(state, "transport");
            SetText("McpSavedText", ReportData.Value(state, "configured") is bool && (bool)ReportData.Value(state, "configured") ? "已保存密钥（不回显）。密钥框留空可保留原密钥。" : "尚未配置 MCP，浏览器采集可继续使用。");
        }
        private async Task McpSmokeCheck()
        {
            ShowPage("mcp");
            Get<TextBox>("McpUrlBox").Text = "https://example.invalid/mcp";
            Get<PasswordBox>("McpKeyBox").Password = "demo-key";
            Get<ComboBox>("McpHeaderBox").SelectedItem = "X-Mcp-Key";
            Get<ComboBox>("McpTransportBox").SelectedItem = "auto";
            Get<Button>("McpSaveButton").RaiseEvent(new System.Windows.RoutedEventArgs(System.Windows.Controls.Primitives.ButtonBase.ClickEvent));
            DateTime deadline = DateTime.UtcNow.AddSeconds(40);
            while (mcpBusy) { if (DateTime.UtcNow > deadline) throw new TimeoutException("MCP 设置界面自检超时。"); await Task.Delay(50); }
            Require(Get<TextBlock>("McpNotice").Text.Contains("连接已保存"), "MCP 设置保存失败：" + Get<TextBlock>("McpNotice").Text);
            Require(Get<PasswordBox>("McpKeyBox").Password == "" && Get<TextBlock>("McpSavedText").Text.Contains("已保存密钥"), "MCP 密钥未在保存后清空或状态不正确。");
            string persisted = File.ReadAllText(Path.Combine(automationDataRoot, ".private", "mcp", "connection.json"));
            Require(!persisted.Contains("demo-key"), "Windows MCP 密钥没有受到系统加密保护。");
            OpenCollection(Path.Combine(root, "examples", "mcp-demo.json"), true);
            Get<RadioButton>("ResultInfoTab").IsChecked = true;
            Require(Get<System.Windows.UIElement>("ResultInfoBox").Visibility == System.Windows.Visibility.Visible && Get<TextBox>("ResultInfoBox").Text.Contains("MCP"), "采集信息页未展示 MCP 来源。");
            Get<RadioButton>("ResultJsonTab").IsChecked = true;
            Require(ReportData.Value(ReportData.Serializer().DeserializeObject(Get<TextBox>("ResultJsonBox").Text), "data", "list") != null, "原始 JSON 页缺少真实数据。");
            Get<RadioButton>("ResultRecordsTab").IsChecked = true;
            Require(Get<ComboBox>("SourceBox").SelectedIndex == 1 && Get<TextBlock>("SourceSavedText").Text.Contains("MCP"), "MCP 结果未显示来源或回填采集通道。");
            ShowPage(initialPage); Window.UpdateLayout();
        }
    }
}
