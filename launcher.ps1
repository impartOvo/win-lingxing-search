param(
    [switch]$SelfTest,
    [switch]$SmokeTest,
    [string]$VerifyLog,
    [string]$PreviewPath,
    [ValidateSet('auto', 'collect', 'results', 'history', 'logs')][string]$StartPage = 'auto'
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'ui-data.ps1')
$types = [ordered]@{
    'ASIN' = 'asin'; '父 ASIN' = 'parent_asin'; 'SKU' = 'sku'; 'MSKU' = 'msku'
    'FNSKU' = 'fnsku'; 'SPU' = 'spu'; '品名' = 'name'
}
$node = (Get-Command node.exe -ErrorAction Stop).Source
$browserScript = Join-Path $PSScriptRoot 'browser.js'
$resultsPath = Join-Path $PSScriptRoot 'results'
if (-not (Test-Path -LiteralPath $browserScript -PathType Leaf)) { throw '找不到 browser.js' }

function Get-ResultPathFromLog([string]$LogPath) {
    if (-not (Test-Path -LiteralPath $LogPath -PathType Leaf)) { return $null }
    $output = [System.IO.File]::ReadAllText($LogPath, [System.Text.Encoding]::UTF8)
    $match = [regex]::Match($output, '(?m)^结果：(.+?)\r?$')
    if ($match.Success) { return $match.Groups[1].Value.Trim() }
    return $null
}

function Test-CollectionResult([string]$LogPath) {
    $path = Get-ResultPathFromLog $LogPath
    if (-not $path -or -not (Test-Path -LiteralPath $path -PathType Leaf)) { return $false }
    try { $null = Read-CollectionBundle $path; return $true } catch { return $false }
}

if ($VerifyLog) {
    if (Test-CollectionResult $VerifyLog) { Write-Output 'verified collection result ok'; exit 0 }
    Write-Error 'collection result could not be verified'
    exit 1
}

if ($SelfTest) {
    if ($types['FNSKU'] -ne 'fnsku' -or $types['品名'] -ne 'name') { throw '标识类型映射错误' }
    if ((Format-ReportNumber $null) -ne '—' -or (Format-ReportNumber 0) -ne '0') { throw '空值与零值显示错误' }
    if ((Format-ReportRate '0.125') -ne '12.50%') { throw '百分比格式错误' }
    $history = @(Get-CollectionHistory $resultsPath)
    if ($history.Count) {
        $bundle = Read-CollectionBundle $history[0].Path
        foreach ($record in $bundle.Rows) {
            $raw = $record.Raw
            $variants = @(Get-VariantRows $raw ([string]$raw.currency_code))
            foreach ($variant in $variants) { if ($variant.MSKU -isnot [string]) { throw '关联 MSKU 解析失败' } }
        }
        Write-Output ("loaded {0} report rows" -f $bundle.Rows.Count)
    }
    Write-Output 'launcher self-test ok'
    exit 0
}

Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase
[xml]$xaml = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'launcher.xaml') -Raw -Encoding UTF8
$reader = New-Object System.Xml.XmlNodeReader $xaml
$window = [System.Windows.Markup.XamlReader]::Load($reader)
$ui = @{}
# Find named controls without coupling controller code to the visual hierarchy.
$namespaceManager = New-Object System.Xml.XmlNamespaceManager($xaml.NameTable)
$namespaceManager.AddNamespace('x', 'http://schemas.microsoft.com/winfx/2006/xaml')
foreach ($element in $xaml.SelectNodes('//*[@x:Name]', $namespaceManager)) {
    $name = $element.GetAttribute('Name', 'http://schemas.microsoft.com/winfx/2006/xaml')
    $control = $window.FindName($name)
    if ($null -ne $control) { $ui[$name] = $control }
}

$script:currentBundle = $null
$script:runProcess = $null
$script:stdoutFile = $null
$script:stderrFile = $null
$script:stdoutLength = 0
$script:stderrLength = 0
$script:runStage = 0
$script:historyRows = @()
$script:smokeFailure = $null

function Set-Status([string]$Text, [string]$Color = '#6B99FF') {
    $ui.StatusText.Text = $Text
    $ui.StatusDot.Fill = [System.Windows.Media.BrushConverter]::new().ConvertFromString($Color)
}

