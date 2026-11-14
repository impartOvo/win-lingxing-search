using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Threading;

namespace ProductDiagnosis
{
    internal sealed partial class NativeWindow
    {
        private DispatcherTimer automationTimer;
        private bool automationBusy, automationUpdating, scheduleEnabled;
        private bool automationRefreshing;
        private int automationRevision;
        private string automationTasksJson, automationRunsJson;
        private string automationEditId;
        private string automationDataRoot;
        private readonly Dictionary<string, string> automationPeriods = new Dictionary<string, string> {
            {"today", "今天"}, {"yesterday", "昨天"}, {"recent7", "近 7 天（含今天）"}, {"prev7", "前 7 天（截至昨天）"},
            {"thisWeek", "本周（周一至今天）"}, {"lastWeek", "上周（周一至周日）"},
            {"recent30", "近 30 天（含今天）"}, {"prev30", "前 30 天（截至昨天）"},
            {"thisMonth", "本月（1 日至今天）"}, {"lastMonth", "上月（完整自然月）"}, {"custom", "固定日期区间"}
        };
        private void InitializeAutomation()
        {
            automationDataRoot = options.SmokeTest ? Path.Combine(root, ".private", "desktop-tests", "automation-" + Guid.NewGuid().ToString("N")) : root;
            Get<ComboBox>("AutoTypeBox").ItemsSource = typeLabels;
            Get<ComboBox>("AutoMatchBox").ItemsSource = new[] { "模糊", "精确" };
            Get<ComboBox>("AutoCountryBox").ItemsSource = new[] { "全部国家" }.Concat(CountryOptions()).ToArray();
            Get<ComboBox>("AutoPeriodBox").ItemsSource = automationPeriods;
            NewAutomationTask();
            automationTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(4) };
            automationTimer.Tick += delegate { if (Get<UIElement>("AutomationPage").Visibility == Visibility.Visible) RefreshAutomation(); };
            automationTimer.Start();
        }
        private void WireAutomationEvents()
        {
            Click("AutoRefreshButton", RefreshAutomation);
            Click("AutoNewButton", () => { NewAutomationTask(); Get<FrameworkElement>("AutoEditorCard").BringIntoView(); });
            Click("AutoSaveButton", () => AutomationAction(new { action = "save-task", task = AutomationEditorTask() }));
            Click("AutoScheduleButton", () => AutomationAction(new { action = "schedule", enabled = !scheduleEnabled }));
            Click("AutoRunAllButton", () => AutomationAction(new { action = "run" }));
            Click("AutoRunButton", () => { var selected = SelectedAutomationTask(); if (selected != null) AutomationAction(new { action = "run", ids = new[] { selected.Id } }); });
            Click("AutoDeleteButton", () => { var selected = SelectedAutomationTask(); if (selected != null) { AutomationAction(new { action = "delete-task", id = selected.Id }); NewAutomationTask(); } });
            Click("AutoUseCurrentButton", () => {
                Get<ComboBox>("AutoTypeBox").SelectedIndex = Get<ComboBox>("TypeBox").SelectedIndex;
                Get<ComboBox>("AutoMatchBox").SelectedIndex = Get<ComboBox>("MatchBox").SelectedIndex;
                Get<TextBox>("AutoValueBox").Text = Get<TextBox>("ValueBox").Text;
                Get<ComboBox>("AutoCountryBox").Text = Get<ComboBox>("CountryBox").Text;
                Get<TextBox>("AutoShopBox").Text = Get<TextBox>("ShopBox").Text;
                if (Get<DatePicker>("FromPicker").SelectedDate.HasValue && Get<DatePicker>("ToPicker").SelectedDate.HasValue) {
                    Get<ComboBox>("AutoPeriodBox").SelectedValue = "custom";
                    Get<DatePicker>("AutoFromPicker").SelectedDate = Get<DatePicker>("FromPicker").SelectedDate;
                    Get<DatePicker>("AutoToPicker").SelectedDate = Get<DatePicker>("ToPicker").SelectedDate;
                }
            });
            Get<ComboBox>("AutoPeriodBox").SelectionChanged += delegate { Get<UIElement>("AutoFixedDates").Visibility = (string)Get<ComboBox>("AutoPeriodBox").SelectedValue == "custom" ? Visibility.Visible : Visibility.Collapsed; };
            Get<DataGrid>("AutoTasksGrid").SelectionChanged += delegate { if (!automationUpdating) { var row = SelectedAutomationTask(); if (row != null) { FillAutomationTask(row.Raw); Get<FrameworkElement>("AutoEditorCard").BringIntoView(); } } };
            Click("AutoViewResultButton", () => {
                var row = Get<DataGrid>("AutoRunsGrid").SelectedItem as AutomationRunRow;
                if (row == null || row.State != "成功" || string.IsNullOrEmpty(row.ResultName)) { SetText("AutoNotice", "请选择一条成功的运行记录。"); return; }
                if (Path.GetFileName(row.ResultName) != row.ResultName) throw new InvalidDataException("结果文件名无效。");
                OpenCollection(Path.Combine(resultsDirectory, row.ResultName), true); ShowPage("results");
            });
            Click("AutoViewLogButton", () => {
                var row = Get<DataGrid>("AutoRunsGrid").SelectedItem as AutomationRunRow;
                if (row == null) return;
                string file = Path.Combine(root, ".private", "automation", "logs", row.Id + ".log");
                if (File.Exists(file)) ShellOpen(file);
            });
        }
        private AutomationTaskRow SelectedAutomationTask() { return Get<DataGrid>("AutoTasksGrid").SelectedItem as AutomationTaskRow; }
        private void NewAutomationTask()
        {
            automationEditId = null;
            Get<DataGrid>("AutoTasksGrid").SelectedIndex = -1;
            SetText("AutoEditorHeading", "新建任务");
            foreach (string name in new[] { "AutoNameBox", "AutoValueBox", "AutoShopBox" }) Get<TextBox>(name).Clear();
            Get<TextBox>("AutoTimeBox").Text = "09:00";
            Get<ComboBox>("AutoTypeBox").SelectedIndex = 0; Get<ComboBox>("AutoMatchBox").SelectedIndex = 0;
            Get<ComboBox>("AutoCountryBox").SelectedIndex = 0;
            Get<ComboBox>("AutoPeriodBox").SelectedValue = "prev30";
            Get<DatePicker>("AutoFromPicker").SelectedDate = null; Get<DatePicker>("AutoToPicker").SelectedDate = null;
            Get<CheckBox>("AutoEnabledBox").IsChecked = true;
            for (int day = 0; day < 7; day++) Get<CheckBox>("AutoDay" + day).IsChecked = day != 0;
        }
        private object AutomationEditorTask()
        {
            if (automationEditId == null) automationEditId = Guid.NewGuid().ToString();
            string country = Get<ComboBox>("AutoCountryBox").Text.Trim();
            return new {
                id = automationEditId, name = Get<TextBox>("AutoNameBox").Text.Trim(), enabled = Get<CheckBox>("AutoEnabledBox").IsChecked == true,
                type = typeValues[Math.Max(0, Get<ComboBox>("AutoTypeBox").SelectedIndex)], value = Get<TextBox>("AutoValueBox").Text,
                match = Get<ComboBox>("AutoMatchBox").SelectedIndex == 1 ? "exact" : "fuzzy", country = country == "全部国家" ? "" : country,
                shop = Get<TextBox>("AutoShopBox").Text, period = Get<ComboBox>("AutoPeriodBox").SelectedValue,
                from = DateString("AutoFromPicker"), to = DateString("AutoToPicker"), time = Get<TextBox>("AutoTimeBox").Text.Trim(),
                days = Enumerable.Range(0, 7).Where(day => Get<CheckBox>("AutoDay" + day).IsChecked == true).ToArray()
            };
        }
        private string DateString(string name) { var value = Get<DatePicker>(name).SelectedDate; return value.HasValue ? value.Value.ToString("yyyy-MM-dd") : ""; }
        private void FillAutomationTask(object task)
        {
            automationEditId = ReportData.TextAt(task, "id"); SetText("AutoEditorHeading", "编辑任务");
            Get<TextBox>("AutoNameBox").Text = ReportData.TextAt(task, "name");
            Get<TextBox>("AutoValueBox").Text = ReportData.TextAt(task, "value");
            Get<TextBox>("AutoShopBox").Text = ReportData.TextAt(task, "shop");
            Get<TextBox>("AutoTimeBox").Text = ReportData.TextAt(task, "time");
            string type = ReportData.TextAt(task, "type");
            Get<ComboBox>("AutoTypeBox").SelectedIndex = Array.FindIndex(typeLabels, t => t.Replace(" ", "") == type.Replace(" ", ""));
            Get<ComboBox>("AutoMatchBox").SelectedIndex = ReportData.TextAt(task, "match") == "精确" ? 1 : 0;
            string country = ReportData.TextAt(task, "country"); Get<ComboBox>("AutoCountryBox").Text = country.Length > 0 ? country : "全部国家";
            Get<ComboBox>("AutoPeriodBox").SelectedValue = ReportData.TextAt(task, "period");
            Get<CheckBox>("AutoEnabledBox").IsChecked = ReportData.Value(task, "enabled") is bool && (bool)ReportData.Value(task, "enabled");
            int[] days = ReportData.Items(ReportData.Value(task, "days")).Select(Convert.ToInt32).ToArray();
            for (int day = 0; day < 7; day++) Get<CheckBox>("AutoDay" + day).IsChecked = days.Contains(day);
            foreach (var pair in new[] { new[] { "AutoFromPicker", "from" }, new[] { "AutoToPicker", "to" } }) {
                DateTime date; Get<DatePicker>(pair[0]).SelectedDate = DateTime.TryParseExact(ReportData.TextAt(task, pair[1]), "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out date) ? date : (DateTime?)null;
            }
        }
        private object CallAutomation(object request)
        {
            var info = NodeStartInfo(root, new[] { Path.Combine(root, "automation", "cli.cjs"), "--data", automationDataRoot });
            info.RedirectStandardInput = true;
            using (var process = new Process { StartInfo = info }) {
                process.Start(); var output = process.StandardOutput.ReadToEndAsync(); var error = process.StandardError.ReadToEndAsync();
                using (var input = new StreamWriter(process.StandardInput.BaseStream, new UTF8Encoding(false)))
                    input.Write(ReportData.Serializer().Serialize(request));
                if (!process.WaitForExit(35000)) { process.Kill(); throw new TimeoutException("自动化操作超时，请重试。"); }
                if (process.ExitCode != 0) throw new InvalidOperationException(error.Result.Trim());
                return ReportData.Serializer().DeserializeObject(output.Result);
            }
        }
        private async void RefreshAutomation()
        {
            if (automationRefreshing || automationBusy) return;
            automationRefreshing = true;
            int revision = automationRevision;
            try {
                object state = await Task.Run(() => CallAutomation(new { action = "snapshot" }));
                if (revision == automationRevision && !automationBusy) ApplyAutomationState(state);
            } catch (Exception error) { if (revision == automationRevision && !automationBusy) SetText("AutoNotice", error.Message); }
            finally { automationRefreshing = false; }
        }
        private async void AutomationAction(object request)
        {
            if (automationBusy) return;
            automationBusy = true;
            automationRevision++;
            foreach (string name in new[] { "AutoSaveButton", "AutoScheduleButton", "AutoRunButton", "AutoRunAllButton", "AutoDeleteButton" }) Get<Button>(name).IsEnabled = false;
            try {
                object state = await Task.Run(() => CallAutomation(request));
                ApplyAutomationState(state);
                SetText("AutoNotice", "操作完成。任务按已保存的条件执行，可在下方查看运行记录。");
            } catch (Exception error) { SetText("AutoNotice", error.Message); }
            finally {
                automationBusy = false;
                foreach (string name in new[] { "AutoSaveButton", "AutoScheduleButton", "AutoRunButton", "AutoRunAllButton", "AutoDeleteButton" }) Get<Button>(name).IsEnabled = true;
            }
        }
        private async Task WaitAutomationIdle()
        {
            DateTime deadline = DateTime.UtcNow.AddSeconds(15);
            while (automationBusy || automationRefreshing) { if (DateTime.UtcNow > deadline) throw new TimeoutException("自动化界面响应超时。"); await Task.Delay(50); }
        }
        private async Task AutomationSmokeCheck()
        {
            Get<RadioButton>("NavAutomation").IsChecked = true;
            await WaitAutomationIdle();
            NewAutomationTask();
            Get<TextBox>("AutoNameBox").Text = "示例定时任务·中文①";
            Get<ComboBox>("AutoTypeBox").SelectedIndex = Array.IndexOf(typeValues, "name");
            Get<ComboBox>("AutoMatchBox").SelectedIndex = 1;
            Get<TextBox>("AutoValueBox").Text = "中文示例商品";
            Get<ComboBox>("AutoCountryBox").Text = "德国";
            Get<TextBox>("AutoShopBox").Text = "示例 中文店铺";
            Get<ComboBox>("AutoPeriodBox").SelectedValue = "yesterday";
            Get<CheckBox>("AutoEnabledBox").IsChecked = false;
            Get<Button>("AutoSaveButton").RaiseEvent(new RoutedEventArgs(System.Windows.Controls.Primitives.ButtonBase.ClickEvent));
            await WaitAutomationIdle();
            Require(Get<DataGrid>("AutoTasksGrid").Items.Count == 1, "自动化任务保存失败：" + Get<TextBlock>("AutoNotice").Text);
            var saved = ((AutomationTaskRow)Get<DataGrid>("AutoTasksGrid").Items[0]).Raw;
            Require(ReportData.TextAt(saved, "country") == "德国" && ReportData.TextAt(saved, "name") == "示例定时任务·中文①" && ReportData.TextAt(saved, "value") == "中文示例商品" && ReportData.TextAt(saved, "shop") == "示例 中文店铺", "中文任务内容未按 UTF-8 完整保存。");
            Require(ReportData.TextAt(saved, "type") == "品名" && ReportData.TextAt(saved, "match") == "精确", "任务类型或搜索方式保存错误。");
            Get<DataGrid>("AutoTasksGrid").SelectedIndex = 0;
            Require(Get<TextBox>("AutoValueBox").Text == "中文示例商品" && Get<ComboBox>("AutoCountryBox").Text == "德国" && Get<ComboBox>("AutoTypeBox").SelectedIndex == Array.IndexOf(typeValues, "name"), "自动化任务中文条件回填失败。");
            var periodBox = Get<ComboBox>("AutoPeriodBox");
            periodBox.ApplyTemplate(); Window.UpdateLayout();
            var periodPresenter = (ContentPresenter)periodBox.Template.FindName("SelectionPresenter", periodBox);
            Require(AutomationVisualTexts(periodPresenter).Any(text => text.Text == "昨天"), "日期选项未显示中文名称。");
            Get<TextBox>("AutoTimeBox").Text = "18:30";
            Get<ComboBox>("AutoCountryBox").Text = "英国";
            Get<Button>("AutoSaveButton").RaiseEvent(new RoutedEventArgs(System.Windows.Controls.Primitives.ButtonBase.ClickEvent));
            await WaitAutomationIdle();
            Require(Get<DataGrid>("AutoTasksGrid").Items.Count == 1 && ((AutomationTaskRow)Get<DataGrid>("AutoTasksGrid").Items[0]).Schedule.Contains("18:30"), "自动化任务修改失败。");
            Require(ReportData.TextAt(((AutomationTaskRow)Get<DataGrid>("AutoTasksGrid").Items[0]).Raw, "country") == "英国", "编辑后的中文国家未完整保存。");
            var taskSource = Get<DataGrid>("AutoTasksGrid").ItemsSource;
            var runSource = Get<DataGrid>("AutoRunsGrid").ItemsSource;
            var buttons = new[] { "AutoSaveButton", "AutoScheduleButton", "AutoRunButton", "AutoRunAllButton", "AutoDeleteButton" }.Select(Get<Button>).ToArray();
            int enabledChanges = 0;
            DependencyPropertyChangedEventHandler enabledChanged = delegate { enabledChanges++; };
            foreach (var button in buttons) button.IsEnabledChanged += enabledChanged;
            try {
                Get<TextBox>("AutoValueBox").Text = "尚未保存的中文编辑";
                RefreshAutomation();
                Require(buttons.All(button => button.IsEnabled), "后台刷新临时禁用了操作按钮。");
                await WaitAutomationIdle();
                Require(enabledChanges == 0 && object.ReferenceEquals(taskSource, Get<DataGrid>("AutoTasksGrid").ItemsSource) && object.ReferenceEquals(runSource, Get<DataGrid>("AutoRunsGrid").ItemsSource), "未变化的后台刷新重建了界面或切换了按钮状态。");
                Require(Get<TextBox>("AutoValueBox").Text == "尚未保存的中文编辑", "后台刷新覆盖了正在编辑的内容。");
            } finally { foreach (var button in buttons) button.IsEnabledChanged -= enabledChanged; }
            RefreshAutomation();
            Get<Button>("AutoSaveButton").RaiseEvent(new RoutedEventArgs(System.Windows.Controls.Primitives.ButtonBase.ClickEvent));
            Require(automationBusy, "后台刷新期间忽略了用户保存操作。");
            await WaitAutomationIdle();
            Require(ReportData.TextAt(((AutomationTaskRow)Get<DataGrid>("AutoTasksGrid").Items[0]).Raw, "value") == "尚未保存的中文编辑", "刷新与保存交错时丢失了编辑内容。");
            Get<DataGrid>("AutoTasksGrid").SelectedIndex = 0;
            Get<Button>("AutoDeleteButton").RaiseEvent(new RoutedEventArgs(System.Windows.Controls.Primitives.ButtonBase.ClickEvent));
            await WaitAutomationIdle();
            Require(Get<DataGrid>("AutoTasksGrid").Items.Count == 0, "自动化任务删除失败。");
            ShowPage(initialPage); Window.UpdateLayout();
        }
        private static IEnumerable<TextBlock> AutomationVisualTexts(DependencyObject node)
        {
            var text = node as TextBlock; if (text != null) yield return text;
            for (int index = 0; index < System.Windows.Media.VisualTreeHelper.GetChildrenCount(node); index++)
                foreach (var child in AutomationVisualTexts(System.Windows.Media.VisualTreeHelper.GetChild(node, index))) yield return child;
        }
        private void ApplyAutomationState(object state)
        {
            scheduleEnabled = (bool)ReportData.Value(state, "enabled");
            SetText("AutoStatusText", (scheduleEnabled ? "定时运行已启用" : "定时已暂停") + " · 当前运行 " + ReportData.TextAt(state, "running") + " 项");
            Get<Button>("AutoScheduleButton").Content = scheduleEnabled ? "暂停定时运行" : "启用定时运行";
            string tasksJson = ReportData.Serializer().Serialize(ReportData.Value(state, "tasks"));
            string runsJson = ReportData.Serializer().Serialize(ReportData.Value(state, "runs"));
            automationUpdating = true;
            try {
                if (automationTasksJson != tasksJson) {
                    var selected = SelectedAutomationTask(); string taskId = selected == null ? null : selected.Id;
                    var rows = ReportData.Items(ReportData.Value(state, "tasks")).Select(t => new AutomationTaskRow(t)).ToList();
                    Get<DataGrid>("AutoTasksGrid").ItemsSource = rows;
                    Get<DataGrid>("AutoTasksGrid").SelectedItem = rows.FirstOrDefault(t => t.Id == taskId);
                    automationTasksJson = tasksJson;
                }
                if (automationRunsJson != runsJson) {
                    var oldRun = Get<DataGrid>("AutoRunsGrid").SelectedItem as AutomationRunRow;
                    var runs = ReportData.Items(ReportData.Value(state, "runs")).Select(r => new AutomationRunRow(r)).ToList();
                    Get<DataGrid>("AutoRunsGrid").ItemsSource = runs;
                    Get<DataGrid>("AutoRunsGrid").SelectedItem = runs.FirstOrDefault(r => oldRun != null && r.Id == oldRun.Id);
                    automationRunsJson = runsJson;
                }
            } finally { automationUpdating = false; }
        }
        internal static string AutomationStateLabel(string state) { switch (state) { case "starting": return "启动中"; case "running": return "运行中"; case "ok": return "成功"; case "error": return "失败"; default: return "尚未运行"; } }
        internal static string AutomationTime(string value) { DateTimeOffset date; return DateTimeOffset.TryParse(value, out date) ? date.ToLocalTime().ToString("MM-dd HH:mm:ss") : "—"; }
    }
    internal sealed class AutomationTaskRow
    {
        internal readonly object Raw;
        public string Id { get; private set; } public string Name { get; private set; } public string Enabled { get; private set; }
        public string Scope { get; private set; } public string Period { get; private set; } public string Schedule { get; private set; } public string Next { get; private set; } public string Last { get; private set; }
        internal AutomationTaskRow(object raw) {
            Raw = raw; Id = ReportData.TextAt(raw, "id"); Name = ReportData.TextAt(raw, "name"); Enabled = (bool)ReportData.Value(raw, "enabled") ? "启用" : "停用";
            Scope = ReportData.TextAt(raw, "value") + " · " + (ReportData.TextAt(raw, "country").Length > 0 ? ReportData.TextAt(raw, "country") : "全部国家") + " · " + ReportData.TextAt(raw, "shop");
            Period = ReportData.TextAt(raw, "periodLabel"); Schedule = ReportData.TextAt(raw, "scheduleLabel"); Next = NativeWindow.AutomationTime(ReportData.TextAt(raw, "nextAt")); Last = NativeWindow.AutomationStateLabel(ReportData.TextAt(raw, "latest", "status"));
        }
    }
    internal sealed class AutomationRunRow
    {
        public string Id { get; private set; } public string Name { get; private set; } public string State { get; private set; } public string Started { get; private set; } public string Dates { get; private set; } public string Message { get; private set; } public string ResultName { get; private set; }
        internal AutomationRunRow(object raw) {
            Id = ReportData.TextAt(raw, "id"); Name = ReportData.TextAt(raw, "taskName"); State = NativeWindow.AutomationStateLabel(ReportData.TextAt(raw, "status")); Started = NativeWindow.AutomationTime(ReportData.TextAt(raw, "createdAt"));
            Dates = ReportData.TextAt(raw, "dates", "from") + " — " + ReportData.TextAt(raw, "dates", "to");
            Message = ReportData.TextAt(raw, "error"); if (Message.Length == 0) Message = ReportData.TextAt(raw, "trigger") == "schedule" ? "定时触发" : "手动触发";
            ResultName = ReportData.TextAt(raw, "resultName");
        }
    }
}
