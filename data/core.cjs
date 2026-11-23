'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { workbook } = require('./xlsx.cjs');
const NAME = /^(browser|mcp)-(?!data-)[A-Za-z0-9][A-Za-z0-9_.-]*\.json$/;
const FIELDS = { '父ASIN':'parent_asin', ASIN:'asin', MSKU:'msku', SKU:'sku', SPU:'spu' };
const METRICS = ['volume','amount','return_goods_count','return_count','sessions_total','page_views_total','ad_sales_amount'];
const LABELS = { parent_asin:'父ASIN', asin:'ASIN', msku:'MSKU', seller_sku:'卖家SKU', sku:'SKU', local_sku:'本地SKU', fnsku:'FNSKU', local_name:'商品名称', currency_code:'币种', volume:'销量', amount:'销售额', return_goods_count:'退货量', return_count:'退款量', sessions_total:'总访客数', page_views_total:'总浏览量', ad_sales_amount:'广告销售额', afn_fulfillable_quantity:'可售库存（采集时快照）', available_days:'可售天数（采集时快照）', price:'价格', seller_name:'店铺', country:'国家', price_list:'关联MSKU（原始明细，不计入汇总）' };
function date(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0,10) !== value) throw new Error('无效日期');
  return value;
}
function rootPath(root) { if (typeof root !== 'string' || !path.isAbsolute(root)) throw new Error('必须指定绝对数据目录'); return path.resolve(root); }
function child(root, directory, name) {
  const resolvedRoot = rootPath(root), dir = path.join(resolvedRoot, directory);
  if (fs.existsSync(dir) && (fs.lstatSync(dir).isSymbolicLink() || path.relative(fs.realpathSync(resolvedRoot), fs.realpathSync(dir)).startsWith('..'))) throw new Error('数据目录路径无效');
  const file = path.join(dir, name);
  if (name && fs.existsSync(file) && (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink())) throw new Error('结果路径无效');
  return file;
}
function read(root, name) {
  if (typeof name !== 'string' || !NAME.test(name) || name.includes('..')) throw new Error('无效的采集记录文件名');
  const source = name.split('-')[0], dataName = `${source}-data-${name.slice(source.length+1)}`;
  let summary, payload;
  try { summary = JSON.parse(fs.readFileSync(child(root,'results',name),'utf8')); payload = JSON.parse(fs.readFileSync(child(root,'results',dataName),'utf8')); }
  catch { throw new Error('无法读取完整的采集结果对'); }
  if (summary.method !== source || summary.status !== 'ok' || !Array.isArray(payload.data?.list) || payload.data.list.some(r=>!r || typeof r !== 'object' || Array.isArray(r))) throw new Error('采集结果格式无效');
  if (!Array.isArray(summary.dates) || summary.dates.length !== 2 || date(summary.dates[0]) > date(summary.dates[1])) throw new Error('结果日期范围无效');
  const s = summary.input || {}, rows = payload.data.list;
  const currencies = [...new Set(rows.map(r=>r.currency_code).filter(v=>typeof v==='string' && v))].sort();
  const item = { name, savedAt: summary.fetchedAt || null, from:summary.dates[0], to:summary.dates[1], type:s.type || summary.query?.type || null, value:s.value || summary.query?.value || null,
    country: summary.appliedFilters?.country ?? s.country ?? null, shop:summary.appliedFilters?.shop ?? s.shop ?? null, source,
    currency:currencies.length === 1 && rows.every(r=>r.currency_code) ? currencies[0] : null, currencies, count:rows.length, quality:{warnings:[]} };
  const bundle = { name, dataName, summary, rows, item };
  item.quality.warnings = quality(bundle);
  return bundle;
}
function grain(b) { return b.summary.requestFilters?.summary_field || b.summary.query?.tab || b.item.type; }
function canonicalMembership(value, key = '') {
  // Seller/country membership is a set, not an ordered list. Keep all scope
  // metadata while making object property order and stable ID representation
  // immaterial. Do not canonicalize report rows or their metric arrays.
  if (Array.isArray(value)) {
    const members = value.map(item => canonicalMembership(item)).map(item => JSON.stringify(item));
    return [...new Set(members)].sort().map(item => JSON.parse(item));
  }
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(name => [name, canonicalMembership(value[name], name)]));
  if (value != null && ['sid', 'store_id', 'country_id', 'mid', 'seller_id'].includes(key)) return String(value);
  return value;
}
function identity(b,r) {
  const g = grain(b), field = FIELDS[g] || ({parent_asin:'parent_asin',asin:'asin',msku:'msku',sku:'sku',spu:'spu'}[g]);
  const value = field === 'sku' ? (r.sku ?? r.local_sku) : field === 'msku' ? (r.msku ?? r.seller_sku) : r[field];
  if (value == null || value === '') return null;
  // Retain row-level seller/market identity even when the requested range spans shops.
  const sellerId = r.sid ?? r.store_id;
  return JSON.stringify([g,String(value),sellerId == null ? null : String(sellerId),canonicalMembership(r.country ?? null),canonicalMembership(r.seller_store_countries ?? null)]);
}
function scope(b) {
  const s=b.summary, i=b.item;
  // Pagination offsets/page sizes are acquisition mechanics, never business scope.
  const f=s.requestFilters, list=value=>Array.isArray(value)?value.map(String).sort():value==null?null:String(value).split(',').sort();
  const unfiltered = allShopProducts(b);
  const actual=f ? {mids:list(f.mids),sids:list(f.sids),search_field:unfiltered ? null : f.search_field ?? null} : null;
  return JSON.stringify([i.source,i.country,i.shop,actual,grain(b),unfiltered ? null : s.input?.match ?? null,s.resolved?.identifiers?.slice().sort() ?? null]);
}
function allShopProducts(bundle) { return bundle.summary.input?.value === '' && Boolean(bundle.item.shop); }
function conditions(b) { return JSON.stringify([scope(b),b.item.type,b.item.value,b.item.from,b.item.to]); }
function quality(b) {
  const warnings = [], {item,rows,summary}=b;
  if (!item.savedAt || !Number.isFinite(Date.parse(item.savedAt))) warnings.push('缺少有效采集时间');
  if (!item.type || (!item.value && !allShopProducts(b))) warnings.push('缺少查询类型或查询值');
  if (rows.some(r=>!identity(b,r))) warnings.push('部分记录缺少对应粒度的商品标识');
  if (rows.some(r=>!r.currency_code)) warnings.push('部分记录缺少实际币种');
  if (item.currencies.length>1) warnings.push('包含多种币种，禁止跨币种合计');
  if (rows.some(r=>!Object.hasOwn(r,'volume') || !Object.hasOwn(r,'amount'))) warnings.push('部分记录缺少销量或销售额字段（输出结构可能变化）');
  if (rows.some(r=>METRICS.some(k=>r[k]!=null && typeof r[k]!=='number'))) warnings.push('部分数值指标类型发生变化，保留原值且不强制转换');
  if (summary.pagination && (summary.pagination.total !== rows.length || summary.pagination.collected !== rows.length)) warnings.push('分页覆盖数量与结果不一致');
  const ids=rows.map(r=>identity(b,r) ? JSON.stringify([identity(b,r),r.currency_code ?? null]) : null).filter(Boolean); if (new Set(ids).size!==ids.length) warnings.push('相同粒度商品标识重复，禁止重复累计');
  return warnings;
}
function bundles(root) {
  const dir=child(root,'results',''); if (!fs.existsSync(dir)) return [];
  const found = fs.readdirSync(dir).filter(n=>NAME.test(n)).flatMap(n=>{ try{return [read(root,n)];}catch{return [];} });
  found.sort((a,b)=>String(a.item.savedAt).localeCompare(String(b.item.savedAt)) || a.name.localeCompare(b.name));
  const prior=new Map();
  for (const b of found) {
    const key=conditions(b), old=prior.get(key);
    if(old) {
      const oldIds=new Set(old.rows.map(r=>identity(old,r)).filter(Boolean)), ids=new Set(b.rows.map(r=>identity(b,r)).filter(Boolean));
      if(b.rows.length<old.rows.length || [...oldIds].some(id=>!ids.has(id))) b.item.quality.warnings.push('相同查询条件的观测覆盖减少，请核对筛选或采集完整性');
      const keys=x=>[...new Set(x.rows.flatMap(r=>Object.keys(r)))].sort().join('|');
      if(keys(old)!==keys(b)) b.item.quality.warnings.push('相同查询条件的输出字段结构发生变化');
    }
    prior.set(key,b);
  }
  return found.reverse();
}
function history(root, filters={}) {
  if(!filters || typeof filters!=='object' || Array.isArray(filters)) throw new Error('筛选参数无效');
  for(const [key,value] of Object.entries(filters)) if(!['search','country','shop','source','from','to'].includes(key) || typeof value!=='string') throw new Error('筛选参数无效');
  if(filters.source && !['browser','mcp'].includes(filters.source)) throw new Error('来源参数无效');
  if(filters.from) date(filters.from); if(filters.to) date(filters.to); if(filters.from && filters.to && filters.from>filters.to) throw new Error('日期范围无效');
  const items=bundles(root).map(b=>b.item).filter(i=> (!filters.source || i.source===filters.source) && (!filters.country || i.country===filters.country) && (!filters.shop || i.shop===filters.shop)
    && (!filters.from || i.from>=filters.from) && (!filters.to || i.to<=filters.to) && (!filters.search || [i.name,i.value,i.type,i.country,i.shop].join(' ').toLowerCase().includes(filters.search.toLowerCase())));
  return {items,count:items.length};
}
function daily(root) {
  const facts=new Map(), warnings=[], all=bundles(root); let skippedRolling=0;
  for(const b of all.slice().reverse()) {
    if(b.item.from!==b.item.to) {skippedRolling++;continue;}
    const ids=b.rows.map(r=>identity(b,r)), keys=b.rows.map((r,i)=>JSON.stringify([ids[i],r.currency_code ?? null])), duplicates=new Set(keys.filter((id,i)=>keys.indexOf(id)!==i));
    for(const [n,row] of b.rows.entries()) {
      const id=ids[n]; if(!id || !row.currency_code || duplicates.has(keys[n]) || !b.item.savedAt || !Number.isFinite(Date.parse(b.item.savedAt))) {warnings.push(`${b.name}: 缺少唯一标识、币种或时间，已跳过不确定记录`);continue;}
      const key=JSON.stringify([b.item.from,scope(b),id,row.currency_code]);
      facts.set(key,{date:b.item.from,identity:id,grain:grain(b),country:b.item.country,shop:b.item.shop,currency:row.currency_code,source:b.item.source,name:b.name,savedAt:b.item.savedAt,
        entity:JSON.parse(id)[1],metrics:Object.fromEntries(METRICS.map(k=>[k,row[k] ?? null])),quality:b.item.quality,
        snapshot:{afn_fulfillable_quantity:row.afn_fulfillable_quantity ?? null,observedAt:b.item.savedAt}});
    }
  }
  const items=[...facts.values()].sort((a,b)=>b.date.localeCompare(a.date)||a.identity.localeCompare(b.identity));
  return {items,count:items.length,skippedRolling,warnings:[...new Set(warnings)]};
}
function compare(root,leftName,rightName) {
  const a=read(root,leftName), b=read(root,rightName), warnings=[];
  if(scope(a)!==scope(b)) warnings.push('来源、国家店铺范围、匹配条件或统计粒度不一致');
  if(!a.item.type || !b.item.type || a.item.type!==b.item.type ||
    !(allShopProducts(a) && allShopProducts(b)) && (!a.item.value || a.item.value!==b.item.value)) warnings.push('查询商品条件不一致或缺失');
  const days=x=>(Date.parse(x.item.to)-Date.parse(x.item.from))/86400000+1;
  if(days(a)!==days(b)) warnings.push('日期区间天数不一致');
  if(a.item.from<=b.item.to && b.item.from<=a.item.to) warnings.push('日期区间重叠，不能作为独立期间对比');
  for(const x of [a,b]) {
    const ids=x.rows.map(r=>identity(x,r)), keys=x.rows.map((r,i)=>JSON.stringify([ids[i],r.currency_code ?? null]));
    if(ids.some(id=>!id) || new Set(keys).size!==keys.length) warnings.push('商品标识缺失或重复');
    if(x.rows.some(r=>!r.currency_code)) warnings.push('实际币种缺失');
  }
  if(warnings.length) return {comparable:false,warnings:[...new Set(warnings)],items:[]};
  const index=x=>new Map(x.rows.map(row=>[JSON.stringify([identity(x,row),row.currency_code]),row])), left=index(a), right=index(b), items=[];
  const identities=x=>new Set(x.rows.map(r=>identity(x,r))), leftIds=identities(a), rightIds=identities(b);
  for(const key of new Set([...left.keys(),...right.keys()])) {
    const [id]=JSON.parse(key), l=left.get(key), r=right.get(key);
    if(!l || !r) {warnings.push((!l?leftIds:rightIds).has(id)?'相同商品实际币种不一致':'部分商品仅存在于一个期间，缺失不作为零');continue;}
    items.push({identity:id,entity:JSON.parse(id)[1],grain:grain(a),currency:l.currency_code,leftName,rightName,from:a.item.from,to:b.item.to,
      metrics:Object.fromEntries(METRICS.map(k=>{const lv=l[k]??null,rv=r[k]??null;return [k,{left:lv,right:rv,delta:typeof lv==='number'&&typeof rv==='number'?rv-lv:null}];}))});
  }
  if(warnings.includes('相同商品实际币种不一致')) return {comparable:false,warnings:[...new Set(warnings)],items:[]};
  warnings.push('库存及可售天数是各次采集时快照，不作历史库存差值');
  return {comparable:items.length>0,warnings:[...new Set(warnings)],items};
}
function table(objects) {const keys=[...new Set(objects.flatMap(o=>Object.keys(o)))]; return [keys.map(k=>LABELS[k]||k),...objects.map(o=>keys.map(k=>Object.hasOwn(o,k)?o[k]:null))];}
function csvCell(value) {
  let s=value==null?'\\N':typeof value==='object'?JSON.stringify(value):String(value);
  if(typeof value==='string' && (/^[\s\uFEFF]*[=+\-@]/.test(s) || /^[\t\r\n]/.test(s) || /^\s*\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\s*$/.test(s))) s="'"+s;
  // Escape the null marker and its escape prefix so literal strings remain distinguishable.
  if(typeof value==='string' && s.startsWith('\\')) s='\\'+s;
  return '"'+s.replace(/"/g,'""')+'"';
}
function exportResult(root,name,format) {
  if(!['xlsx','csv'].includes(format)) throw new Error('导出格式无效');
  const b=read(root,name), prefix={ '采集文件':name,'来源':b.item.source,'采集时间':b.item.savedAt,'开始日期':b.item.from,'结束日期':b.item.to,'国家范围':b.item.country,'店铺范围':b.item.shop,'统计粒度':grain(b) };
  const main=b.rows.map((row,n)=>({...row,...prefix,'汇总行号':n+1}));
  const linked=b.rows.flatMap((row,n)=>(Array.isArray(row.price_list)?row.price_list:[]).map(child=>({'汇总行号':n+1,'父商品标识':identity(b,row),...child})));
  const info=table([{...prefix,'币种列表':b.item.currencies,'警告':b.item.quality.warnings,'空值说明':'XLSX 空单元格为 null；CSV \\N 为 null，字面反斜线文本加一个反斜线转义；数字 0 保持为 0','统计说明':'汇总与关联MSKU独立展示，不相加；库存为采集时快照；CSV 仅含汇总并保留原始关联明细 JSON'}]);
  const sheets=[{name:'汇总',rows:table(main)},{name:'关联MSKU',rows:table(linked)},{name:'采集信息',rows:info}];
  const filename=`${name.slice(0,-5)}-${crypto.randomUUID()}.${format}`, target=child(root,'exports',filename);
  fs.mkdirSync(path.dirname(target),{recursive:true});
  const content=format==='xlsx'?workbook(sheets):'\uFEFF'+sheets[0].rows.map(row=>row.map(csvCell).join(',')).join('\r\n')+'\r\n';
  fs.writeFileSync(target,content,{flag:'wx'});
  return {path:target,rows:b.rows.length,format,sheets:format==='xlsx'?sheets.map(s=>s.name):['汇总']};
}
module.exports={history,daily,compare,exportResult,read,date};
