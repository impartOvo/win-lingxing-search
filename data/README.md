# 数据工作台接口

`require('./data/cli.cjs').execute(request, absoluteDataRoot)` 同步返回 JSON 对象，参数或结果无效时抛出错误。CLI 用 `node data/cli.cjs --data ROOT`，从 stdin 接收一个 UTF-8 JSON 请求，stdout 仅返回一个 JSON 对象；失败返回 `{error}` 并退出 1。也可在请求中传入 `dataRoot`。

- `history`: 可传 `filters:{search,country,shop,source,from,to}`。国家、店铺、来源精确筛选，search 不区分大小写查文件名/查询值/类型/国家/店铺。日期指业务日期，结果范围必须完整落入筛选范围。仅展示 `results/` 下成功且完整、日期有效的 browser/mcp JSON 文件对。
- `export`: 传 `name,format:'xlsx'|'csv'`。返回 `{path,rows,format,sheets}`。仅写 `exports/`，每次唯一文件名。XLSX 是无外部依赖的真实 ZIP/SpreadsheetML，包含“汇总”“关联MSKU”“采集信息”；原始额外字段保留。关联行独立展示，不与汇总累加。CSV 仅含汇总（关联明细保留 JSON 单元格），附来源、业务日期与采集时间。CSV null 编为 `\N`，以反斜线开始的字面字符串多加一个反斜线；空字符串仍为空字符串，数字零仍为零。为防 Excel 公式执行和数字标识损坏，CSV 的危险文本及数字形字符串加前导单引号；XLSX 文本使用 inlineStr，不生成公式。
- `daily`: 返回 `{items,count,skippedRolling,warnings}`。只从开始=结束的实际业务日期生成事实，不存储/覆盖原始数据，不作滚动窗口差分或累计。按日期、实体、实际范围、粒度、币种、通道选择最新采集；缺失/重复标识、实际币种或采集时间的记录跳过。`metrics` 是销量/销售额/退货/退款/流量/广告销售额的原始值，缺失保留 null。`snapshot` 单列采集时库存与观察时间，不能当作业务日期的历史库存。
- `compare`: 传 `leftName,rightName`，返回 `{comparable,warnings,items}`。保守要求相同渠道、国家店铺和请求范围、匹配条件、粒度、查询商品、币种；期间等长且不重叠。只对两个期间都存在的真实商品身份生成对比，缺失不补零。指标仅在两侧均为数值时计算 delta，库存/可售天数不计算历史差值。不生成或合计父/子体总数，不跨币种合计。

质量提示保留有效零值，涵盖缺失关键字段、数值类型变化、分页数量不一致、重复实体，以及相同查询条件重采时观察到的字段变化和覆盖减少。提示说明观测差异，不推断真实业务下降原因。

OOXML 结构参考：[Microsoft SpreadsheetML document structure](https://learn.microsoft.com/en-us/office/open-xml/spreadsheet/structure-of-a-spreadsheetml-document)。`node --test tests/data.test.cjs` 验证配对、过滤、每日去重、严格对比、ZIP CRC/关系结构、CSV 保护及原始文件不变；可用 openpyxl 时额外用独立读取器验证工作簿。
