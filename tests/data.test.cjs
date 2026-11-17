'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const {execute}=require('../data/cli.cjs');
const {crc32}=require('../data/xlsx.cjs');
function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pulsar-data-')); fs.mkdirSync(path.join(root,'results'));
  t.after(()=>{assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));assert.ok(path.basename(root).startsWith('pulsar-data-'));fs.rmSync(root,{recursive:true,force:true});});return root;
}
function pair(root,id,options={}) {
  const source=options.source||'browser', name=`${source}-${id}.json`, dates=options.dates||['2025-01-01','2025-01-01'];
  const summary={method:source,status:'ok',input:{type:'父ASIN',value:'DEMO-PARENT',country:'加拿大',shop:'示例店铺',match:'精确',...options.input},query:{tab:'父ASIN'},dates,fetchedAt:options.savedAt||'2025-02-01T00:00:00Z'};
  const rows=options.rows||[{parent_asin:'DEMO-PARENT',currency_code:'CAD',volume:0,amount:null,local_name:'示例 泳装',price_list:[{seller_sku:'00123',volume:0,price:'=1+1'}]}];
  fs.writeFileSync(path.join(root,'results',name),JSON.stringify(summary));fs.writeFileSync(path.join(root,'results',`${source}-data-${id}.json`),JSON.stringify({data:{list:rows}}));return name;
}
function unzipStored(buffer) {
  const files={};let offset=0;
  while(buffer.readUInt32LE(offset)===0x04034b50) {
    assert.equal(buffer.readUInt16LE(offset+8),0);
    const length=buffer.readUInt32LE(offset+18), names=buffer.readUInt16LE(offset+26), extra=buffer.readUInt16LE(offset+28);
    const name=buffer.subarray(offset+30,offset+30+names).toString('utf8'), start=offset+30+names+extra, body=buffer.subarray(start,start+length);
    assert.equal(crc32(body),buffer.readUInt32LE(offset+14));files[name]=body.toString('utf8');offset=start+length;
  }
  assert.equal(buffer.readUInt32LE(offset),0x02014b50);assert.equal(buffer.readUInt32LE(buffer.length-22),0x06054b50);return files;
}
test('history filters paired channels, ignores partial files, detects quality drift without losing zeros',t=>{
  const root=fixture(t), first=pair(root,'a');
  pair(root,'b',{source:'mcp',input:{country:'德国'},rows:[{parent_asin:'DEMO-PARENT',currency_code:'EUR',volume:2,amount:20}]});
  fs.writeFileSync(path.join(root,'results','browser-unpaired.json'),'{}');
  assert.equal(execute({action:'history'},root).count,2);
  assert.equal(execute({action:'history',filters:{search:'DEMO-PARENT',country:'加拿大',source:'browser',from:'2025-01-01',to:'2025-01-01'}},root).items[0].name,first);
  assert.deepEqual(execute({action:'history',filters:{source:'browser'}},root).items[0].quality.warnings,[]);
  pair(root,'c',{savedAt:'2025-02-02T00:00:00Z',rows:[]});
  const warnings=execute({action:'history'},root).items.find(i=>i.name==='browser-c.json').quality.warnings;
  assert.ok(warnings.some(w=>w.includes('覆盖减少'))); assert.ok(warnings.some(w=>w.includes('结构发生变化')));
  assert.throws(()=>execute({action:'history',filters:{from:'2025-02-31'}},root),/日期/);
});
test('daily selects latest exact one-day acquisition per entity/scope/currency/source without rolling subtraction',t=>{
  const root=fixture(t);pair(root,'old');
  const latest=pair(root,'new',{savedAt:'2025-02-02T00:00:00Z',rows:[{parent_asin:'DEMO-PARENT',currency_code:'CAD',volume:4,amount:0}]});
  pair(root,'rolling',{dates:['2025-01-01','2025-01-30']}); pair(root,'mcp',{source:'mcp'});
  const result=execute({action:'daily'},root);assert.equal(result.skippedRolling,1);assert.equal(result.count,2);
  assert.equal(result.items.find(i=>i.source==='browser').name,latest);assert.equal(result.items.find(i=>i.source==='browser').metrics.amount,0);
  assert.equal(result.items.find(i=>i.source==='mcp').metrics.amount,null);
});
test('comparison aligns identity and actual currency, keeps missing unknown, rejects overlap and incompatible scope',t=>{
  const root=fixture(t), left=pair(root,'left'), right=pair(root,'right',{dates:['2025-01-02','2025-01-02'],rows:[{parent_asin:'DEMO-PARENT',currency_code:'CAD',volume:2,amount:20}]});
  let result=execute({action:'compare',leftName:left,rightName:right},root);
  assert.equal(result.comparable,true);assert.equal(result.items[0].metrics.volume.delta,2);assert.equal(result.items[0].metrics.amount.delta,null);assert.equal(result.items[0].metrics.afn_fulfillable_quantity,undefined);
  const overlap=pair(root,'overlap');assert.equal(execute({action:'compare',leftName:left,rightName:overlap},root).comparable,false);
  const foreign=pair(root,'foreign',{dates:['2025-01-02','2025-01-02'],input:{shop:'其他示例店铺'}});assert.equal(execute({action:'compare',leftName:left,rightName:foreign},root).comparable,false);
  const converted=pair(root,'converted',{dates:['2025-01-02','2025-01-02'],rows:[{parent_asin:'DEMO-PARENT',currency_code:'USD',volume:0,amount:0}]});assert.equal(execute({action:'compare',leftName:left,rightName:converted},root).comparable,false);
});
test('actual mixed row currencies remain separate daily facts regardless of selected input currency',t=>{
  const root=fixture(t);pair(root,'mixed',{input:{currency:'USD'},rows:[{parent_asin:'DEMO-PARENT',currency_code:'CAD',volume:0,amount:null},{parent_asin:'DEMO-PARENT',currency_code:'EUR',volume:2,amount:20}]});
  const h=execute({action:'history'},root).items[0];assert.equal(h.currency,null);assert.deepEqual(h.currencies,['CAD','EUR']);
  const daily=execute({action:'daily'},root);assert.equal(daily.count,2);assert.deepEqual(daily.items.map(i=>i.currency).sort(),['CAD','EUR']);
});
test('seller/country membership order and object key order do not split daily identity or cross-period alignment',t=>{
  const root=fixture(t);
  const oldRow={parent_asin:'DEMO-PARENT',sid:101,currency_code:'CAD',volume:2,amount:20,seller_store_countries:[{sid:101,seller_name:'合成店铺甲',country:'加拿大'},{country:'加拿大',seller_name:'合成店铺乙',sid:102}]};
  const newRow={...oldRow,sid:'101',volume:7,amount:70,seller_store_countries:[{seller_name:'合成店铺乙',sid:'102',country:'加拿大'},{country:'加拿大',sid:'101',seller_name:'合成店铺甲'}]};
  pair(root,'membership-old',{savedAt:'2025-02-01T00:00:00Z',rows:[oldRow]});
  const latest=pair(root,'membership-new',{savedAt:'2025-02-02T00:00:00Z',rows:[newRow]});
  let result=execute({action:'daily'},root);assert.equal(result.count,1);assert.equal(result.items[0].metrics.volume,7);assert.equal(result.items[0].name,latest);
  assert.ok(!execute({action:'history'},root).items.find(i=>i.name===latest).quality.warnings.some(w=>w.includes('覆盖减少')));
  const next=pair(root,'membership-next',{dates:['2025-01-02','2025-01-02'],savedAt:'2025-02-03T00:00:00Z',rows:[{...oldRow,volume:9,amount:90}]});
  result=execute({action:'compare',leftName:latest,rightName:next},root);assert.equal(result.comparable,true);assert.equal(result.items.length,1);assert.equal(result.items[0].metrics.volume.delta,2);
  const different=pair(root,'membership-different',{savedAt:'2025-02-04T00:00:00Z',rows:[{...newRow,seller_store_countries:[{sid:'101',seller_name:'合成店铺甲',country:'加拿大'},{sid:'103',seller_name:'合成店铺丙',country:'加拿大'}]}]});
  result=execute({action:'daily'},root);assert.equal(result.items.filter(i=>i.date==='2025-01-01').length,2,'different actual membership must remain separate');
  assert.equal(execute({action:'compare',leftName:different,rightName:next},root).comparable,false);
});
test('exports genuine three-sheet OOXML and safe Unicode CSV preserving numbers, null and source pairs',t=>{
  const root=fixture(t), name=pair(root,'export',{rows:[{parent_asin:'DEMO-PARENT',currency_code:'CAD',volume:0,amount:null,local_name:'=HYPERLINK("https://example.invalid")',sku:'00123',price_list:[{seller_sku:'00123',volume:0}]}]});
  const before=fs.readFileSync(path.join(root,'results',name));
  const x=execute({action:'export',name,format:'xlsx'},root), files=unzipStored(fs.readFileSync(x.path));
  assert.deepEqual(x.sheets,['汇总','关联MSKU','采集信息']);assert.equal(x.rows,1);
  assert.match(files['xl/workbook.xml'],/name="关联MSKU"/);assert.match(files['xl/worksheets/sheet1.xml'],/t="inlineStr"><is><t xml:space="preserve">=HYPERLINK/);
  assert.doesNotMatch(files['xl/worksheets/sheet1.xml'],/<f>/);assert.match(files['xl/worksheets/sheet1.xml'],/<v>0<\/v>/);
  assert.match(files['xl/_rels/workbook.xml.rels'],/worksheets\/sheet3.xml/);
  const csv=execute({action:'export',name,format:'csv'},root);const text=fs.readFileSync(csv.path,'utf8');assert.ok(text.startsWith('\uFEFF'));assert.ok(text.includes("'=HYPERLINK"));assert.ok(text.includes("'00123"));assert.ok(text.includes('"\\N"'));assert.ok(text.includes('"0"'));
  assert.deepEqual(fs.readFileSync(path.join(root,'results',name)),before);
  assert.notEqual(execute({action:'export',name,format:'csv'},root).path,csv.path);
  // Optional independent reader check; structural assertions above are always required.
  const available=spawnSync('python',['-c','import openpyxl'],{encoding:'utf8'});
  if(available.status===0) {
    const opened=spawnSync('python',['-c',"import openpyxl,sys; w=openpyxl.load_workbook(sys.argv[1],read_only=True); assert w.sheetnames==['汇总','关联MSKU','采集信息']; rows=list(w.worksheets[0].values); d=dict(zip(rows[0],rows[1])); assert d['销量']==0 and d['销售额'] is None and d['SKU']=='00123'; assert d['商品名称'].startswith('=HYPERLINK'); assert w.worksheets[1].max_row is None or w.worksheets[1].max_row==2",x.path],{encoding:'utf8'});
    assert.equal(opened.status,0,opened.stderr);
  }
});
test('validates basenames and CLI emits exactly one JSON response without leaking parse contents',t=>{
  const root=fixture(t), name=pair(root,'cli');
  for(const invalid of ['../browser-cli.json','browser-data-cli.json','browser-..secret.json','C:\\secret.json']) assert.throws(()=>execute({action:'export',name:invalid,format:'xlsx'},root));
  const cli=path.join(__dirname,'../data/cli.cjs');
  const run=spawnSync(process.execPath,[cli,'--data',root],{input:JSON.stringify({action:'history'}),encoding:'utf8'});assert.equal(run.status,0);assert.equal(JSON.parse(run.stdout).items[0].name,name);assert.equal(run.stderr,'');
  const bad=spawnSync(process.execPath,[cli,'--data',root],{input:'{"secret":"do-not-echo"',encoding:'utf8'});assert.equal(bad.status,1);assert.equal(typeof JSON.parse(bad.stdout).error,'string');assert.ok(!bad.stdout.includes('do-not-echo'));
});
