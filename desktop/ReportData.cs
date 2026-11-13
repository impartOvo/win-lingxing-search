using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using System.Web.Script.Serialization;

namespace ProductDiagnosis
{
    internal static class ReportData
    {
        internal static readonly CultureInfo DisplayCulture = CultureInfo.GetCultureInfo("zh-CN");

        internal static object Value(object source, params string[] path)
        {
            object current = source;
            foreach (string key in path)
            {
                var dictionary = current as IDictionary<string, object>;
                if (dictionary == null || !dictionary.TryGetValue(key, out current)) return null;
            }
            return current;
        }

        internal static string Text(object value)
        {
            return value == null ? "" : Convert.ToString(value, CultureInfo.InvariantCulture);
        }

        internal static string TextAt(object source, params string[] path) { return Text(Value(source, path)); }

        internal static IEnumerable<object> Items(object value)
        {
            var list = value as IList;
            if (list != null) foreach (object item in list) if (item != null) yield return item;
        }

        internal static double? Number(object value)
        {
            double number;
            if (value == null || !double.TryParse(Text(value), NumberStyles.Float,
                CultureInfo.InvariantCulture, out number) || double.IsNaN(number) || double.IsInfinity(number)) return null;
            return number;
        }

        internal static string Format(object value, string format = "N0")
        {
            double? number = Number(value);
            return number.HasValue ? number.Value.ToString(format, DisplayCulture) : "—";
        }

        internal static string Rate(object value)
        {
            double? number = Number(value);
            return number.HasValue ? (number.Value * 100).ToString("N2", DisplayCulture) + "%" : "—";
        }

        internal static object ReadJson(string path)
        {
            return Serializer().DeserializeObject(File.ReadAllText(path, Encoding.UTF8));
        }

        internal static JavaScriptSerializer Serializer()
        {
            return new JavaScriptSerializer { MaxJsonLength = 128 * 1024 * 1024, RecursionLimit = 256 };
        }

        internal static string DataPath(string summaryPath)
        {
            string name = Path.GetFileName(summaryPath);
            if (!name.StartsWith("browser-", StringComparison.Ordinal) || name.StartsWith("browser-data-", StringComparison.Ordinal))
                throw new InvalidDataException("请选择 browser- 开头的采集记录。");
            return Path.Combine(Path.GetDirectoryName(summaryPath), "browser-data-" + name.Substring(8));
        }

        internal static CollectionBundle ReadBundle(string path)
        {
            object summary = ReadJson(path);
            if (TextAt(summary, "method") != "browser" || TextAt(summary, "status") != "ok")
                throw new InvalidDataException("这次采集尚未确认成功，无法展示结果。");
            string dataPath = DataPath(path);
            if (!File.Exists(dataPath)) throw new FileNotFoundException("找不到这次采集对应的数据文件。", dataPath);
            object payload = ReadJson(dataPath);
            var bundle = new CollectionBundle {
                Summary = summary, SummaryPath = Path.GetFullPath(path), DataPath = Path.GetFullPath(dataPath),
                Rows = new List<ReportRecord>()
            };
            foreach (object row in Items(Value(payload, "data", "list")))
            {
                string identifier = Identifier(row, summary);
                string scope = Scope(row, summary);
                bundle.Rows.Add(new ReportRecord {
                    Raw = row, Identifier = identifier, Scope = scope,
                    Display = identifier + " · " + scope, ProductName = ProductName(row)
                });
            }
            return bundle;
        }

        private static string Identifier(object row, object summary)
        {
            string field;
            switch (TextAt(summary, "query", "tab"))
            {
                case "ASIN": field = "asin"; break;
                case "MSKU": field = "msku"; break;
                case "SKU": field = "sku"; break;
                case "SPU": field = "spu"; break;
                default: field = "parent_asin"; break;
            }
            string identifier = TextAt(row, field);
            if (!string.IsNullOrWhiteSpace(identifier)) return identifier;
            foreach (string key in new[] { "parent_asin", "asin", "msku", "sku", "spu" })
            {
                identifier = TextAt(row, key);
                if (!string.IsNullOrWhiteSpace(identifier)) return identifier;
            }
            return TextAt(summary, "input", "value");
        }