function Show-Page([string]$Page) {
    foreach ($key in @('CollectPage', 'ResultsPage', 'HistoryPage', 'LogsPage')) { $ui[$key].Visibility = 'Collapsed' }
    $content = switch ($Page) {
        'collect' { @('CollectPage', 'NavCollect', '采集条件', '设置商品、国家、店铺与日期，开始一次采集') }
        'results' { @('ResultsPage', 'NavResults', '采集结果', '查看所选商品在指定时间段内的表现') }
        'history' { @('HistoryPage', 'NavHistory', '历史记录', '每条记录代表一次采集，可随时重新打开') }
        'logs' { @('LogsPage', 'NavLogs', '运行日志', '查看本次采集进度与错误信息') }
    }
    $ui[$content[0]].Visibility = 'Visible'
    $ui.PageHeading.Text = $content[2]
    $ui.PageSubtitle.Text = $content[3]
    if (-not $ui[$content[1]].IsChecked) { $ui[$content[1]].IsChecked = $true }
}

function Show-Notice([string]$Text) {
    $ui.FormNotice.Text = $Text
    $ui.FormNotice.Visibility = if ($Text) { 'Visible' } else { 'Collapsed' }
}

function Add-Log([string]$Text) {
    $ui.LogBox.AppendText($Text)
    $ui.LogBox.ScrollToEnd()
}

function Set-RunStage([int]$Stage) {
    $script:runStage = $Stage
    for ($index = 1; $index -le 3; $index++) {
        $color = if ($Stage -ge $index) { '#456FC6' } else { '#29364E' }
        $ui["Step${index}Dot"].Background = [System.Windows.Media.BrushConverter]::new().ConvertFromString($color)
    }
}

function Set-InputsFromSummary($Summary) {
    $kind = [string]$Summary.input.type
    foreach ($entry in $types.GetEnumerator()) {
        if ($entry.Value -eq $kind -or $entry.Key.Replace(' ', '') -eq $kind.Replace(' ', '')) { $ui.TypeBox.SelectedItem = $entry.Key; break }
    }
    $ui.ValueBox.Text = [string]$Summary.input.value
    $ui.MatchBox.SelectedIndex = if ($Summary.input.match -in @('精确', 'exact')) { 1 } else { 0 }
    $ui.CountryBox.Text = if ($Summary.input.country) { [string]$Summary.input.country } else { '全部国家' }
    $ui.ShopBox.Text = [string]$Summary.input.shop
    if (@($Summary.dates).Count -eq 2) {
        $ui.FromPicker.SelectedDate = [datetime]::ParseExact([string]$Summary.dates[0], 'yyyy-MM-dd', [cultureinfo]::InvariantCulture)
        $ui.ToPicker.SelectedDate = [datetime]::ParseExact([string]$Summary.dates[1], 'yyyy-MM-dd', [cultureinfo]::InvariantCulture)
    }
}

function Update-SelectedReport {
    $record = $ui.ResultRowBox.SelectedItem
    if ($null -eq $record) { return }
    $raw = $record.Raw
    $currency = [string](Get-ReportValue $raw 'currency_code')
    if (-not $currency) { $currency = [string](Get-ReportValue $raw 'currency_icon') }
    $ui.AmountLabel.Text = if ($currency) { "销售额 · $currency" } else { '销售额' }
    $ui.AdAmountLabel.Text = if ($currency) { "广告销售额 · $currency" } else { '广告销售额' }
    $ui.SalesValue.Text = Format-ReportNumber (Get-ReportValue $raw 'volume')
    $ui.AmountValue.Text = Format-ReportNumber (Get-ReportValue $raw 'amount') 'N2'
    $ui.ReturnValue.Text = Format-ReportRate (Get-ReportValue $raw 'return_goods_rate')
    $ui.ReturnCountText.Text = '退货量 ' + (Format-ReportNumber (Get-ReportValue $raw 'return_goods_count'))
    $ui.AdAmountValue.Text = Format-ReportNumber (Get-ReportValue $raw 'ad_sales_amount') 'N2'
    $ui.SessionsValue.Text = Format-ReportNumber (Get-ReportValue $raw 'sessions_total')
    $ui.ViewsValue.Text = Format-ReportNumber (Get-ReportValue $raw 'page_views_total')
    $ui.ConversionText.Text = '转化率 ' + (Format-ReportRate (Get-ReportValue $raw 'cvr'))
    $ui.FbaValue.Text = Format-ReportNumber (Get-ReportValue $raw 'afn_fulfillable_quantity')
    $ui.AvailableDaysValue.Text = Format-ReportNumber (Get-ReportValue $raw 'available_days')
    $ui.RefundCountValue.Text = Format-ReportNumber (Get-ReportValue $raw 'return_count')
    $ui.RefundRateValue.Text = Format-ReportRate (Get-ReportValue $raw 'return_rate')
    $ui.SourceNameText.Text = $record.ProductName
    $ui.SourceScopeText.Text = $record.Scope
    $total = Get-ReportNumber (Get-ReportValue $raw 'sessions_total')
    foreach ($device in @(@('Browser', 'sessions'), @('Mobile', 'sessions_mobile'))) {
        $number = Get-ReportNumber (Get-ReportValue $raw $device[1])
        $ratio = if ($null -ne $total -and $total -gt 0 -and $null -ne $number) { $number / $total } else { $null }
        $ui[($device[0] + 'SessionsText')].Text = (Format-ReportNumber $number) + $(if ($null -ne $ratio) { ' · ' + (Format-ReportRate $ratio) } else { '' })
        $ui[($device[0] + 'SessionsBar')].Value = if ($null -ne $ratio) { [Math]::Min(100, [Math]::Max(0, $ratio * 100)) } else { 0 }
    }
    $variants = @(Get-VariantRows $raw $currency)
    $ui.VariantGrid.ItemsSource = $variants
    $ui.VariantCount.Text = "$($variants.Count) 条"
    $ui.VariantNote.Text = if ($variants.Count) { "售价币种：$currency。点击列名排序，左右滚动查看完整字段。" } else { '本次响应没有提供关联 MSKU 明细。' }
}

