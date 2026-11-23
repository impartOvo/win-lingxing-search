using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Threading;

namespace ProductDiagnosis
{
    internal sealed partial class NativeWindow
    {
        private object monitorState, scopeOptions;
        private string editRuleId;
        private object batchPacket;
        private bool featureBusy, monitoringBusy, monitorRefreshing, scopeLoading;
        private int monitorRevision;
        private DispatcherTimer featureTimer;
        private object FeatureCall(string module, object request) { EnsureSessionActive(); return MonitoringRunner.Call(root, automationDataRoot, new { module, request }); }
        private static Dictionary<string, object> CopyObject(object value) { return value == null ? new Dictionary<string, object>() : (Dictionary<string, object>)ReportData.Serializer().DeserializeObject(ReportData.Serializer().Serialize(value)); }
        private static string[] Lines(string text) { return text.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries).Select(s => s.Trim()).Where(s => s.Length > 0).Distinct().ToArray(); }
        private string Text(string name) { return Get<TextBox>(name).Text.Trim(); }
        private int Integer(string name) { int n; if (!int.TryParse(Text(name), NumberStyles.None, CultureInfo.InvariantCulture, out n)) throw new ArgumentException("请填写有效的非负整数。"); return n; }
        private string Country(string name) { string text = Get<ComboBox>(name).Text.Trim(); return text == "全部国家" ? "" : text; }
        private void InitializeFeatures()
        {
            Get<ComboBox>("HistorySourceBox").ItemsSource = new[] { "全部通道", "浏览器", "MCP" }; Get<ComboBox>("HistorySourceBox").SelectedIndex = 0;
            Get<ComboBox>("ExportFormatBox").ItemsSource = new[] { "Excel (.xlsx)", "CSV (.csv)" }; Get<ComboBox>("ExportFormatBox").SelectedIndex = 0;
            Get<ComboBox>("RuleTypeBox").ItemsSource = typeLabels; Get<ComboBox>("RuleTypeBox").SelectedIndex = 3;
            Get<ComboBox>("RuleCountryBox").ItemsSource = new[] { "全部国家" }.Concat(CountryOptions()).ToArray(); Get<ComboBox>("RuleCountryBox").SelectedIndex = 0;
            Get<ComboBox>("AutoGroupFilter").ItemsSource = new[] { "全部任务组" }; Get<ComboBox>("AutoGroupFilter").SelectedIndex = 0;
            Get<DatePicker>("BackfillDatePicker").SelectedDate = DateTime.Today;
            featureTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(15) };
            featureTimer.Tick += delegate {
                if (!CanRefreshVisibleWindow) return;
                if (Get<UIElement>("MonitorPage").IsVisible) RefreshMonitor();
                if (Get<UIElement>("AutomationPage").IsVisible) RefreshDashboard();
            };
        }
        private void WireFeatureEvents()
        {
            Get<RadioButton>("NavMonitor").Checked += delegate { ShowPage("monitor"); if (Window.IsLoaded) RefreshMonitor(); };
            Window.Loaded += delegate { if (initialPage == "monitor") RefreshMonitor(); if (initialPage == "automation") RefreshDashboard(); };
            Click("LoadScopeButton", LoadScopes);
            Get<ComboBox>("CountryBox").AddHandler(TextBox.TextChangedEvent, new TextChangedEventHandler(delegate { ApplyShopOptions("CountryBox", "ShopBox"); }));
            Get<ComboBox>("AutoCountryBox").AddHandler(TextBox.TextChangedEvent, new TextChangedEventHandler(delegate { ApplyShopOptions("AutoCountryBox", "AutoShopBox"); }));
            Get<ComboBox>("RuleCountryBox").AddHandler(TextBox.TextChangedEvent, new TextChangedEventHandler(delegate { ApplyShopOptions("RuleCountryBox", "RuleShopBox"); }));
            Click("AutoBatchOpenButton", () => { RevealAutomationEditor(); Get<UIElement>("BatchCard").Visibility = Visibility.Visible; Get<FrameworkElement>("BatchCard").BringIntoView(); });
            Click("BatchCloseButton", () => Get<UIElement>("BatchCard").Visibility = Visibility.Collapsed);
            Click("BatchPreviewButton", PreviewBatch); Click("BatchSaveButton", SaveBatch);
            Click("AutoCloneButton", () => { var selected = SelectedAutomationTask(); if (selected == null) return; FillAutomationTask(selected.Raw); automationEditId = null; Get<TextBox>("AutoNameBox").Text += " · 副本"; RevealAutomationEditor(); });
            Click("AutoDashboardButton", RefreshDashboard);
            Click("AutoBackfillButton", () => { var row = SelectedAutomationTask(); if (row == null) { SetText("AutoNotice", "请先选择要补采的任务。"); return; } AutomationAction(new { action = "backfill", ids = new[] { row.Id }, scheduledDate = DateString("BackfillDatePicker") }); });
            Click("AutoGroupEnableButton", () => SetGroupEnabled(true)); Click("AutoGroupDisableButton", () => SetGroupEnabled(false));
            Get<ComboBox>("AutoGroupFilter").SelectionChanged += delegate { RenderTaskFilter(); };
            Click("HistoryFilterButton", RefreshDataHistory);
            Click("RefreshHistoryButton", RefreshDataHistory);
            Get<RadioButton>("NavHistory").Checked += delegate { if (Window.IsLoaded && !options.SmokeTest) RefreshDataHistory(); };
            Click("HistoryClearButton", () => { foreach (var name in new[] { "HistorySearchBox", "HistoryCountryBox", "HistoryShopBox" }) Get<TextBox>(name).Clear(); Get<ComboBox>("HistorySourceBox").SelectedIndex = 0; Get<DatePicker>("HistoryFromPicker").SelectedDate = null; Get<DatePicker>("HistoryToPicker").SelectedDate = null; RefreshDataHistory(); });
            Click("ExportHistoryButton", ExportHistory);
            Click("OpenExportsButton", () => { var folder = Path.Combine(root, "exports"); Directory.CreateDirectory(folder); ShellOpen(folder); });
            Click("DailyButton", () => AnalyzeData(false)); Click("CompareButton", () => AnalyzeData(true));
            Click("MonitorRefreshButton", RefreshMonitor); Click("MonitorSaveButton", () => SaveMonitoring(false, false)); Click("MonitorCheckButton", () => MonitorAction(new { action = "tick", force = true }));
            Click("RuleNewButton", ClearRule); Click("RuleSaveButton", () => SaveMonitoring(true, false)); Click("RuleDeleteButton", () => SaveMonitoring(false, true));
            Get<DataGrid>("InventoryRulesGrid").SelectionChanged += delegate { var row = Get<DataGrid>("InventoryRulesGrid").SelectedItem as InventoryRuleRow; if (row != null) FillRule(row.Raw); };
            Click("ReminderReadButton", () => ReminderAction("mark-read")); Click("ReminderSnoozeButton", () => ReminderAction("snooze"));
            Click("ReminderOpenButton", () => { var row = Get<DataGrid>("ReminderGrid").SelectedItem as ReminderRow; if (row == null) return; string target = ReportData.TextAt(row.Raw, "target"); if (target.StartsWith("/erp/", StringComparison.Ordinal)) target = "https://xfg.lingxing.com" + target; Uri uri; if (Uri.TryCreate(target, UriKind.Absolute, out uri) && uri.Scheme == "https" && (uri.Host == "xfg.lingxing.com" || uri.Host == "gw.lingxingerp.com")) ShellOpen(uri.AbsoluteUri); });
        }
        private async void LoadScopes()
        {
            if (scopeLoading) return; scopeLoading = true; Get<Button>("LoadScopeButton").IsEnabled = false;
            try {
                SetText("ScopeNotice", "正在读取当前 MCP 授权范围…");
                scopeOptions = await Task.Run(() => FeatureCall("mcp", new { action = "options" }));
                string[] countries = new[] { "全部国家" }.Concat(ReportData.Items(ReportData.Value(scopeOptions, "markets")).Select(m => ReportData.TextAt(m, "country")).Where(v => v.Length > 0)).Distinct().ToArray();
                foreach (string name in new[] { "CountryBox", "AutoCountryBox", "RuleCountryBox" }) { var box = Get<ComboBox>(name); string text = box.Text; box.ItemsSource = countries; box.Text = text; }
                SetText("ScopeNotice", "已加载 " + (countries.Length - 1) + " 个国家／站点和 " + ReportData.Items(ReportData.Value(scopeOptions, "sellers")).Count() + " 家授权店铺。店铺可从建议列表选择。");
                ApplyShopOptions("CountryBox", "ShopBox"); ApplyShopOptions("AutoCountryBox", "AutoShopBox"); ApplyShopOptions("RuleCountryBox", "RuleShopBox");
            } catch (Exception error) { SetText("ScopeNotice", error.Message); } finally { scopeLoading = false; Get<Button>("LoadScopeButton").IsEnabled = true; }
        }
        private void ApplyShopOptions(string countryName, string shopName)
        {
            if (scopeOptions == null) return;
            string country = Country(countryName), marketId = "";
            foreach (object market in ReportData.Items(ReportData.Value(scopeOptions, "markets"))) if (ReportData.TextAt(market, "country") == country) marketId = ReportData.TextAt(market, "country_id");
            var sellers = ReportData.Items(ReportData.Value(scopeOptions, "sellers")).Where(s => country.Length == 0 || ReportData.TextAt(s, "country_id") == marketId).ToList();
            var shop = Window.FindName(shopName) as ComboBox;
            if (shop != null) { string text = shop.Text; shop.ItemsSource = new[] { "" }.Concat(sellers.Select(s => ReportData.TextAt(s, "seller_simple_name"))).Distinct().ToArray(); shop.Text = text; }
            string[] currencies = sellers.Select(s => ReportData.TextAt(s, "currency_code")).Where(v => v.Length > 0).Distinct().ToArray();
            if (countryName == "CountryBox") Get<ComboBox>("ShopBox").ToolTip = "授权店铺：" + string.Join("、", sellers.Select(s => ReportData.TextAt(s, "seller_simple_name"))) + "\n统计币种：" + string.Join(" / ", currencies);
            if (countryName == "AutoCountryBox") Get<ComboBox>("AutoShopBox").ToolTip = "授权店铺：" + string.Join("、", sellers.Select(s => ReportData.TextAt(s, "seller_simple_name")));
        }
        private void UpdateGroups()
        {
            var box = Get<ComboBox>("AutoGroupFilter"); string selected = box.SelectedItem as string;
            string[] groups = new[] { "全部任务组" }.Concat(workbenchTasks.Select(t => ReportData.TextAt(t.Raw, "group")).Where(g => g.Length > 0).Distinct().OrderBy(g => g)).ToArray();
            if (!box.Items.Cast<string>().SequenceEqual(groups)) { box.ItemsSource = groups; box.SelectedItem = groups.Contains(selected) ? selected : groups[0]; }
        }
        private void SetGroupEnabled(bool enabled)
        {
            string group = Get<ComboBox>("AutoGroupFilter").SelectedItem as string;
            var ids = workbenchTasks.Where(t => group == "全部任务组" || ReportData.TextAt(t.Raw, "group") == group).Select(t => t.Id).ToArray();
            if (ids.Length == 0) { SetText("AutoNotice", "当前任务组没有任务。"); return; }
            AutomationAction(new { action = "set-enabled", ids, enabled });
        }
        private object BuildBatchPacket()
        {
            var task = CopyObject(AutomationEditorTask()); task["name"] = Text("BatchGroupBox");
            return new { task, values = Lines(Get<TextBox>("BatchValuesBox").Text), countries = Lines(Get<TextBox>("BatchCountriesBox").Text), group = Text("BatchGroupBox") };
        }
        private async void PreviewBatch()
        {
            if (featureBusy) return; featureBusy = true;
            try {
                var originalPacket = BuildBatchPacket();
                var packet = CopyObject(originalPacket); packet["action"] = "batch-preview";
                object result = await Task.Run(() => FeatureCall("automation", packet));
                var tasks = ReportData.Items(ReportData.Value(result, "tasks")).ToList();
                Get<DataGrid>("BatchPreviewGrid").ItemsSource = tasks.Select(t => new AutomationTaskRow(t)).ToList();
                batchPacket = originalPacket;
                SetText("BatchNotice", "预览共 " + ReportData.TextAt(result, "count") + " 项。请核对上方通道、日期、星期和时间，再保存。");
            } catch (Exception error) { batchPacket = null; SetText("BatchNotice", error.Message); } finally { featureBusy = false; }
        }
        private async void SaveBatch()
        {
            if (featureBusy) return;
            if (batchPacket == null || ReportData.Serializer().Serialize(batchPacket) != ReportData.Serializer().Serialize(BuildBatchPacket())) { SetText("BatchNotice", "条件已变化或尚未预览，请先重新预览。"); return; }
            featureBusy = true;
            try { var packet = CopyObject(batchPacket); packet["action"] = "save-batch"; object state = await Task.Run(() => FeatureCall("automation", packet)); ApplyAutomationState(state); SetText("BatchNotice", "批量计划已保存。"); batchPacket = null; RefreshDashboard(); }
            catch (Exception error) { SetText("BatchNotice", error.Message); } finally { featureBusy = false; }
        }
        private async void RefreshDashboard()
        {
            try { object result = await Task.Run(() => FeatureCall("automation", new { action = "dashboard" })); SetText("AutoDashboardText", "今日应执行 " + ReportData.TextAt(result, "expected") + " · 成功 " + ReportData.TextAt(result, "success") + " · 失败 " + ReportData.TextAt(result, "failed") + " · 运行中 " + ReportData.TextAt(result, "running") + " · 未发现运行记录 " + ReportData.TextAt(result, "missing")); }
            catch (Exception error) { SetText("AutoDashboardText", error.Message); }
        }
        private async void RefreshDataHistory()
        {
            try {
                object filters = new { search = Text("HistorySearchBox"), country = Text("HistoryCountryBox"), shop = Text("HistoryShopBox"), source = Get<ComboBox>("HistorySourceBox").SelectedIndex == 1 ? "browser" : Get<ComboBox>("HistorySourceBox").SelectedIndex == 2 ? "mcp" : "", from = DateString("HistoryFromPicker"), to = DateString("HistoryToPicker") };
                object result = await Task.Run(() => FeatureCall("data", new { action = "history", filters }));
                var rows = ReportData.Items(ReportData.Value(result, "items")).Select(raw => new HistoryRecord { Path = Path.Combine(resultsDirectory, ReportData.TextAt(raw, "name")), SavedAt = AutomationTime(ReportData.TextAt(raw, "savedAt")), Type = ReportData.TextAt(raw, "type"), Value = ReportData.ProductFilterLabel(ReportData.TextAt(raw, "value")), Country = ReportData.TextAt(raw, "country"), Shop = ReportData.TextAt(raw, "shop"), Dates = ReportData.TextAt(raw, "from") + " — " + ReportData.TextAt(raw, "to"), Source = ReportData.TextAt(raw, "source") == "mcp" ? "MCP" : "浏览器", Currency = ReportData.TextAt(raw, "currency"), Count = ReportData.Number(ReportData.Value(raw, "count")), Quality = string.Join("；", ReportData.Items(ReportData.Value(raw, "quality", "warnings")).Select(ReportData.Text)) }).ToList();
                Get<DataGrid>("HistoryGrid").ItemsSource = rows; SetComparisonChoices(rows); if (rows.Any()) Get<DataGrid>("HistoryGrid").SelectedIndex = 0;
                SetText("HistoryCountText", rows.Count + " 次采集符合当前条件"); Get<Button>("LoadHistoryButton").IsEnabled = rows.Any(); SetText("HistoryFeatureNotice", "");
            } catch (Exception error) { SetText("HistoryFeatureNotice", error.Message); }
        }
        private void SetComparisonChoices(List<HistoryRecord> rows)
        {
            foreach (string name in new[] { "CompareLeftBox", "CompareRightBox" }) { var box = Get<ComboBox>(name); var old = box.SelectedItem as HistoryRecord; box.ItemsSource = rows; box.SelectedItem = rows.FirstOrDefault(r => old != null && r.Path == old.Path) ?? rows.Skip(name == "CompareRightBox" && rows.Count > 1 ? 1 : 0).FirstOrDefault(); }
        }
        private async void ExportHistory()
        {
            var row = Get<DataGrid>("HistoryGrid").SelectedItem as HistoryRecord; if (row == null) { SetText("HistoryFeatureNotice", "请先选择一条采集结果。"); return; }
            string format = Get<ComboBox>("ExportFormatBox").SelectedIndex == 1 ? "csv" : "xlsx";
            Get<Button>("ExportHistoryButton").IsEnabled = false;
            try { object result = await Task.Run(() => FeatureCall("data", new { action = "export", name = Path.GetFileName(row.Path), format })); SetText("HistoryFeatureNotice", "导出完成：" + ReportData.TextAt(result, "path")); }
            catch (Exception error) { SetText("HistoryFeatureNotice", error.Message); } finally { Get<Button>("ExportHistoryButton").IsEnabled = true; }
        }
        private async void AnalyzeData(bool compare)
        {
            try {
                object request;
                if (compare) { var left = Get<ComboBox>("CompareLeftBox").SelectedItem as HistoryRecord; var right = Get<ComboBox>("CompareRightBox").SelectedItem as HistoryRecord; if (left == null || right == null) { SetText("DataAnalysisNotice", "请先选择两次采集。"); return; } request = new { action = "compare", leftName = Path.GetFileName(left.Path), rightName = Path.GetFileName(right.Path) }; }
                else request = new { action = "daily" };
                object result = await Task.Run(() => FeatureCall("data", request)); var rows = new List<FeatureDataRow>();
                foreach (object item in ReportData.Items(ReportData.Value(result, "items"))) {
                    foreach (var metric in new[] { new[] { "volume", "销量" }, new[] { "amount", "销售额" }, new[] { "sessions_total", "会话数" } }) {
                        object value = ReportData.Value(item, "metrics", metric[0]);
                        rows.Add(new FeatureDataRow { Label = compare ? "跨期比较" : ReportData.TextAt(item, "date"), Scope = ReportData.TextAt(item, "entity") + " · " + ReportData.TextAt(item, "country") + " · " + ReportData.TextAt(item, "shop") + " · " + ReportData.TextAt(item, "grain") + (compare ? "" : " · " + (ReportData.TextAt(item, "source") == "mcp" ? "MCP" : "浏览器") + " · 采集于 " + AutomationTime(ReportData.TextAt(item, "savedAt"))), Currency = ReportData.TextAt(item, "currency"), Metric = metric[1], Left = ReportData.Format(compare ? ReportData.Value(value, "left") : value, "N2"), Right = compare ? ReportData.Format(ReportData.Value(value, "right"), "N2") : "", Delta = compare ? ReportData.Format(ReportData.Value(value, "delta"), "N2") : "" });
                    }
                }
                Get<DataGrid>("DataAnalysisGrid").ItemsSource = rows;
                string warning = string.Join("；", ReportData.Items(ReportData.Value(result, "warnings")).Select(ReportData.Text));
                SetText("DataAnalysisNotice", compare ? (ReportData.Value(result, "comparable") is bool && (bool)ReportData.Value(result, "comparable") ? "范围与币种兼容。" : "两次采集不适合直接比较。") + warning : "只归档单个自然日的采集，跳过 " + ReportData.TextAt(result, "skippedRolling") + " 次期间汇总。库存仍是采集时快照。" + warning);
            } catch (Exception error) { SetText("DataAnalysisNotice", error.Message); }
        }
        private void ClearRule()
        {
            editRuleId = null; Get<DataGrid>("InventoryRulesGrid").SelectedIndex = -1;
            foreach (string name in new[] { "RuleNameBox", "RuleValueBox" }) Get<TextBox>(name).Clear();
            Get<ComboBox>("RuleShopBox").Text = ""; Get<ComboBox>("RuleCountryBox").SelectedIndex = 0; Get<TextBox>("RuleThresholdBox").Text = "10"; Get<TextBox>("RuleCooldownBox").Text = "120"; Get<CheckBox>("RuleEnabledBox").IsChecked = true;
        }
        private void FillRule(object rule)
        {
            editRuleId = ReportData.TextAt(rule, "id"); Get<TextBox>("RuleNameBox").Text = ReportData.TextAt(rule, "name"); Get<TextBox>("RuleValueBox").Text = ReportData.TextAt(rule, "value");
            string type = ReportData.TextAt(rule, "type"); int index = Array.FindIndex(typeLabels, t => t.Replace(" ", "") == type.Replace(" ", "")); Get<ComboBox>("RuleTypeBox").SelectedIndex = index < 0 ? Array.IndexOf(typeValues, type) : index;
            string country = ReportData.TextAt(rule, "country"); Get<ComboBox>("RuleCountryBox").Text = country.Length > 0 ? country : "全部国家"; Get<ComboBox>("RuleShopBox").Text = ReportData.TextAt(rule, "shop");
            Get<TextBox>("RuleThresholdBox").Text = ReportData.TextAt(rule, "threshold"); Get<TextBox>("RuleCooldownBox").Text = ReportData.TextAt(rule, "cooldownMinutes"); Get<CheckBox>("RuleEnabledBox").IsChecked = ReportData.Value(rule, "enabled") is bool && (bool)ReportData.Value(rule, "enabled");
        }
        private void SaveMonitoring(bool saveRule, bool deleteRule)
        {
            if (monitorState == null) { SetText("MonitorNotice", "请先等待设置读取完成。"); RefreshMonitor(); return; }
            var config = CopyObject(ReportData.Value(monitorState, "config")); config["enabled"] = Get<CheckBox>("MonitorEnabledBox").IsChecked == true; config["inventoryIntervalMinutes"] = Integer("InventoryIntervalBox");
            config["mail"] = new { enabled = Get<CheckBox>("MailEnabledBox").IsChecked == true, intervalMinutes = Integer("MailIntervalBox"), repeatMinutes = Integer("MailRepeatBox") };
            var rules = ReportData.Items(ReportData.Value(config, "inventoryRules")).ToList();
            if (deleteRule) { var row = Get<DataGrid>("InventoryRulesGrid").SelectedItem as InventoryRuleRow; if (row == null) return; rules.RemoveAll(r => ReportData.TextAt(r, "id") == ReportData.TextAt(row.Raw, "id")); }
            if (saveRule) {
                string id = editRuleId ?? Guid.NewGuid().ToString(); rules.RemoveAll(r => ReportData.TextAt(r, "id") == id);
                rules.Add(new { id, name = Text("RuleNameBox"), enabled = Get<CheckBox>("RuleEnabledBox").IsChecked == true, type = typeValues[Math.Max(0, Get<ComboBox>("RuleTypeBox").SelectedIndex)], value = Text("RuleValueBox"), country = Country("RuleCountryBox"), shop = Get<ComboBox>("RuleShopBox").Text.Trim(), threshold = Integer("RuleThresholdBox"), cooldownMinutes = Integer("RuleCooldownBox") }); editRuleId = id;
            }
            config["inventoryRules"] = rules; MonitorAction(new { action = "save", config });
        }
        private async void RefreshMonitor()
        {
            if (monitorRefreshing || monitoringBusy) return; monitorRefreshing = true; int revision = monitorRevision;
            try { object state = await Task.Run(() => FeatureCall("monitoring", new { action = "snapshot" })); if (revision == monitorRevision && !monitoringBusy) ApplyMonitorState(state, monitorState == null); }
            catch (Exception error) { SetText("MonitorNotice", error.Message); } finally { monitorRefreshing = false; }
        }
        private async void MonitorAction(object request)
        {
            if (monitoringBusy) return; monitoringBusy = true; monitorRevision++;
            Exception failure = null;
            Get<DataGrid>("InventoryRulesGrid").IsEnabled = false; Get<Button>("RuleNewButton").IsEnabled = false;
            foreach (string name in new[] { "MonitorSaveButton", "MonitorCheckButton", "RuleSaveButton", "RuleDeleteButton" }) Get<Button>(name).IsEnabled = false;
            try {
                SetText("MonitorNotice", "正在处理…"); object state = await Task.Run(() => FeatureCall("monitoring", request)); ApplyMonitorState(state, true);
                SetText("MonitorNotice", "操作完成。监控错误与提醒见下方状态。");
            } catch (Exception error) { failure = error; SetText("MonitorNotice", error.Message); } finally { monitoringBusy = false; Get<DataGrid>("InventoryRulesGrid").IsEnabled = true; Get<Button>("RuleNewButton").IsEnabled = true; foreach (string name in new[] { "MonitorSaveButton", "MonitorCheckButton", "RuleSaveButton", "RuleDeleteButton" }) Get<Button>(name).IsEnabled = true; }
            if (failure != null) { try { object restored = await Task.Run(() => FeatureCall("monitoring", new { action = "snapshot" })); ApplyMonitorState(restored, true); } catch { } }
        }
        private void ApplyMonitorState(object state, bool fillSettings)
        {
            monitorState = state; object config = ReportData.Value(state, "config");
            if (fillSettings) {
                Get<CheckBox>("MonitorEnabledBox").IsChecked = ReportData.Value(config, "enabled") is bool && (bool)ReportData.Value(config, "enabled");
                Get<CheckBox>("MailEnabledBox").IsChecked = ReportData.Value(config, "mail", "enabled") is bool && (bool)ReportData.Value(config, "mail", "enabled");
                Get<TextBox>("InventoryIntervalBox").Text = ReportData.TextAt(config, "inventoryIntervalMinutes"); Get<TextBox>("MailIntervalBox").Text = ReportData.TextAt(config, "mail", "intervalMinutes"); Get<TextBox>("MailRepeatBox").Text = ReportData.TextAt(config, "mail", "repeatMinutes");
            }
            var selected = Get<DataGrid>("InventoryRulesGrid").SelectedItem as InventoryRuleRow; string selectedId = selected == null ? editRuleId : ReportData.TextAt(selected.Raw, "id");
            var rules = ReportData.Items(ReportData.Value(config, "inventoryRules")).Select(r => new InventoryRuleRow(r)).ToList();
            if (ReportData.Serializer().Serialize(Get<DataGrid>("InventoryRulesGrid").Items.Cast<InventoryRuleRow>().Select(r => r.Raw)) != ReportData.Serializer().Serialize(rules.Select(r => r.Raw))) { Get<DataGrid>("InventoryRulesGrid").ItemsSource = rules; Get<DataGrid>("InventoryRulesGrid").SelectedItem = rules.FirstOrDefault(r => ReportData.TextAt(r.Raw, "id") == selectedId); }
            var reminder = Get<DataGrid>("ReminderGrid").SelectedItem as ReminderRow;
            var events = ReportData.Items(ReportData.Value(state, "events")).Select(e => new ReminderRow(e)).ToList();
            Get<DataGrid>("ReminderGrid").ItemsSource = events;
            Get<DataGrid>("ReminderGrid").SelectedItem = events.FirstOrDefault(e => reminder != null && ReportData.TextAt(e.Raw, "id") == ReportData.TextAt(reminder.Raw, "id"));
            string errors = string.Join("；", ReportData.Items(ReportData.Value(state, "errors")).Select(e => ReportData.TextAt(e, "message")));
            SetText("MonitorStatusText", (ReportData.Value(config, "enabled") is bool && (bool)ReportData.Value(config, "enabled") ? "后台监控已启用" : "后台监控已暂停") + " · 库存检查 " + AutomationTime(ReportData.TextAt(state, "lastCheck", "inventory")) + " · 站内信检查 " + AutomationTime(ReportData.TextAt(state, "lastCheck", "mail")) + (errors.Length > 0 ? "\n" + errors : ""));
        }
        private void ReminderAction(string action) { var row = Get<DataGrid>("ReminderGrid").SelectedItem as ReminderRow; if (row != null) MonitorAction(new { action, ids = new[] { ReportData.TextAt(row.Raw, "id") }, minutes = 60 }); }
        private async Task FeatureSmokeCheck()
        {
            Get<RadioButton>("NavAutomation").IsChecked = true; await WaitAutomationIdle();
            NewAutomationTask();
            Get<TextBox>("AutoGroupBox").Text = "示例任务组"; Get<TextBox>("AutoValueBox").Text = "示例商品";
            Get<TextBox>("AutoNameBox").Text = "示例任务"; Get<CheckBox>("AutoEnabledBox").IsChecked = false;
            Get<TextBox>("BatchValuesBox").Text = "SAMPLE-A\nSAMPLE-B";
            Get<TextBox>("BatchCountriesBox").Text = "德国\n加拿大";
            var request = CopyObject(BuildBatchPacket()); request["action"] = "batch-preview";
            object batch = await Task.Run(() => FeatureCall("automation", request));
            Require(Convert.ToInt32(ReportData.Value(batch, "count")) == 4, "批量商品与国家组合预览失败。");
            ApplyAutomationState(CopyObject(new { enabled = false, running = 0, tasks = ReportData.Items(ReportData.Value(batch, "tasks")).ToArray(), runs = new object[0] }));
            Get<ComboBox>("AutoGroupFilter").SelectedItem = Get<TextBox>("BatchGroupBox").Text;
            Require(Get<DataGrid>("AutoTasksGrid").Items.Count == 4, "任务组筛选失败。");
            Get<DataGrid>("AutoTasksGrid").SelectedIndex = 0;
            Get<Button>("AutoCloneButton").RaiseEvent(new RoutedEventArgs(System.Windows.Controls.Primitives.ButtonBase.ClickEvent));
            Require(automationEditId == null && Get<TextBox>("AutoNameBox").Text.EndsWith("副本"), "任务复制没有生成独立编辑状态。");
            string isolatedResults = Path.Combine(automationDataRoot, "results"); Directory.CreateDirectory(isolatedResults);
            foreach (string file in Directory.GetFiles(Path.Combine(root, "examples"), "*.json")) File.Copy(file, Path.Combine(isolatedResults, Path.GetFileName(file)), true);
            object listing = await Task.Run(() => FeatureCall("data", new { action = "history" }));
            string name = ReportData.TextAt(ReportData.Items(ReportData.Value(listing, "items")).First(), "name");
            object exported = await Task.Run(() => FeatureCall("data", new { action = "export", name, format = "xlsx" }));
            string exportPath = ReportData.TextAt(exported, "path");
            Require(File.Exists(exportPath) && File.ReadAllBytes(exportPath).Take(2).SequenceEqual(new byte[] { 80, 75 }), "Excel 导出未生成有效工作簿。");
            SetComparisonChoices(ReportData.History(isolatedResults));
            Require(Get<ComboBox>("CompareLeftBox").Items.Count > 0, "跨期比较候选结果未加载。");
            Get<RadioButton>("NavMonitor").IsChecked = true;
            object state = await Task.Run(() => FeatureCall("monitoring", new { action = "snapshot" })); ApplyMonitorState(state, true);
            Require(Get<UIElement>("MonitorPage").Visibility == Visibility.Visible && Get<CheckBox>("MonitorEnabledBox").IsChecked == false, "监控页面或默认暂停状态错误。");
            Require(Get<ComboBox>("ShopBox").IsEditable && Get<ComboBox>("AutoShopBox").IsEditable, "授权店铺候选不可选择。");
            SettingsSmokeCheck();
            ShowPage(initialPage); Window.UpdateLayout();
        }
    }
    internal sealed class InventoryRuleRow
    {
        internal readonly object Raw; public string Name { get; private set; } public string Scope { get; private set; } public string Threshold { get; private set; } public string Enabled { get; private set; }
        internal InventoryRuleRow(object raw) { Raw = raw; Name = ReportData.TextAt(raw, "name"); Scope = ReportData.TextAt(raw, "type") + " · " + ReportData.TextAt(raw, "value") + " · " + ReportData.TextAt(raw, "country") + " · " + ReportData.TextAt(raw, "shop"); Threshold = ReportData.TextAt(raw, "threshold"); Enabled = ReportData.Value(raw, "enabled") is bool && (bool)ReportData.Value(raw, "enabled") ? "启用" : "停用"; }
    }
    internal sealed class ReminderRow
    {
        internal readonly object Raw; public string Kind { get; private set; } public string Title { get; private set; } public string Message { get; private set; } public string State { get; private set; } public string Updated { get; private set; }
        internal ReminderRow(object raw) { Raw = raw; string kind = ReportData.TextAt(raw, "kind"); Kind = kind == "inventory" ? "库存" : kind == "mail" ? "站内信" : "异常"; Title = ReportData.TextAt(raw, "title"); Message = ReportData.TextAt(raw, "message"); State = ReportData.TextAt(raw, "state") == "resolved" ? "已恢复" : ReportData.Value(raw, "unread") is bool && (bool)ReportData.Value(raw, "unread") ? "待查看" : "已查看"; Updated = NativeWindow.AutomationTime(ReportData.TextAt(raw, "updatedAt")); }
    }
    internal sealed class FeatureDataRow { public string Label { get; set; } public string Scope { get; set; } public string Currency { get; set; } public string Metric { get; set; } public string Left { get; set; } public string Right { get; set; } public string Delta { get; set; } }
}