        private static string ProductName(object row)
        {
            string name = TextAt(row, "local_name");
            if (!string.IsNullOrWhiteSpace(name)) return name;
            var names = Items(Value(row, "spu_spu_names")).Select(x => TextAt(x, "spu_name")).Where(x => x.Length > 0).Distinct().ToArray();
            if (names.Length > 0) return string.Join(" / ", names);
            name = TextAt(row, "item_name");
            return name.Length > 0 ? name : "未返回品名";
        }

        private static string Scope(object row, object summary)
        {
            var scopes = Items(Value(row, "seller_store_countries")).Select(x =>
                string.Join(" · ", new[] { TextAt(x, "seller_name"), TextAt(x, "country") }.Where(y => y.Length > 0))).Where(x => x.Length > 0).Distinct().ToArray();
            if (scopes.Length > 0) return string.Join(" / ", scopes);
            string country = TextAt(summary, "input", "country");
            string shop = TextAt(summary, "input", "shop");
            return (country.Length > 0 ? country : "全部国家") + " · " + (shop.Length > 0 ? shop : "全部店铺");
        }

        internal static List<VariantRecord> Variants(object row, string currency)
        {
            return Items(Value(row, "price_list")).Select(x => new VariantRecord {
                ProductName = TextAt(x, "local_name"), MSKU = TextAt(x, "seller_sku"), SKU = TextAt(x, "local_sku"),
                Store = string.Join(" · ", new[] { TextAt(x, "seller_name"), TextAt(x, "country") }.Where(y => y.Length > 0)),
                Sales = Number(Value(x, "volume")), Price = Number(Value(x, "price")), Currency = currency
            }).ToList();
        }

        internal static List<HistoryRecord> History(string directory)
        {
            var rows = new List<HistoryRecord>();
            if (!Directory.Exists(directory)) return rows;
            foreach (string path in Directory.GetFiles(directory, "browser-*.json").Where(x => !Path.GetFileName(x).StartsWith("browser-data-", StringComparison.Ordinal)).OrderByDescending(x => Path.GetFileName(x), StringComparer.Ordinal))
            {
                try
                {
                    object summary = ReadJson(path);
                    if (TextAt(summary, "method") != "browser" || TextAt(summary, "status") != "ok" || !File.Exists(DataPath(path))) continue;
                    string country = TextAt(summary, "input", "country");
                    string shop = TextAt(summary, "input", "shop");
                    rows.Add(new HistoryRecord {
                        SavedAt = DateTimeOffset.Parse(TextAt(summary, "fetchedAt"), CultureInfo.InvariantCulture).ToLocalTime().ToString("yyyy-MM-dd HH:mm"),
                        Type = TextAt(summary, "input", "type"), Value = TextAt(summary, "input", "value"),
                        Country = country.Length > 0 ? country : "全部国家", Shop = shop.Length > 0 ? shop : "全部店铺",
                        Dates = string.Join(" — ", Items(Value(summary, "dates")).Select(Text)),
                        Count = Number(Value(summary, "pagination", "collected")), Path = path
                    });
                }
                catch (Exception) { }
            }
            return rows;
        }
    }

    public sealed class ReportRecord
    {
        public string Display { get; set; }
        public string Identifier { get; set; }
        public string ProductName { get; set; }
        public string Scope { get; set; }
        public object Raw { get; set; }
    }

    public sealed class VariantRecord
    {
        public string ProductName { get; set; }
        public string MSKU { get; set; }
        public string SKU { get; set; }
        public string Store { get; set; }
        public double? Sales { get; set; }
        public double? Price { get; set; }
        public string Currency { get; set; }
    }

    public sealed class HistoryRecord
    {
        public string SavedAt { get; set; }
        public string Type { get; set; }
        public string Value { get; set; }
        public string Country { get; set; }
        public string Shop { get; set; }
        public string Dates { get; set; }
        public double? Count { get; set; }
        public string Path { get; set; }
    }

    internal sealed class CollectionBundle
    {
        internal object Summary;
        internal string SummaryPath;
        internal string DataPath;
        internal List<ReportRecord> Rows;
    }
}
