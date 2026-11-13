# Data used by the desktop UI. Missing report values remain missing.
function Get-ReportValue($Row, [string]$Name) {
    if ($null -eq $Row) { return $null }
    $property = $Row.PSObject.Properties[$Name]
    if ($null -ne $property) { return $property.Value }
    return $null
}

function Get-ReportNumber($Value) {
    if ($null -eq $Value -or [string]::IsNullOrWhiteSpace([string]$Value)) { return $null }
    $number = 0.0
    if ([double]::TryParse([string]$Value, [System.Globalization.NumberStyles]::Float,
            [System.Globalization.CultureInfo]::InvariantCulture, [ref]$number)) { return $number }
    return $null
}

function Format-ReportNumber($Value, [string]$Format = 'N0') {
    $number = Get-ReportNumber $Value
    if ($null -eq $number) { return '—' }
    return $number.ToString($Format, [System.Globalization.CultureInfo]::GetCultureInfo('zh-CN'))
}

function Format-ReportRate($Value) {
    $number = Get-ReportNumber $Value
    if ($null -eq $number) { return '—' }
    return ($number * 100).ToString('N2', [System.Globalization.CultureInfo]::GetCultureInfo('zh-CN')) + '%'
}

function Get-ReportIdentifier($Row, $Summary) {
    $field = switch ([string]$Summary.query.tab) {
        '父ASIN' { 'parent_asin' }
        'ASIN' { 'asin' }
        'MSKU' { 'msku' }
        'SKU' { 'sku' }
        'SPU' { 'spu' }
        default { 'parent_asin' }
    }
    $value = Get-ReportValue $Row $field
    if (-not [string]::IsNullOrWhiteSpace([string]$value)) { return [string]$value }
    foreach ($key in @('parent_asin', 'asin', 'msku', 'sku', 'spu')) {
        $value = Get-ReportValue $Row $key
        if (-not [string]::IsNullOrWhiteSpace([string]$value)) { return [string]$value }
    }
    return [string]$Summary.input.value
}

function Get-ReportNames($Row) {
    $local = Get-ReportValue $Row 'local_name'
    if ($local) { return [string]$local }
    $names = @(@(Get-ReportValue $Row 'spu_spu_names') | ForEach-Object { $_.spu_name } | Where-Object { $_ } | Select-Object -Unique)
    if ($names.Count) { return $names -join ' / ' }
    $name = Get-ReportValue $Row 'item_name'
    if ($name) { return [string]$name }
    return '未返回品名'
}

function Get-ReportScope($Row, $Summary) {
    $stores = @(Get-ReportValue $Row 'seller_store_countries')
    $values = @($stores | ForEach-Object {
        if ($_.seller_name -and $_.country) { "$($_.seller_name) · $($_.country)" }
        elseif ($_.seller_name) { $_.seller_name }
        elseif ($_.country) { $_.country }
    } | Select-Object -Unique)
    if ($values.Count) { return $values -join ' / ' }
    $country = if ($Summary.input.country) { [string]$Summary.input.country } else { '全部国家' }
    $shop = if ($Summary.input.shop) { [string]$Summary.input.shop } else { '全部店铺' }
    return "$country · $shop"
}

function Read-CollectionBundle([string]$SummaryPath) {
    $summary = Get-Content -LiteralPath $SummaryPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($summary.method -ne 'browser' -or $summary.status -ne 'ok') { throw '这次采集尚未确认成功，无法展示结果。' }
    $name = [System.IO.Path]::GetFileName($SummaryPath)
    if (-not $name.StartsWith('browser-') -or $name.StartsWith('browser-data-')) { throw '请选择 browser- 开头的采集记录。' }
    $dataPath = Join-Path ([System.IO.Path]::GetDirectoryName($SummaryPath)) ('browser-data-' + $name.Substring(8))
    if (-not (Test-Path -LiteralPath $dataPath -PathType Leaf)) { throw '找不到这次采集对应的数据文件。' }
    $payload = Get-Content -LiteralPath $dataPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $rawRows = @($payload.data.list | Where-Object { $null -ne $_ })
    $rows = @()
    for ($index = 0; $index -lt $rawRows.Count; $index++) {
        $row = $rawRows[$index]
        $identifier = Get-ReportIdentifier $row $summary
        $scope = Get-ReportScope $row $summary
        $rows += [pscustomobject]@{
            Display = "$identifier · $scope"
            Identifier = $identifier
            ProductName = Get-ReportNames $row
            Scope = $scope
            Raw = $row
        }
    }
    return [pscustomobject]@{
        Summary = $summary
        SummaryPath = [System.IO.Path]::GetFullPath($SummaryPath)
        DataPath = [System.IO.Path]::GetFullPath($dataPath)
        Rows = $rows
    }
}

function Get-VariantRows($Row, [string]$Currency) {
    $rows = @()
    foreach ($variant in @(Get-ReportValue $Row 'price_list')) {
        if ($null -eq $variant) { continue }
        $rows += [pscustomobject]@{
            ProductName = [string]$variant.local_name
            MSKU = [string]$variant.seller_sku
            SKU = [string]$variant.local_sku
            Store = (@($variant.seller_name, $variant.country) | Where-Object { $_ }) -join ' · '
            Sales = Get-ReportNumber $variant.volume
            Price = Get-ReportNumber $variant.price
            Currency = $Currency
        }
    }
    return $rows
}

function Get-CollectionHistory([string]$ResultsPath) {
    if (-not (Test-Path -LiteralPath $ResultsPath -PathType Container)) { return @() }
    $rows = @()
    foreach ($file in @(Get-ChildItem -LiteralPath $ResultsPath -Filter 'browser-*.json' -File | Where-Object { $_.Name -notlike 'browser-data-*' } | Sort-Object Name -Descending)) {
        try {
            $summary = Get-Content -LiteralPath $file.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
            $dataPath = Join-Path $ResultsPath ('browser-data-' + $file.Name.Substring(8))
            if ($summary.method -ne 'browser' -or $summary.status -ne 'ok' -or -not (Test-Path -LiteralPath $dataPath -PathType Leaf)) { continue }
            $saved = [DateTimeOffset]::Parse([string]$summary.fetchedAt).ToLocalTime().ToString('yyyy-MM-dd HH:mm')
            $rows += [pscustomobject]@{
                SavedAt = $saved
                Type = [string]$summary.input.type
                Value = [string]$summary.input.value
                Country = if ($summary.input.country) { [string]$summary.input.country } else { '全部国家' }
                Shop = if ($summary.input.shop) { [string]$summary.input.shop } else { '全部店铺' }
                Dates = @($summary.dates) -join ' — '
                Count = $summary.pagination.collected
                Path = $file.FullName
            }
        } catch { continue }
    }
    return $rows
}