function Open-Collection([string]$Path, [switch]$FillInputs) {
    $bundle = Read-CollectionBundle $Path
    $script:currentBundle = $bundle
    $ui.ResultRowBox.ItemsSource = @($bundle.Rows)
    $ui.EmptyResults.Visibility = if ($bundle.Rows.Count) { 'Collapsed' } else { 'Visible' }
    $ui.ResultScroll.Visibility = if ($bundle.Rows.Count) { 'Visible' } else { 'Collapsed' }
    $ui.EmptyResultsText.Text = if ($bundle.Rows.Count) { '还没有采集结果' } else { '本次查询没有匹配的商品' }
    $summary = $bundle.Summary
    $dateRange = @($summary.dates) -join ' — '
    $ui.ResultDatesText.Text = "$dateRange   ·   $($bundle.Rows.Count) 条商品记录"
    $saved = [DateTimeOffset]::Parse([string]$summary.fetchedAt).ToLocalTime().ToString('yyyy-MM-dd HH:mm')
    $seconds = [Math]::Round([double]$summary.elapsedMs / 1000, 1)
    $ui.SourceSavedText.Text = "采集于 $saved`n耗时 $seconds 秒"
    $ui.ResultRowBox.SelectedIndex = if ($bundle.Rows.Count) { 0 } else { -1 }
    if ($FillInputs) { Set-InputsFromSummary $summary }
}

function Refresh-History {
    $script:historyRows = @(Get-CollectionHistory $resultsPath)
    $ui.HistoryGrid.ItemsSource = $script:historyRows
    $ui.HistoryCountText.Text = "$($script:historyRows.Count) 次成功采集 · 每次对应一组结果文件"
    $ui.LoadHistoryButton.IsEnabled = $script:historyRows.Count -gt 0
    if ($script:historyRows.Count) { $ui.HistoryGrid.SelectedIndex = 0 }
}

function Open-HistorySelection {
    if ($null -eq $ui.HistoryGrid.SelectedItem) { return }
    try {
        Open-Collection $ui.HistoryGrid.SelectedItem.Path -FillInputs
        Show-Page 'results'
    } catch { Add-Log ("读取结果失败：$($_.Exception.Message)`r`n"); Set-Status '读取失败' '#F3A38F'; Show-Page 'logs' }
}

function Read-RunOutput {
    foreach ($stream in @('stdout', 'stderr')) {
        $file = if ($stream -eq 'stdout') { $script:stdoutFile } else { $script:stderrFile }
        if (-not $file -or -not (Test-Path -LiteralPath $file -PathType Leaf)) { continue }
        try { $content = [System.IO.File]::ReadAllText($file, [System.Text.Encoding]::UTF8) } catch { continue }
        $length = if ($stream -eq 'stdout') { $script:stdoutLength } else { $script:stderrLength }
        if ($content.Length -gt $length) {
            Add-Log $content.Substring($length)
            if ($stream -eq 'stdout') { $script:stdoutLength = $content.Length } else { $script:stderrLength = $content.Length }
        }
        if ($stream -eq 'stdout') {
            if ($content -match '尚未登录领星') { Set-Status '等待浏览器登录' }
            if ($content -match '阶段：筛选与采集') { Set-RunStage 2; Set-Status '筛选与采集中' }
            if ($content -match '阶段：保存结果') { Set-RunStage 3; Set-Status '正在保存结果' }
        }
    }
}

