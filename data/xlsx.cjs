'use strict';
// Minimal SpreadsheetML package, authored from the Microsoft Open XML structure docs:
// https://learn.microsoft.com/en-us/office/open-xml/spreadsheet/structure-of-a-spreadsheetml-document
const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const xml = s => String(s).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
function zip(files) {
  const parts = [], central = []; let offset = 0;
  for (const [name, value] of Object.entries(files)) {
    const filename = Buffer.from(name), body = Buffer.from(value), crc = crc32(body);
    const head = Buffer.alloc(30); head.writeUInt32LE(0x04034b50); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x800, 6); head.writeUInt16LE(0x21, 12);
    head.writeUInt32LE(crc, 14); head.writeUInt32LE(body.length, 18); head.writeUInt32LE(body.length, 22); head.writeUInt16LE(filename.length, 26);
    const entry = Buffer.alloc(46); entry.writeUInt32LE(0x02014b50); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(0x800, 8); entry.writeUInt16LE(0x21, 14);
    entry.writeUInt32LE(crc, 16); entry.writeUInt32LE(body.length, 20); entry.writeUInt32LE(body.length, 24); entry.writeUInt16LE(filename.length, 28); entry.writeUInt32LE(offset, 42);
    parts.push(head, filename, body); central.push(entry, filename); offset += head.length + filename.length + body.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}
function column(i) { let s = ''; for (i++; i; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + (i - 1) % 26) + s; return s; }
function sheet(rows) {
  if (rows.length > 1048576 || rows.some(r => r.length > 16384)) throw new Error('导出超过 Excel 行列限制');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="${NS}"><sheetData>${rows.map((row, i) => `<row r="${i + 1}">${row.map((value, j) => {
    if (value == null) return '';
    const ref = column(j) + (i + 1);
    if (typeof value === 'number' && Number.isFinite(value)) return `<c r="${ref}"><v>${value}</v></c>`;
    if (typeof value === 'boolean') return `<c r="${ref}" t="b"><v>${Number(value)}</v></c>`;
    const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
    if (text.length > 32767) throw new Error('单元格文本超过 Excel 限制，请使用原始 JSON');
    // inlineStr never executes user-controlled =,+,-,@ text as formulas.
    return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xml(text)}</t></is></c>`;
  }).join('')}</row>`).join('')}</sheetData></worksheet>`;
}
function workbook(sheets) {
  const files = {
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((s,i)=>`<Override PartName="/xl/worksheets/sheet${i+1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`,
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="${NS}" xmlns:r="${REL}"><sheets>${sheets.map((s,i)=>`<sheet name="${xml(s.name)}" sheetId="${i+1}" r:id="rId${i+1}"/>`).join('')}</sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((s,i)=>`<Relationship Id="rId${i+1}" Type="${REL}/worksheet" Target="worksheets/sheet${i+1}.xml"/>`).join('')}</Relationships>`
  };
  sheets.forEach((s,i) => files[`xl/worksheets/sheet${i+1}.xml`] = sheet(s.rows));
  return zip(files);
}
module.exports = { workbook, crc32 };
