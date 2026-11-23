using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Windows;
using System.Windows.Controls;

namespace ProductDiagnosis
{
    internal sealed partial class NativeWindow
    {
        private bool updatingDates;
        private List<AutomationTaskRow> workbenchTasks = new List<AutomationTaskRow>();

        private void InitializeWorkbench()
        {
            Get<ComboBox>("CollectPeriodBox").ItemsSource = automationPeriods;
            Get<ComboBox>("CollectPeriodBox").SelectedValue = "prev30";
            SetText("AutoTimezoneText", "本机时区 · " + TimeZoneInfo.Local.DisplayName);
            UpdateQueryPreview();
        }

        private void WireWorkbenchEvents()
        {
            foreach (string name in new[] { "SourceBox", "CurrencyBox", "TypeBox", "MatchBox", "CountryBox" })
                Get<ComboBox>(name).SelectionChanged += delegate { Window.Dispatcher.BeginInvoke(new Action(UpdateQueryPreview)); };
            foreach (string name in new[] { "ValueBox" }) Get<TextBox>(name).TextChanged += delegate { UpdateQueryPreview(); };
            foreach (string name in new[] { "CountryBox", "CurrencyBox", "ShopBox" })
                Get<ComboBox>(name).AddHandler(TextBox.TextChangedEvent, new TextChangedEventHandler(delegate { UpdateQueryPreview(); }));
            Get<ComboBox>("CollectPeriodBox").SelectionChanged += delegate { if (!updatingDates) ApplyCollectPeriod(); };
            foreach (string name in new[] { "FromPicker", "ToPicker" }) Get<DatePicker>(name).SelectedDateChanged += delegate {
                if (!updatingDates) { Get<ComboBox>("CollectPeriodBox").SelectedValue = "custom"; UpdateQueryPreview(); }
            };
            Click("CollectScheduleButton", () => {
                ShowPage("automation"); NewAutomationTask();
                Get<Button>("AutoUseCurrentButton").RaiseEvent(new RoutedEventArgs(System.Windows.Controls.Primitives.ButtonBase.ClickEvent));
                string period = Get<ComboBox>("CollectPeriodBox").SelectedValue as string;
                if (period != null) Get<ComboBox>("AutoPeriodBox").SelectedValue = period;
                string product = Get<TextBox>("ValueBox").Text.Trim();
                Get<TextBox>("AutoNameBox").Text = product.Length > 0 ? product : "全店商品";
                RevealAutomationEditor();
            });
            Click("BrowserCollectButton", () => { Get<ComboBox>("SourceBox").SelectedIndex = 0; ShowPage("collect"); });
            Click("AutoEditButton", () => { var row = SelectedAutomationTask(); if (row != null) { FillAutomationTask(row.Raw); RevealAutomationEditor(); } });
            Click("AutoCloseEditorButton", () => Get<UIElement>("AutoEditorCard").Visibility = Visibility.Collapsed);
            Click("AutoDetailResultButton", () => {
                var task = SelectedAutomationTask(); if (task == null) return;
                string name = ReportData.TextAt(task.Raw, "latest", "resultName");
                if (ReportData.TextAt(task.Raw, "latest", "status") != "ok" || name.Length == 0 || Path.GetFileName(name) != name) return;
                OpenCollection(Path.Combine(resultsDirectory, name), true); ShowPage("results");
            });
            Click("AutoDetailLogButton", () => { var task = SelectedAutomationTask(); if (task != null) OpenAutomationLog(ReportData.TextAt(task.Raw, "latest", "id")); });
            foreach (string name in new[] { "AutoFilterAll", "AutoFilterEnabled", "AutoFilterPaused" }) Get<RadioButton>(name).Checked += delegate { RenderTaskFilter(); };
            Get<RadioButton>("ResultRecordsTab").Checked += delegate { ShowResultTab("records"); };
            Get<RadioButton>("ResultInfoTab").Checked += delegate { ShowResultTab("info"); };
            Get<RadioButton>("ResultJsonTab").Checked += delegate { ShowResultTab("json"); };
        }

        private void RevealAutomationEditor()
        {
            Get<UIElement>("AutoEditorCard").Visibility = Visibility.Visible;
            Get<FrameworkElement>("AutoEditorCard").BringIntoView();
            Get<TextBox>("AutoNameBox").Focus();
        }