function ConvertTo-NativeArgument([string]$Value) {
    $escaped = [regex]::Replace($Value, '(\\*)"', '$1$1\"')
    return '"' + [regex]::Replace($escaped, '(\\+)$', '$1$1') + '"'
}

function Invoke-UiSmokeCheck {
    $ui.NavCollect.IsChecked = $true
    if ($ui.CollectPage.Visibility -ne 'Visible') { throw '采集条件导航未切换页面' }
    if ($script:currentBundle -and $ui.ValueBox.Text -ne [string]$script:currentBundle.Summary.input.value) { throw '商品标识回填失败' }
    $valueBefore = $ui.ValueBox.Text
    $ui.ValueBox.Text = ''
    $ui.RunButton.RaiseEvent([System.Windows.RoutedEventArgs]::new([System.Windows.Controls.Primitives.ButtonBase]::ClickEvent))
    if ($ui.FormNotice.Visibility -ne 'Visible' -or $null -ne $script:runProcess) { throw '空输入未被阻止' }
    $ui.ValueBox.Text = $valueBefore
    Show-Notice ''
    $window.UpdateLayout()
    $ui.TypeBox.IsDropDownOpen = $true
    $ui.TypeBox.IsDropDownOpen = $false
    $ui.FromPicker.IsDropDownOpen = $true
    $ui.FromPicker.IsDropDownOpen = $false
    $ui.NavHistory.IsChecked = $true
    if ($ui.HistoryPage.Visibility -ne 'Visible') { throw '历史记录导航未切换页面' }
    if ($script:historyRows.Count) {
        $ui.HistoryGrid.SelectedIndex = 0
        $ui.LoadHistoryButton.RaiseEvent([System.Windows.RoutedEventArgs]::new([System.Windows.Controls.Primitives.ButtonBase]::ClickEvent))
        if ($ui.ResultsPage.Visibility -ne 'Visible') { throw '历史记录未能打开结果' }
        if ($script:currentBundle.Rows.Count) {
            $raw = $script:currentBundle.Rows[0].Raw
            if ($ui.ReturnValue.Text -ne (Format-ReportRate (Get-ReportValue $raw 'return_goods_rate'))) { throw '退货率显示口径错误' }
            if ($ui.RefundRateValue.Text -ne (Format-ReportRate (Get-ReportValue $raw 'return_rate'))) { throw '退款率显示口径错误' }
            if ($ui.VariantGrid.Items.Count -ne @(Get-VariantRows $raw ([string]$raw.currency_code)).Count) { throw '关联 MSKU 未完整显示' }
        }
    }
    $ui.NavLogs.IsChecked = $true
    if ($ui.LogsPage.Visibility -ne 'Visible') { throw '日志导航未切换页面' }
    Show-Page $StartPage
    $window.UpdateLayout()
}

$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds(500)
$timer.Add_Tick({
    Read-RunOutput
    if ($null -eq $script:runProcess -or -not $script:runProcess.HasExited) { return }
    $script:runProcess.WaitForExit()
    Read-RunOutput
    $exitCode = $script:runProcess.ExitCode
    $timer.Stop()
    $ui.RunButton.IsEnabled = $true
    $ui.QueryFields.IsEnabled = $true
    $ui.RunProgress.Visibility = 'Collapsed'
    try {
        if (-not (Test-CollectionResult $script:stdoutFile)) { throw "采集未完成（退出码：$exitCode），请查看运行日志。" }
        $resultPath = Get-ResultPathFromLog $script:stdoutFile
        Open-Collection $resultPath
        Refresh-History
        Set-RunStage 3
        Set-Status '采集完成'
        Add-Log "`r`n采集完成，结果已保存并显示。`r`n"
        Show-Page 'results'
    } catch {
        Set-Status '采集失败' '#F3A38F'
        Show-Notice $_.Exception.Message
        Add-Log ("`r`n$($_.Exception.Message)`r`n")
        Show-Page 'logs'
    } finally { $script:runProcess.Dispose(); $script:runProcess = $null }
})

