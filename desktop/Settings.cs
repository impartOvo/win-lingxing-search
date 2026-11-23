using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows;
using System.Windows.Controls;

namespace ProductDiagnosis
{
    internal sealed partial class NativeWindow
    {
        private bool closeToTray, exitRequested;
        private volatile bool sessionEnding;
        private const int SmShuttingDown = 0x2000;
        [DllImport("user32.dll")]
        private static extern int GetSystemMetrics(int index);

        private static bool WindowsSessionIsEnding { get { return GetSystemMetrics(SmShuttingDown) != 0; } }
        private bool SessionIsEnding { get { return sessionEnding || WindowsSessionIsEnding; } }
        private bool CanRefreshVisibleWindow { get { return Window.IsVisible && Window.WindowState != WindowState.Minimized && !SessionIsEnding; } }

        private void UpdateRefreshTimers()
        {
            bool enabled = CanRefreshVisibleWindow;
            automationTimer.IsEnabled = enabled;
            featureTimer.IsEnabled = enabled;
        }

        private void BeginSessionEnd()
        {
            sessionEnding = true;
            UpdateRefreshTimers();
        }

        private void EnsureSessionActive()
        {
            if (SessionIsEnding) throw new OperationCanceledException("Windows 正在结束会话。");
        }

        private System.Windows.Forms.NotifyIcon trayIcon;
        private string SettingsPath { get { return Path.Combine(automationDataRoot, ".private", "app-settings.json"); } }
        private Dictionary<string, object> ReadAppPreferences()
        {
            return File.Exists(SettingsPath) ? CopyObject(ReportData.Serializer().DeserializeObject(File.ReadAllText(SettingsPath, Encoding.UTF8))) : new Dictionary<string, object>();
        }
        private void InitializeSettings()
        {
            try { object value; var settings = ReadAppPreferences(); closeToTray = settings.TryGetValue("closeToTray", out value) && value is bool && (bool)value; EnsureTray(); }
            catch (Exception error) { closeToTray = false; SetText("SettingsNotice", "设置读取失败：" + error.Message); }
            Get<CheckBox>("CloseToTrayBox").IsChecked = closeToTray;
            Window.IsVisibleChanged += delegate { UpdateRefreshTimers(); };
            Window.StateChanged += delegate { UpdateRefreshTimers(); };
            if (Application.Current != null) Application.Current.SessionEnding += delegate { BeginSessionEnd(); };
        }
        private void SaveAppPreferences(bool enabled)
        {
            var settings = ReadAppPreferences(); settings["version"] = 1; settings["closeToTray"] = enabled;
            // Create the recovery entry before enabling hide-on-close.
            bool previous = closeToTray; closeToTray = enabled;
            try {
                EnsureTray(); Directory.CreateDirectory(Path.GetDirectoryName(SettingsPath));
                string temporary = SettingsPath + "." + Guid.NewGuid().ToString("N") + ".tmp";
                try { File.WriteAllText(temporary, ReportData.Serializer().Serialize(settings), new UTF8Encoding(false)); if (File.Exists(SettingsPath)) File.Replace(temporary, SettingsPath, null); else File.Move(temporary, SettingsPath); }
                finally { if (File.Exists(temporary)) File.Delete(temporary); }
            } catch { closeToTray = previous; EnsureTray(); throw; }
        }
        private void EnsureTray()
        {
            if (!closeToTray) { if (!Window.IsVisible && Window.IsLoaded) RestoreFromTray(); DisposeTray(); return; }
            if (trayIcon != null) return;
            var icon = new System.Windows.Forms.NotifyIcon();
            try {
                icon.Icon = System.Drawing.Icon.ExtractAssociatedIcon(System.Reflection.Assembly.GetExecutingAssembly().Location);
                icon.Text = "PulsarFetch · 后台运行";
                var menu = new System.Windows.Forms.ContextMenuStrip();
                menu.Items.Add("打开主界面", null, delegate { Window.Dispatcher.BeginInvoke(new Action(RestoreFromTray)); });
                menu.Items.Add("设置", null, delegate { Window.Dispatcher.BeginInvoke(new Action(delegate { RestoreFromTray(); ShowPage("settings"); })); });
                menu.Items.Add(new System.Windows.Forms.ToolStripSeparator());
                menu.Items.Add("退出软件", null, delegate { Window.Dispatcher.BeginInvoke(new Action(ExitFromTray)); });
                icon.ContextMenuStrip = menu;
                icon.DoubleClick += delegate { Window.Dispatcher.BeginInvoke(new Action(RestoreFromTray)); };
                icon.Visible = true; trayIcon = icon;
            } catch { icon.Dispose(); throw; }
        }
        private void DisposeTray() { if (trayIcon != null) { trayIcon.Visible = false; var menu = trayIcon.ContextMenuStrip; var icon = trayIcon.Icon; trayIcon.Dispose(); trayIcon = null; if (menu != null) menu.Dispose(); if (icon != null) icon.Dispose(); } }
        private void RestoreFromTray() { Window.Show(); Window.ShowInTaskbar = true; if (Window.WindowState == WindowState.Minimized) Window.WindowState = WindowState.Normal; Window.Activate(); }
        private void HideInTray() { EnsureTray(); if (trayIcon == null) throw new InvalidOperationException("托盘尚未就绪。"); Window.Hide(); Window.ShowInTaskbar = false; }
        private bool TryHideToTray(System.ComponentModel.CancelEventArgs closing)
        {
            if (!closeToTray || exitRequested || SessionIsEnding) return false;
            try { closing.Cancel = true; HideInTray(); return true; }
            catch (Exception error) { closing.Cancel = true; RestoreFromTray(); ShowError(error); return true; }
        }
        private void ExitFromTray()
        {
            if (collector != null && !collector.HasExited) RestoreFromTray();
            exitRequested = true; Window.Close(); exitRequested = false;
        }
        private void WireSettingsEvents()
        {
            Get<RadioButton>("NavSettings").Checked += delegate { ShowPage("settings"); };
            var toggle = Get<CheckBox>("CloseToTrayBox");
            toggle.Click += delegate {
                try { SaveAppPreferences(toggle.IsChecked == true); SetText("SettingsNotice", ""); }
                catch (Exception error) { toggle.IsChecked = closeToTray; SetText("SettingsNotice", "设置保存失败：" + error.Message); }
            };
        }
        private void SettingsSmokeCheck()
        {
            ShowPage("settings");
            var toggle = Get<CheckBox>("CloseToTrayBox");
            toggle.IsChecked = true;
            toggle.RaiseEvent(new RoutedEventArgs(System.Windows.Controls.Primitives.ButtonBase.ClickEvent));
            Require((bool)ReadAppPreferences()["closeToTray"] && trayIcon != null, "后台运行设置未保存或托盘未创建。");
            Require(automationTimer.IsEnabled && featureTimer.IsEnabled, "窗口可见时应刷新任务与监控。");
            var closing = new System.ComponentModel.CancelEventArgs();
            Require(TryHideToTray(closing) && closing.Cancel && !Window.IsVisible && !Window.ShowInTaskbar, "关闭窗口未被接管到托盘。");
            Require(!automationTimer.IsEnabled && !featureTimer.IsEnabled, "托盘隐藏后仍在轮询。");
            RestoreFromTray(); Require(Window.IsVisible && Window.ShowInTaskbar, "托盘窗口恢复失败。");
            Require(automationTimer.IsEnabled && featureTimer.IsEnabled, "恢复窗口后没有恢复刷新。");
            exitRequested = true; Require(!TryHideToTray(new System.ComponentModel.CancelEventArgs()), "显式退出不应再次隐藏窗口。"); exitRequested = false;
            BeginSessionEnd();
            try
            {
                Require(!automationTimer.IsEnabled && !featureTimer.IsEnabled, "系统结束会话后仍在轮询。");
                Require(!TryHideToTray(new System.ComponentModel.CancelEventArgs()), "系统结束会话时不应退回托盘。");
                bool blocked = false;
                try { CallAutomation(new { action = "snapshot" }); }
                catch (OperationCanceledException) { blocked = true; }
                Require(blocked, "系统结束会话后仍可启动 Node。");
            }
            finally { sessionEnding = false; UpdateRefreshTimers(); }
            toggle.IsChecked = false;
            toggle.RaiseEvent(new RoutedEventArgs(System.Windows.Controls.Primitives.ButtonBase.ClickEvent));
            Require(!(bool)ReadAppPreferences()["closeToTray"] && trayIcon == null, "关闭后台运行后托盘未释放。");
        }
    }
}