        private void ApplyCollectPeriod()
        {
            string key = Get<ComboBox>("CollectPeriodBox").SelectedValue as string;
            if (key == null) return;
            updatingDates = true;
            try {
                if (key != "custom") {
                    DateTime today = DateTime.Today, from = today, to = today;
                    DateTime monday = today.AddDays(-(((int)today.DayOfWeek + 6) % 7));
                    DateTime month = new DateTime(today.Year, today.Month, 1);
                    switch (key) {
                        case "yesterday": from = to = today.AddDays(-1); break;
                        case "recent7": from = today.AddDays(-6); break;
                        case "prev7": from = today.AddDays(-7); to = today.AddDays(-1); break;
                        case "recent30": from = today.AddDays(-29); break;
                        case "prev30": from = today.AddDays(-30); to = today.AddDays(-1); break;
                        case "thisWeek": from = monday; break;
                        case "lastWeek": from = monday.AddDays(-7); to = monday.AddDays(-1); break;
                        case "thisMonth": from = month; break;
                        case "lastMonth": from = month.AddMonths(-1); to = month.AddDays(-1); break;
                    }
                    Get<DatePicker>("FromPicker").SelectedDate = from;
                    Get<DatePicker>("ToPicker").SelectedDate = to;
                }
            } finally { updatingDates = false; }
            SetText("CollectDateNote", key == "custom" ? "使用固定日期；定时任务会保留这个区间。" : (key == "prev7" || key == "prev30" ? "截至昨天，不包含今天。定时任务每次自动更新日期。" : "日期按本机时区计算；定时任务每次自动更新日期。"));
            UpdateQueryPreview();
        }

        private void UpdateQueryPreview()
        {
            string country = Get<ComboBox>("CountryBox").Text;
            string shop = Get<ComboBox>("ShopBox").Text.Trim();
            string product = Get<TextBox>("ValueBox").Text.Trim();
            SetText("QueryPreviewText", "商品  " + (product.Length > 0 ? product : shop.Length > 0 ? "全部商品" : "全部商品（请选店铺）") +
                "\n国家  " + (country.Length > 0 ? country : "全部国家") + "\n店铺  " + (shop.Length > 0 ? shop : "全部店铺") +
                "\n日期  " + DateString("FromPicker") + "\n       — " + DateString("ToPicker") +
                "\n通道  " + (SourceValue("SourceBox") == "mcp" ? "MCP" : "浏览器") + "\n输出  JSON");
            Get<ComboBox>("CurrencyBox").IsEnabled = SourceValue("SourceBox") == "mcp" && collector == null;
        }

        private void RenderTaskFilter()
        {
            var selected = SelectedAutomationTask();
            string id = selected == null ? automationEditId : selected.Id;
            string group = Get<ComboBox>("AutoGroupFilter").SelectedItem as string;
            var rows = workbenchTasks.Where(t => string.IsNullOrEmpty(group) || group == "全部任务组" || ReportData.TextAt(t.Raw, "group") == group).Where(t => Get<RadioButton>("AutoFilterAll").IsChecked == true ||
                (Get<RadioButton>("AutoFilterEnabled").IsChecked == true ? t.Enabled == "启用" : t.Enabled == "停用")).ToList();
            bool previous = automationUpdating; automationUpdating = true;
            try {
                Get<DataGrid>("AutoTasksGrid").ItemsSource = rows;
                Get<DataGrid>("AutoTasksGrid").SelectedItem = rows.FirstOrDefault(t => t.Id == id) ?? rows.FirstOrDefault();
            } finally { automationUpdating = previous; }
            SetText("AutoTaskCountText", rows.Count + " / " + workbenchTasks.Count + " 项任务 · 点击查看详情");
            UpdateTaskInspector();
        }