function Start-Collection {
    if ($null -ne $script:runProcess) { return }
    Show-Notice ''
    $value = $ui.ValueBox.Text.Trim()
    if (-not $value -or $value.Length -gt 160 -or $value -match '["\r\n]') { Show-Notice '请输入有效的商品标识或品名（最多 160 字符）。'; $ui.ValueBox.Focus() | Out-Null; return }
    $fromDate = [datetime]::MinValue
    $toDate = [datetime]::MinValue
    if (-not [datetime]::TryParse($ui.FromPicker.Text, [ref]$fromDate) -or -not [datetime]::TryParse($ui.ToPicker.Text, [ref]$toDate)) { Show-Notice '请输入有效的开始和结束日期。'; return }
    if ($fromDate.Date -gt $toDate.Date) { Show-Notice '开始日期不能晚于结束日期。'; return }
    $country = $ui.CountryBox.Text.Trim()
    if ($country -eq '全部国家') { $country = '' }
    $shop = $ui.ShopBox.Text.Trim()
    if ($country.Length -gt 120 -or $shop.Length -gt 120 -or $country -match '["\r\n]' -or $shop -match '["\r\n]') { Show-Notice '国家或店铺名称无效（最多 120 字符）。'; return }
    $kind = $types[[string]$ui.TypeBox.SelectedItem]
    $match = if ($ui.MatchBox.SelectedIndex -eq 1) { 'exact' } else { 'fuzzy' }
    $from = $fromDate.ToString('yyyy-MM-dd')
    $to = $toDate.ToString('yyyy-MM-dd')
    $logDir = Join-Path $PSScriptRoot '.private\launcher-logs'
    if (-not (Test-Path -LiteralPath $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
    $script:stdoutFile = Join-Path $logDir "$stamp-out.log"
    $script:stderrFile = Join-Path $logDir "$stamp-error.log"
    $script:stdoutLength = 0
    $script:stderrLength = 0
    $arguments = @($browserScript, '--type', $kind, '--value', $value, '--match', $match, '--from', $from, '--to', $to)
    if ($country) { $arguments += @('--country', $country) }
    if ($shop) { $arguments += @('--shop', $shop) }
    $argumentString = ($arguments | ForEach-Object { ConvertTo-NativeArgument ([string]$_) }) -join ' '
    try {
        $script:runProcess = Start-Process -FilePath $node -ArgumentList $argumentString -WorkingDirectory $PSScriptRoot -RedirectStandardOutput $script:stdoutFile -RedirectStandardError $script:stderrFile -WindowStyle Hidden -PassThru
        $ui.RunButton.IsEnabled = $false
        $ui.QueryFields.IsEnabled = $false
        $ui.RunProgress.Visibility = 'Visible'
        Set-RunStage 1
        Set-Status '正在打开领星'
        $scope = if ($country) { $country } else { '全部国家' }
        if ($shop) { $scope += " / $shop" }
        Add-Log ("`r`n开始采集：$($ui.TypeBox.SelectedItem) $value（$($ui.MatchBox.SelectedItem)），$scope，$from 至 $to`r`n")
        $timer.Start()
    } catch { Set-Status '启动失败' '#F3A38F'; Show-Notice $_.Exception.Message; Add-Log ("启动失败：$($_.Exception.Message)`r`n") }
}

foreach ($kind in $types.Keys) { $ui.TypeBox.Items.Add($kind) | Out-Null }
$ui.TypeBox.SelectedIndex = 0
foreach ($match in @('模糊', '精确')) { $ui.MatchBox.Items.Add($match) | Out-Null }
$ui.MatchBox.SelectedIndex = 0
foreach ($country in (@('全部国家') + @(Get-Content -LiteralPath (Join-Path $PSScriptRoot 'countries.json') -Raw -Encoding UTF8 | ConvertFrom-Json))) { $ui.CountryBox.Items.Add($country) | Out-Null }
$ui.CountryBox.SelectedIndex = 0
$ui.FromPicker.SelectedDate = [datetime]::Today.AddDays(-30)
$ui.ToPicker.SelectedDate = [datetime]::Today.AddDays(-1)

$ui.NavCollect.Add_Checked({ Show-Page 'collect' })
$ui.NavResults.Add_Checked({ Show-Page 'results' })
$ui.NavHistory.Add_Checked({ Refresh-History; Show-Page 'history' })
$ui.NavLogs.Add_Checked({ Show-Page 'logs' })
$ui.GoCollectButton.Add_Click({ Show-Page 'collect' })
$ui.ShowRunLogButton.Add_Click({ Show-Page 'logs' })
$ui.ResultRowBox.Add_SelectionChanged({ Update-SelectedReport })
$ui.RunButton.Add_Click({ Start-Collection })
$ui.Last7Button.Add_Click({ $ui.FromPicker.SelectedDate = [datetime]::Today.AddDays(-7); $ui.ToPicker.SelectedDate = [datetime]::Today.AddDays(-1) })
$ui.Last30Button.Add_Click({ $ui.FromPicker.SelectedDate = [datetime]::Today.AddDays(-30); $ui.ToPicker.SelectedDate = [datetime]::Today.AddDays(-1) })
$ui.EditQueryButton.Add_Click({ if ($script:currentBundle) { Set-InputsFromSummary $script:currentBundle.Summary }; Show-Page 'collect' })
$ui.FolderButton.Add_Click({ if (-not (Test-Path -LiteralPath $resultsPath)) { New-Item -ItemType Directory -Path $resultsPath | Out-Null }; Start-Process explorer.exe -ArgumentList (ConvertTo-NativeArgument $resultsPath) })
$ui.OpenJsonButton.Add_Click({ if ($script:currentBundle) { Start-Process -FilePath $script:currentBundle.DataPath } })
$ui.RefreshHistoryButton.Add_Click({ Refresh-History })
$ui.LoadHistoryButton.Add_Click({ Open-HistorySelection })
$ui.HistoryGrid.Add_MouseDoubleClick({ Open-HistorySelection })
$ui.ClearLogButton.Add_Click({ $ui.LogBox.Clear() })
$ui.MinimizeButton.Add_Click({ $window.WindowState = 'Minimized' })
$ui.MaximizeButton.Add_Click({ $window.WindowState = if ($window.WindowState -eq 'Maximized') { 'Normal' } else { 'Maximized' } })
$ui.CloseButton.Add_Click({ $window.Close() })
$window.Add_Closing({
    if ($script:runProcess -and -not $script:runProcess.HasExited) { $_.Cancel = $true; Show-Notice '采集正在进行，请等待结束后再关闭窗口。'; Show-Page 'collect' }
})
$window.Add_Closed({ $timer.Stop() })

Refresh-History
if ($script:historyRows.Count) {
    try { Open-Collection $script:historyRows[0].Path -FillInputs } catch { Add-Log ("历史结果读取失败：$($_.Exception.Message)`r`n") }
}
if ($StartPage -eq 'auto') { $StartPage = if ($script:currentBundle) { 'results' } else { 'collect' } }
Show-Page $StartPage

if ($SmokeTest -or $PreviewPath) {
    $previewTimer = New-Object System.Windows.Threading.DispatcherTimer
    $previewTimer.Interval = [TimeSpan]::FromMilliseconds(700)
    $previewTimer.Add_Tick({
        $previewTimer.Stop()
        try {
          if ($SmokeTest) { Invoke-UiSmokeCheck }
          if ($PreviewPath) {
            $window.UpdateLayout()
            $visual = $window.Content
            $bitmap = New-Object System.Windows.Media.Imaging.RenderTargetBitmap ([int]$visual.ActualWidth), ([int]$visual.ActualHeight), 96, 96, ([System.Windows.Media.PixelFormats]::Pbgra32)
            $bitmap.Render($visual)
            $encoder = New-Object System.Windows.Media.Imaging.PngBitmapEncoder
            $encoder.Frames.Add([System.Windows.Media.Imaging.BitmapFrame]::Create($bitmap))
            $stream = [System.IO.File]::Create([System.IO.Path]::GetFullPath($PreviewPath))
            try { $encoder.Save($stream) } finally { $stream.Dispose() }
          }
        } catch { $script:smokeFailure = $_.Exception.Message }
        finally { if ($SmokeTest) { $window.Close() } }
    })
    $previewTimer.Start()
}

if (-not $SmokeTest) {
    Add-Type -Namespace ProductDiagnosis -Name ConsoleWindow -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("kernel32.dll")]
public static extern System.IntPtr GetConsoleWindow();
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool ShowWindow(System.IntPtr hWnd, int nCmdShow);
'@
    [void][ProductDiagnosis.ConsoleWindow]::ShowWindow([ProductDiagnosis.ConsoleWindow]::GetConsoleWindow(), 0)
}
[void]$window.ShowDialog()
if ($script:smokeFailure) { throw $script:smokeFailure }
if ($SmokeTest) { Write-Output 'launcher WPF smoke-test ok' }
