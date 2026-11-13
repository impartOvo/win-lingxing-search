# 结果格式与字段

一次浏览器采集对应两个文件，使用相同时间戳。`browser-*.json` 包含 input、query、dates、appliedFilters、pagination、status、elapsedMs 等上下文；`browser-data-*.json` 保存领星响应，商品列表通常位于 `data.list`。

| 字段 | 中文说明 |
|---|---|
| `volume` | 销量 |
| `amount` | 销售额 |
| `currency_code` | 当前记录币种 |
| `return_goods_count` / `return_goods_rate` | 退货量 / 退货率 |
| `return_count` / `return_rate` | 退款量 / 退款率 |
| `sessions_total` | 总会话数 |
| `sessions` / `sessions_mobile` | 浏览器端 / 手机 App 会话数 |
| `page_views_total` | 总页面浏览量 |
| `cvr` | 领星返回的转化率 |
| `ad_sales_amount` | 广告归因销售额 |
| `spend` / `acos` / `tacos` | 广告花费 / ACOS / TACOS |
| `afn_fulfillable_quantity` | FBA 可售库存 |
| `available_days` | 预计可售天数 |
| `price_list` | 本次响应附带的关联 MSKU 列表 |

比率原值按小数保存，界面乘以 100 显示百分比。父体汇总行的单个 ASIN、SKU 或品名可能为空，但相应集合字段仍有内容。字段缺失与 `null` 均不应当作零。

`price_list` 包含的属性依响应而定，不能据此声称已经取得子体级退货率、利润或逐日趋势。报表各指标的日期、归因与统计口径以领星实际定义为准。

`examples/` 中两个 JSON 是合成结构示例，不能用于商业决策。
