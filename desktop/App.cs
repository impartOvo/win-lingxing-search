using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Markup;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;

[assembly: AssemblyTitle("商品诊断")]
[assembly: AssemblyDescription("领星商品数据采集与查看")]
[assembly: AssemblyProduct("商品诊断")]
[assembly: System.Runtime.Versioning.TargetFramework(".NETFramework,Version=v4.8", FrameworkDisplayName = ".NET Framework 4.8")]

namespace ProductDiagnosis
{
    internal static class Program
    {
        internal static readonly string Root = AppDomain.CurrentDomain.BaseDirectory;

        [STAThread]
        private static int Main(string[] args)
        {
            var options = LaunchOptions.Parse(args);
            int exitCode = 0;
            string failure = null;
            NativeWindow desktop = null;
            try
            {
                if (options.SelfTest) NativeChecks.Run(Root);
                else
                {
                    var application = new Application { ShutdownMode = ShutdownMode.OnMainWindowClose };
                    desktop = new NativeWindow(Root, options);
                    application.DispatcherUnhandledException += delegate(object sender, DispatcherUnhandledExceptionEventArgs error) {
                        if (options.IsTest) { desktop.TestFailure = error.Exception.Message; application.Shutdown(1); }
                        else desktop.ShowError(error.Exception);
                        error.Handled = true;
                    };
                    application.Run(desktop.Window);
                    if (desktop.TestFailure != null) throw new InvalidOperationException(desktop.TestFailure);
                }
            }
            catch (Exception error)
            {
                failure = error.Message;
                exitCode = 1;
                if (!options.IsTest)
                {
                    try { Directory.CreateDirectory(Path.Combine(Root, ".private")); File.AppendAllText(Path.Combine(Root, ".private", "desktop-errors.log"), DateTime.Now.ToString("s") + " " + error + Environment.NewLine, Encoding.UTF8); } catch (IOException) { }
                    MessageBox.Show("商品诊断启动失败：" + failure, "商品诊断", MessageBoxButton.OK, MessageBoxImage.Error);
                }
            }
            finally { if (desktop != null) desktop.Dispose(); }
            if (options.IsTest)
            {
                string report = options.TestReport ?? Path.Combine(Root, ".private", "desktop-tests", "last-test.json");
                Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(report)));
                File.WriteAllText(report, ReportData.Serializer().Serialize(new {
                    status = exitCode == 0 ? "ok" : "error", error = failure,
                    mode = options.SelfTest ? "self-test" : (options.CollectOnce ? "collection" : "ui-smoke-test"),
                    result = desktop == null ? null : desktop.LastResultPath,
                    framework = Environment.Version.ToString(), finishedAt = DateTimeOffset.Now.ToString("o")
                }), new UTF8Encoding(false));
            }
            return exitCode;
        }
    }

    internal sealed class LaunchOptions
    {
        internal bool SelfTest, SmokeTest, CollectOnce;
        internal string Preview, TestReport, StartPage = "auto";
        internal bool IsTest { get { return SelfTest || SmokeTest || CollectOnce; } }
        internal static LaunchOptions Parse(string[] args)
        {
            var options = new LaunchOptions();
            for (int index = 0; index < args.Length; index++)
            {
                switch (args[index])
                {
                    case "--self-test": options.SelfTest = true; break;
                    case "--smoke-test": options.SmokeTest = true; break;
                    case "--collect-once": options.CollectOnce = true; break;
                    case "--preview": if (index + 1 < args.Length) options.Preview = args[++index]; break;
                    case "--test-report": if (index + 1 < args.Length) options.TestReport = args[++index]; break;
                    case "--start-page": if (index + 1 < args.Length) options.StartPage = args[++index]; break;
                }
            }
            return options;
        }
    }

    internal sealed partial class NativeWindow : IDisposable
    {
        internal readonly Window Window;
        internal string TestFailure, LastResultPath;
        private readonly string root, resultsDirectory;
        private readonly LaunchOptions options;
        private readonly DispatcherTimer runTimer;
        private CollectionBundle current;
        private List<HistoryRecord> history = new List<HistoryRecord>();
        private Process collector;
        private StreamWriter outputWriter, errorWriter;
        private volatile string capturedResultPath;
        private readonly object logLock = new object();
        private readonly string[] typeLabels = { "ASIN", "父 ASIN", "SKU", "MSKU", "FNSKU", "SPU", "品名" };
        private readonly string[] typeValues = { "asin", "parent_asin", "sku", "msku", "fnsku", "spu", "name" };
        private string initialPage;

        internal NativeWindow(string directory, LaunchOptions launch)
        {
            root = directory;
            resultsDirectory = Path.Combine(root, "results");
            options = launch;
            var assembly = Assembly.GetExecutingAssembly();
            using (Stream resource = assembly.GetManifestResourceStream("ProductDiagnosis.launcher.xaml"))
            {
                if (resource == null) throw new InvalidOperationException("应用界面资源缺失。");
                Window = (Window)XamlReader.Load(resource);
            }
            using (Stream icon = assembly.GetManifestResourceStream("ProductDiagnosis.app.ico"))
                if (icon != null) Window.Icon = BitmapFrame.Create(icon, BitmapCreateOptions.None, BitmapCacheOption.OnLoad);
            Window.Height = Math.Min(Window.Height, SystemParameters.WorkArea.Height - 20);
            Window.Width = Math.Min(Window.Width, SystemParameters.WorkArea.Width - 20);
            Window.MinHeight = Math.Min(Window.MinHeight, Window.Height);
            Window.MinWidth = Math.Min(Window.MinWidth, Window.Width);
            runTimer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(300) };
            runTimer.Tick += FinishCollection;
            InitializeControls();
            WireEvents();
            RefreshHistory();
            if (history.Count > 0)
            {
                try { OpenCollection(history[0].Path, true); }
                catch (Exception error) { AddLog("历史结果读取失败：" + error.Message); }
            }
            initialPage = launch.StartPage == "auto" ? (current == null ? "collect" : "results") : launch.StartPage;
            ShowPage(initialPage);
            Window.Loaded += OnLoaded;
        }

        private T Get<T>(string name) where T : class
        {
            T control = Window.FindName(name) as T;
            if (control == null) throw new InvalidOperationException("找不到界面控件：" + name);
            return control;
        }

        private void InitializeControls()
        {
            Get<ComboBox>("TypeBox").ItemsSource = typeLabels;
            Get<ComboBox>("TypeBox").SelectedIndex = 0;
            Get<ComboBox>("MatchBox").ItemsSource = new[] { "模糊", "精确" };
            Get<ComboBox>("MatchBox").SelectedIndex = 0;
            Get<ComboBox>("CountryBox").ItemsSource = new[] { "全部国家" }.Concat(CountryOptions()).ToArray();
            Get<ComboBox>("CountryBox").SelectedIndex = 0;
            SetDates(30);
            InitializeAutomation();
        }

        internal static string[] CountryOptions()
        {
            using (var resource = Assembly.GetExecutingAssembly().GetManifestResourceStream("ProductDiagnosis.countries.json"))
            using (var reader = new StreamReader(resource, Encoding.UTF8))
                return ReportData.Items(ReportData.Serializer().DeserializeObject(reader.ReadToEnd())).Select(ReportData.Text).ToArray();
        }

        private void Click(string name, Action action)
        {
            Get<Button>(name).Click += delegate { try { action(); } catch (Exception error) { ShowError(error); } };
        }

        private void WireEvents()
        {
            Get<RadioButton>("NavCollect").Checked += delegate { ShowPage("collect"); };
            Get<RadioButton>("NavResults").Checked += delegate { ShowPage("results"); };
            Get<RadioButton>("NavHistory").Checked += delegate { RefreshHistory(); ShowPage("history"); };
            Get<RadioButton>("NavLogs").Checked += delegate { ShowPage("logs"); };
            Get<RadioButton>("NavAutomation").Checked += delegate { ShowPage("automation"); RefreshAutomation(); };
            WireAutomationEvents();
            Get<ComboBox>("ResultRowBox").SelectionChanged += delegate { UpdateSelectedReport(); };
            Click("GoCollectButton", () => ShowPage("collect"));
            Click("ShowRunLogButton", () => ShowPage("logs"));
            Click("RunButton", StartCollection);
            Click("Last7Button", () => SetDates(7));
            Click("Last30Button", () => SetDates(30));
            Click("EditQueryButton", () => { if (current != null) FillInputs(current.Summary); ShowPage("collect"); });
            Click("ResetPageButton", ResetPage);
            Click("FolderButton", () => { Directory.CreateDirectory(resultsDirectory); ShellOpen(resultsDirectory); });
            Click("OpenJsonButton", () => { if (current != null) ShellOpen(current.DataPath); });
            Click("RefreshHistoryButton", RefreshHistory);
            Click("LoadHistoryButton", OpenHistorySelection);
            Get<DataGrid>("HistoryGrid").MouseDoubleClick += delegate { try { OpenHistorySelection(); } catch (Exception error) { ShowError(error); } };
            Click("ClearLogButton", () => Get<TextBox>("LogBox").Clear());
            Click("MinimizeButton", () => Window.WindowState = WindowState.Minimized);
            Click("MaximizeButton", () => Window.WindowState = Window.WindowState == WindowState.Maximized ? WindowState.Normal : WindowState.Maximized);
            Click("CloseButton", () => Window.Close());
            Window.Closing += delegate(object sender, System.ComponentModel.CancelEventArgs closing) {
                if (collector != null && !collector.HasExited) { closing.Cancel = true; Notice("采集正在进行，请等待结束后再关闭窗口。"); ShowPage("collect"); }
            };
        }

        private void ShellOpen(string path) { Process.Start(new ProcessStartInfo(path) { UseShellExecute = true }); }

        private void SetDates(int days)
        {
            Get<DatePicker>("FromPicker").SelectedDate = DateTime.Today.AddDays(-days);
            Get<DatePicker>("ToPicker").SelectedDate = DateTime.Today.AddDays(-1);
        }

        private void ResetPage()
        {
            if (collector != null) return;
            current = null;
            LastResultPath = null;
            Get<ComboBox>("TypeBox").SelectedIndex = 0;
            Get<ComboBox>("MatchBox").SelectedIndex = 0;
            Get<TextBox>("ValueBox").Clear();
            Get<ComboBox>("CountryBox").SelectedIndex = 0;
            Get<TextBox>("ShopBox").Clear();
            Get<DatePicker>("FromPicker").SelectedDate = null;
            Get<DatePicker>("ToPicker").SelectedDate = null;
            Get<ComboBox>("ResultRowBox").ItemsSource = null;
            Get<DataGrid>("VariantGrid").ItemsSource = null;
            Get<UIElement>("ResultScroll").Visibility = Visibility.Collapsed;
            Get<UIElement>("EmptyResults").Visibility = Visibility.Visible;
            SetText("EmptyResultsText", "还没有采集结果");
            Get<TextBox>("LogBox").Clear();
            Notice(""); Stage(0); Status("就绪"); ShowPage("collect");
        }

        private void SetText(string name, string text) { Get<TextBlock>(name).Text = text; }
        private static Brush Color(string color) { return (Brush)new BrushConverter().ConvertFromString(color); }
        private void Status(string text, string color = "#6B99FF") { SetText("StatusText", text); Get<System.Windows.Shapes.Ellipse>("StatusDot").Fill = Color(color); }
        private void Notice(string text) { SetText("FormNotice", text); Get<TextBlock>("FormNotice").Visibility = text.Length > 0 ? Visibility.Visible : Visibility.Collapsed; }
        private void AddLog(string text) { Get<TextBox>("LogBox").AppendText(text + Environment.NewLine); Get<TextBox>("LogBox").ScrollToEnd(); }
        internal void ShowError(Exception error) { Status("操作未完成", "#F3A38F"); AddLog(error.Message); ShowPage("logs"); }

        private void ShowPage(string page)
        {
            foreach (string name in new[] { "CollectPage", "ResultsPage", "HistoryPage", "LogsPage", "AutomationPage" }) Get<UIElement>(name).Visibility = Visibility.Collapsed;
            string panel, nav, heading, subtitle;
            switch (page)
            {
                case "results": panel = "ResultsPage"; nav = "NavResults"; heading = "采集结果"; subtitle = "查看所选商品在指定时间段内的表现"; break;
                case "history": panel = "HistoryPage"; nav = "NavHistory"; heading = "历史记录"; subtitle = "每条记录代表一次采集，可随时重新打开"; break;
                case "logs": panel = "LogsPage"; nav = "NavLogs"; heading = "运行日志"; subtitle = "查看本次采集进度与错误信息"; break;
                case "automation": panel = "AutomationPage"; nav = "NavAutomation"; heading = "自动化任务"; subtitle = "按星期和时间自动采集，多项任务同时运行"; break;
                default: panel = "CollectPage"; nav = "NavCollect"; heading = "采集条件"; subtitle = "设置商品、国家、店铺与日期，开始一次采集"; break;
            }
            Get<UIElement>(panel).Visibility = Visibility.Visible;
            SetText("PageHeading", heading); SetText("PageSubtitle", subtitle);
            if (Get<RadioButton>(nav).IsChecked != true) Get<RadioButton>(nav).IsChecked = true;
        }

        private void Stage(int number)
        {
            for (int index = 1; index <= 3; index++) Get<Border>("Step" + index + "Dot").Background = Color(index <= number ? "#456FC6" : "#29364E");
        }

        private void FillInputs(object summary)
        {
            string kind = ReportData.TextAt(summary, "input", "type").Replace(" ", "");
            for (int index = 0; index < typeLabels.Length; index++)
                if (typeValues[index] == kind || typeLabels[index].Replace(" ", "") == kind) { Get<ComboBox>("TypeBox").SelectedIndex = index; break; }
            Get<TextBox>("ValueBox").Text = ReportData.TextAt(summary, "input", "value");
            string match = ReportData.TextAt(summary, "input", "match");
            Get<ComboBox>("MatchBox").SelectedIndex = match == "精确" || match == "exact" ? 1 : 0;
            string country = ReportData.TextAt(summary, "input", "country");
            Get<ComboBox>("CountryBox").Text = country.Length > 0 ? country : "全部国家";
            Get<TextBox>("ShopBox").Text = ReportData.TextAt(summary, "input", "shop");
            string[] dates = ReportData.Items(ReportData.Value(summary, "dates")).Select(ReportData.Text).ToArray();
            if (dates.Length == 2)
            {
                Get<DatePicker>("FromPicker").SelectedDate = DateTime.ParseExact(dates[0], "yyyy-MM-dd", CultureInfo.InvariantCulture);
                Get<DatePicker>("ToPicker").SelectedDate = DateTime.ParseExact(dates[1], "yyyy-MM-dd", CultureInfo.InvariantCulture);
            }
        }

        private void OpenCollection(string path, bool fillInputs)
        {
            CollectionBundle bundle = ReportData.ReadBundle(path);
            current = bundle;
            Get<ComboBox>("ResultRowBox").ItemsSource = bundle.Rows;
            Get<UIElement>("EmptyResults").Visibility = bundle.Rows.Count > 0 ? Visibility.Collapsed : Visibility.Visible;
            Get<UIElement>("ResultScroll").Visibility = bundle.Rows.Count > 0 ? Visibility.Visible : Visibility.Collapsed;
            SetText("EmptyResultsText", bundle.Rows.Count > 0 ? "还没有采集结果" : "本次查询没有匹配的商品");
            string dates = string.Join(" — ", ReportData.Items(ReportData.Value(bundle.Summary, "dates")).Select(ReportData.Text));
            SetText("ResultDatesText", dates + "   ·   " + bundle.Rows.Count + " 条商品记录");
            string savedAt = DateTimeOffset.Parse(ReportData.TextAt(bundle.Summary, "fetchedAt"), CultureInfo.InvariantCulture).ToLocalTime().ToString("yyyy-MM-dd HH:mm");
            double? milliseconds = ReportData.Number(ReportData.Value(bundle.Summary, "elapsedMs"));
            SetText("SourceSavedText", "采集于 " + savedAt + "\n耗时 " + (milliseconds.HasValue ? (milliseconds.Value / 1000).ToString("0.0", ReportData.DisplayCulture) : "—") + " 秒");
            Get<ComboBox>("ResultRowBox").SelectedIndex = bundle.Rows.Count > 0 ? 0 : -1;
            if (fillInputs) FillInputs(bundle.Summary);
            LastResultPath = bundle.SummaryPath;
        }

        private void UpdateSelectedReport()
        {
            ReportRecord record = Get<ComboBox>("ResultRowBox").SelectedItem as ReportRecord;
            if (record == null) return;
            object row = record.Raw;
            string currency = ReportData.TextAt(row, "currency_code");
            if (currency.Length == 0) currency = ReportData.TextAt(row, "currency_icon");
            SetText("AmountLabel", "销售额" + (currency.Length > 0 ? " · " + currency : ""));
            SetText("AdAmountLabel", "广告销售额" + (currency.Length > 0 ? " · " + currency : ""));
            SetText("SalesValue", ReportData.Format(ReportData.Value(row, "volume")));
            SetText("AmountValue", ReportData.Format(ReportData.Value(row, "amount"), "N2"));
            SetText("ReturnValue", ReportData.Rate(ReportData.Value(row, "return_goods_rate")));
            SetText("ReturnCountText", "退货量 " + ReportData.Format(ReportData.Value(row, "return_goods_count")));
            SetText("AdAmountValue", ReportData.Format(ReportData.Value(row, "ad_sales_amount"), "N2"));
            SetText("SessionsValue", ReportData.Format(ReportData.Value(row, "sessions_total")));
            SetText("ViewsValue", ReportData.Format(ReportData.Value(row, "page_views_total")));
            SetText("ConversionText", "转化率 " + ReportData.Rate(ReportData.Value(row, "cvr")));
            SetText("FbaValue", ReportData.Format(ReportData.Value(row, "afn_fulfillable_quantity")));
            SetText("AvailableDaysValue", ReportData.Format(ReportData.Value(row, "available_days")));
            SetText("RefundCountValue", ReportData.Format(ReportData.Value(row, "return_count")));
            SetText("RefundRateValue", ReportData.Rate(ReportData.Value(row, "return_rate")));
            SetText("SourceNameText", record.ProductName); SetText("SourceScopeText", record.Scope);
            double? total = ReportData.Number(ReportData.Value(row, "sessions_total"));
            string[] devices = { "Browser", "Mobile" };
            string[] fields = { "sessions", "sessions_mobile" };
            for (int index = 0; index < 2; index++)
            {
                double? number = ReportData.Number(ReportData.Value(row, fields[index]));
                double? ratio = total.HasValue && total.Value > 0 && number.HasValue ? number.Value / total.Value : (double?)null;
                SetText(devices[index] + "SessionsText", ReportData.Format(number) + (ratio.HasValue ? " · " + ReportData.Rate(ratio) : ""));
                Get<ProgressBar>(devices[index] + "SessionsBar").Value = ratio.HasValue ? Math.Max(0, Math.Min(100, ratio.Value * 100)) : 0;
            }
            List<VariantRecord> variants = ReportData.Variants(row, currency);
            Get<DataGrid>("VariantGrid").ItemsSource = variants;
            SetText("VariantCount", variants.Count + " 条");
            SetText("VariantNote", variants.Count > 0 ? "售价币种：" + currency + "。点击列名排序，左右滚动查看完整字段。" : "本次响应没有提供关联 MSKU 明细。");
        }

        private void RefreshHistory()
        {
            history = ReportData.History(resultsDirectory);
            Get<DataGrid>("HistoryGrid").ItemsSource = history;
            SetText("HistoryCountText", history.Count + " 次成功采集 · 每次对应一组结果文件");
            Get<Button>("LoadHistoryButton").IsEnabled = history.Count > 0;
            if (history.Count > 0) Get<DataGrid>("HistoryGrid").SelectedIndex = 0;
        }

        private void OpenHistorySelection()
        {
            HistoryRecord selected = Get<DataGrid>("HistoryGrid").SelectedItem as HistoryRecord;
            if (selected == null) return;
            OpenCollection(selected.Path, true);
            ShowPage("results");
        }

        internal static string QuoteArgument(string value)
        {
            var quoted = new StringBuilder("\"");
            int slashes = 0;
            foreach (char letter in value)
            {
                if (letter == '\\') { slashes++; continue; }
                if (letter == '"') { quoted.Append('\\', slashes * 2 + 1); quoted.Append('"'); }
                else { quoted.Append('\\', slashes); quoted.Append(letter); }
                slashes = 0;
            }
            quoted.Append('\\', slashes * 2);
            return quoted.Append('"').ToString();
        }

        internal static ProcessStartInfo NodeStartInfo(string directory, IEnumerable<string> arguments)
        {
            return new ProcessStartInfo {
                FileName = Path.Combine(directory, "runtime", "node.exe"),
                Arguments = string.Join(" ", arguments.Select(QuoteArgument)), WorkingDirectory = directory,
                UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true,
                RedirectStandardError = true, StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8
            };
        }

        private void StartCollection()
        {
            if (collector != null) return;
            Notice("");
            string value = Get<TextBox>("ValueBox").Text.Trim();
            if (value.Length == 0 || value.Length > 160 || value.IndexOfAny(new[] { '"', '\r', '\n' }) >= 0) { Notice("请输入有效的商品标识或品名（最多 160 字符）。"); Get<TextBox>("ValueBox").Focus(); return; }
            DateTime from, to;
            if (!DateTime.TryParse(Get<DatePicker>("FromPicker").Text, out from) || !DateTime.TryParse(Get<DatePicker>("ToPicker").Text, out to)) { Notice("请输入有效的开始和结束日期。"); return; }
            if (from.Date > to.Date) { Notice("开始日期不能晚于结束日期。"); return; }
            string country = Get<ComboBox>("CountryBox").Text.Trim();
            if (country == "全部国家") country = "";
            string shop = Get<TextBox>("ShopBox").Text.Trim();
            if (country.Length > 120 || shop.Length > 120 || (country + shop).IndexOfAny(new[] { '"', '\r', '\n' }) >= 0) { Notice("国家或店铺名称无效（最多 120 字符）。"); return; }
            string script = Path.Combine(root, "browser.js");
            if (!File.Exists(Path.Combine(root, "runtime", "node.exe")) || !File.Exists(script) || !Directory.Exists(Path.Combine(root, "node_modules", "playwright"))) { Notice("采集文件不完整，请保留完整的商品诊断应用文件夹。"); return; }
            string kind = typeValues[Math.Max(0, Get<ComboBox>("TypeBox").SelectedIndex)];
            string match = Get<ComboBox>("MatchBox").SelectedIndex == 1 ? "exact" : "fuzzy";
            var arguments = new List<string> { script, "--type", kind, "--value", value, "--match", match, "--from", from.ToString("yyyy-MM-dd"), "--to", to.ToString("yyyy-MM-dd") };
            if (country.Length > 0) arguments.AddRange(new[] { "--country", country });
            if (shop.Length > 0) arguments.AddRange(new[] { "--shop", shop });
            string logDirectory = Path.Combine(root, ".private", "launcher-logs");
            Directory.CreateDirectory(logDirectory);
            string stamp = "exe-" + DateTime.Now.ToString("yyyyMMdd-HHmmss-fff");
            outputWriter = new StreamWriter(Path.Combine(logDirectory, stamp + "-out.log"), false, new UTF8Encoding(false)) { AutoFlush = true };
            errorWriter = new StreamWriter(Path.Combine(logDirectory, stamp + "-error.log"), false, new UTF8Encoding(false)) { AutoFlush = true };
            capturedResultPath = null;
            var info = NodeStartInfo(root, arguments);
            if (options.CollectOnce) info.EnvironmentVariables["LINGXING_LOGIN_TIMEOUT_MS"] = "20000";
            collector = new Process { StartInfo = info };
            collector.OutputDataReceived += (sender, data) => ReceiveOutput(data.Data, false);
            collector.ErrorDataReceived += (sender, data) => ReceiveOutput(data.Data, true);
            try
            {
                collector.Start();
                collector.BeginOutputReadLine(); collector.BeginErrorReadLine();
                Get<Button>("RunButton").IsEnabled = false; Get<Grid>("QueryFields").IsEnabled = false;
                Get<Button>("ResetPageButton").IsEnabled = false;
                Get<ProgressBar>("RunProgress").Visibility = Visibility.Visible;
                Stage(1); Status("正在打开领星");
                AddLog("\n开始采集：" + Get<ComboBox>("TypeBox").SelectedItem + " " + value + "，" + (country.Length > 0 ? country : "全部国家") + (shop.Length > 0 ? " / " + shop : "") + "，" + from.ToString("yyyy-MM-dd") + " 至 " + to.ToString("yyyy-MM-dd"));
                runTimer.Start();
            }
            catch (Exception error)
            {
                collector.Dispose(); collector = null; CloseWriters();
                Notice("启动失败：" + error.Message); Status("启动失败", "#F3A38F");
            }
        }

        private void ReceiveOutput(string text, bool isError)
        {
            if (text == null) return;
            lock (logLock) { StreamWriter writer = isError ? errorWriter : outputWriter; if (writer != null) writer.WriteLine(text); }
            if (!isError && text.StartsWith("结果：", StringComparison.Ordinal)) capturedResultPath = text.Substring(3).Trim();
            Window.Dispatcher.BeginInvoke(new Action(delegate {
                AddLog(text);
                if (text.Contains("尚未登录领星")) Status("等待浏览器登录");
                if (text.Contains("阶段：筛选与采集")) { Stage(2); Status("筛选与采集中"); }
                if (text.Contains("阶段：保存结果")) { Stage(3); Status("正在保存结果"); }
            }));
        }

        private void FinishCollection(object sender, EventArgs args)
        {
            if (collector == null || !collector.HasExited) return;
            collector.WaitForExit();
            int exitCode = collector.ExitCode;
            collector.Dispose(); collector = null;
            runTimer.Stop(); CloseWriters();
            Get<Button>("RunButton").IsEnabled = true; Get<Grid>("QueryFields").IsEnabled = true;
            Get<Button>("ResetPageButton").IsEnabled = true;
            Get<ProgressBar>("RunProgress").Visibility = Visibility.Collapsed;
            try
            {
                if (string.IsNullOrEmpty(capturedResultPath) || !File.Exists(capturedResultPath)) throw new InvalidOperationException("采集未完成（退出码：" + exitCode + "），请查看运行日志。");
                OpenCollection(capturedResultPath, false);
                RefreshHistory(); Stage(3); Status("采集完成");
                AddLog("\n采集完成，结果已保存并显示。");
                ShowPage("results");
            }
            catch (Exception error)
            {
                Status("采集失败", "#F3A38F"); Notice(error.Message); AddLog(error.Message); ShowPage("logs");
                if (options.CollectOnce) TestFailure = error.Message;
            }
            if (options.CollectOnce) Window.Close();
        }

        private void CloseWriters()
        {
            lock (logLock) { if (outputWriter != null) outputWriter.Dispose(); if (errorWriter != null) errorWriter.Dispose(); outputWriter = errorWriter = null; }
        }

        private void OnLoaded(object sender, RoutedEventArgs args)
        {
            if (!options.SmokeTest && !options.CollectOnce && options.Preview == null) return;
            var timer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(500) };
            timer.Tick += async delegate {
                timer.Stop();
                try
                {
                    if (options.SmokeTest) { SmokeCheck(); await AutomationSmokeCheck(); }
                    if (options.Preview != null) SavePreview(options.Preview);
                    if (options.CollectOnce)
                    {
                        if (current == null) throw new InvalidOperationException("没有可用于实测的历史查询条件。");
                        FillInputs(current.Summary); ShowPage("collect"); StartCollection();
                        if (collector == null) throw new InvalidOperationException(Get<TextBlock>("FormNotice").Text);
                    }
                }
                catch (Exception error) { TestFailure = error.Message; }
                if (options.SmokeTest || TestFailure != null) Window.Close();
            };
            timer.Start();
        }

        private static void Require(bool condition, string error) { if (!condition) throw new InvalidOperationException(error); }

        private void SmokeCheck()
        {
            Get<RadioButton>("NavCollect").IsChecked = true;
            Require(Get<UIElement>("CollectPage").Visibility == Visibility.Visible, "采集页面切换失败。");
            if (current != null) Require(Get<TextBox>("ValueBox").Text == ReportData.TextAt(current.Summary, "input", "value"), "查询条件回填失败。");
            string original = Get<TextBox>("ValueBox").Text;
            Get<TextBox>("ValueBox").Text = "";
            Get<Button>("RunButton").RaiseEvent(new RoutedEventArgs(ButtonBase.ClickEvent));
            Require(collector == null && Get<TextBlock>("FormNotice").Visibility == Visibility.Visible, "空输入校验失败。");
            Get<TextBox>("ValueBox").Text = original; Notice(""); Window.UpdateLayout();
            Get<ComboBox>("TypeBox").IsDropDownOpen = true; Get<ComboBox>("TypeBox").IsDropDownOpen = false;
            Get<DatePicker>("FromPicker").IsDropDownOpen = true; Get<DatePicker>("FromPicker").IsDropDownOpen = false;
            Get<RadioButton>("NavHistory").IsChecked = true;
            Require(Get<UIElement>("HistoryPage").Visibility == Visibility.Visible, "历史页面切换失败。");
            if (history.Count > 0)
            {
                Get<DataGrid>("HistoryGrid").SelectedIndex = 0;
                Get<Button>("LoadHistoryButton").RaiseEvent(new RoutedEventArgs(ButtonBase.ClickEvent));
                Require(Get<UIElement>("ResultsPage").Visibility == Visibility.Visible, "历史数据打开失败。");
                if (current.Rows.Count > 0)
                {
                    object raw = current.Rows[0].Raw;
                    Require(Get<TextBlock>("ReturnValue").Text == ReportData.Rate(ReportData.Value(raw, "return_goods_rate")), "退货率字段显示错误。");
                    Require(Get<TextBlock>("RefundRateValue").Text == ReportData.Rate(ReportData.Value(raw, "return_rate")), "退款率字段显示错误。");
                    Require(Get<DataGrid>("VariantGrid").Items.Count == ReportData.Variants(raw, ReportData.TextAt(raw, "currency_code")).Count, "关联 MSKU 明细不完整。");
                }
            }
            Get<RadioButton>("NavLogs").IsChecked = true;
            Require(Get<UIElement>("LogsPage").Visibility == Visibility.Visible, "日志页面切换失败。");
            Get<TextBox>("ValueBox").Text = "RESET-CHECK";
            Get<Button>("ResetPageButton").RaiseEvent(new RoutedEventArgs(ButtonBase.ClickEvent));
            Require(current == null && Get<ComboBox>("ResultRowBox").ItemsSource == null && Get<UIElement>("EmptyResults").Visibility == Visibility.Visible, "结果重置失败。");
            Require(Get<TextBox>("ValueBox").Text == "" && Get<DatePicker>("FromPicker").SelectedDate == null && Get<UIElement>("CollectPage").Visibility == Visibility.Visible, "采集条件重置失败。");
            if (history.Count > 0) OpenCollection(history[0].Path, true);
            ShowPage(initialPage); Window.UpdateLayout();
        }

        private void SavePreview(string path)
        {
            Window.UpdateLayout();
            var visual = (FrameworkElement)Window.Content;
            var bitmap = new RenderTargetBitmap((int)visual.ActualWidth, (int)visual.ActualHeight, 96, 96, PixelFormats.Pbgra32);
            bitmap.Render(visual);
            var encoder = new PngBitmapEncoder(); encoder.Frames.Add(BitmapFrame.Create(bitmap));
            using (Stream file = File.Create(path)) encoder.Save(file);
        }

        public void Dispose() { runTimer.Stop(); if (automationTimer != null) automationTimer.Stop(); CloseWriters(); if (collector != null) collector.Dispose(); }
    }
}