        private void UpdateTaskInspector()
        {
            var row = SelectedAutomationTask();
            Get<Button>("AutoDetailResultButton").IsEnabled = row != null && ReportData.TextAt(row.Raw, "latest", "status") == "ok";
            Get<Button>("AutoEditButton").IsEnabled = row != null;
            Get<Button>("AutoDetailLogButton").IsEnabled = row != null && ReportData.TextAt(row.Raw, "latest", "id").Length > 0;
            if (row == null) {
                SetText("AutoDetailName", "暂无所选任务"); SetText("AutoDetailState", "选择任务查看详情");
                foreach (string name in new[] { "AutoDetailScope", "AutoDetailMetadata", "AutoDetailRun", "AutoDetailError" }) SetText(name, "");
                return;
            }
            object task = row.Raw, run = ReportData.Value(task, "latest");
            string state = ReportData.TextAt(run, "status");
            SetText("AutoDetailName", row.Name);
            SetText("AutoDetailScope", ReportData.TextAt(task, "type") + " · " + ReportData.ProductFilterLabel(ReportData.TextAt(task, "value")) + "\n" + row.CompactScope);
            SetText("AutoDetailState", row.Enabled == "停用" ? "任务已停用 · 最近" + row.Last : row.Last);
            Get<TextBlock>("AutoDetailState").Foreground = Color(state == "error" ? "#ED9292" : state == "ok" ? "#70C9A4" : "#63D8E6");
            DateTimeOffset start, finish;
            string duration = DateTimeOffset.TryParse(ReportData.TextAt(run, "startedAt"), out start) && DateTimeOffset.TryParse(ReportData.TextAt(run, "finishedAt"), out finish) ?
                (finish - start).TotalSeconds.ToString("0.0", CultureInfo.InvariantCulture) + " 秒" : (state == "running" || state == "starting" ? "进行中" : "—");
            string next = row.Enabled == "停用" ? "任务已停用" : !scheduleEnabled ? "定时已暂停" : row.Next;
            SetText("AutoDetailMetadata", "数据日期  " + row.Period + "\n采集通道  " + row.Source + "\n最近耗时  " + duration + "\n下次运行  " + next);
            string dates = ReportData.TextAt(run, "dates", "from");
            SetText("AutoDetailRun", run == null ? "尚无运行记录。" : "开始  " + AutomationTime(ReportData.TextAt(run, "createdAt")) +
                (dates.Length > 0 ? "\n数据  " + dates + " — " + ReportData.TextAt(run, "dates", "to") : "") +
                "\n" + (state == "ok" ? "采集完成，结果已保存。" : state == "error" ? "采集失败，请查看下方原因。" : "后台采集中，可查看最近日志。"));
            SetText("AutoDetailError", ReportData.TextAt(run, "error"));
        }

        private void OpenAutomationLog(string id)
        {
            if (id.Length == 0 || Path.GetFileName(id) != id) return;
            string file = Path.Combine(automationDataRoot, ".private", "automation", "logs", id + ".log");
            Get<TextBox>("LogBox").Text = File.Exists(file) ? File.ReadAllText(file) : "这次运行尚无日志。";
            ShowPage("logs");
        }

        private void ShowResultTab(string tab)
        {
            Get<UIElement>("ResultScroll").Visibility = tab == "records" && current != null && current.Rows.Count > 0 ? Visibility.Visible : Visibility.Collapsed;
            Get<UIElement>("EmptyResults").Visibility = tab == "records" && (current == null || current.Rows.Count == 0) ? Visibility.Visible : Visibility.Collapsed;
            Get<UIElement>("ResultInfoBox").Visibility = tab == "info" ? Visibility.Visible : Visibility.Collapsed;
            Get<UIElement>("ResultJsonBox").Visibility = tab == "json" ? Visibility.Visible : Visibility.Collapsed;
            if (tab == "json") Get<TextBox>("ResultJsonBox").Text = current == null ? "还没有采集结果。" : File.ReadAllText(current.DataPath);
        }

        private void UpdateResultInformation()
        {
            object summary = current.Summary;
            string currency = ReportData.TextAt(summary, "input", "currency");
            if (currency.Length == 0 && current.Rows.Count > 0) currency = ReportData.TextAt(current.Rows[0].Raw, "currency_code");
            Get<TextBox>("ResultInfoBox").Text = "查询条件  " + ReportData.TextAt(summary, "input", "type") + " / " + ReportData.TextAt(summary, "input", "value") +
                "\n\n国家 / 店铺  " + ReportData.TextAt(summary, "input", "country") + " / " + ReportData.TextAt(summary, "input", "shop") +
                "\n\n数据日期  " + string.Join(" — ", ReportData.Items(ReportData.Value(summary, "dates")).Select(ReportData.Text)) +
                "\n\n采集时间  " + AutomationTime(ReportData.TextAt(summary, "fetchedAt")) +
                "\n\n采集通道  " + (ReportData.TextAt(summary, "method") == "mcp" ? "MCP" : "浏览器") + "\n\n统计币种  " + (currency.Length > 0 ? currency : "见记录字段") +
                "\n\n商品记录  " + current.Rows.Count + "\n\n结果文件  " + current.SummaryPath + "\n\n数据文件  " + current.DataPath;
            Get<RadioButton>("ResultRecordsTab").IsChecked = true; ShowResultTab("records");
        }
    }
}
