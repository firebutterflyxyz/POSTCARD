// 名片夾 匯出：Excel（含照片）與「交給 Claude 辨識」批次包
// 本模組不直接碰 DOM：JSZip 類別與照片處理函式由呼叫端傳入，方便在 Node 測試。
import { FIELD_LABELS } from './core.js';

// ---------- Excel 欄位設定（要調整順序或刪除欄位，改這裡就好） ----------
const p2 = n => String(n).padStart(2, '0');
function fmtTime(iso) { if (!iso) return ''; const d = new Date(iso); if (isNaN(d)) return iso; return `${d.getFullYear()}/${p2(d.getMonth() + 1)}/${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`; }
const phoneText = p => `${p.value}${p.ext ? ' 分機 ' + p.ext : ''}`;
export const EXCEL_COLUMNS = [
  { key: 'seq', title: '序號', width: 6, num: true },
  { key: 'faces', title: '名片正反面', width: 30, image: 'faces' },
  { key: 'avatar', title: '大頭照', width: 15, image: 'avatar' },
  { key: 'category', title: '分類', width: 14, get: (c, x) => x.catName(c.categoryId) || '未分類' },
  { key: 'source', title: '來源', width: 22, get: c => c.source?.type === 'import' ? `由「${c.source.provider}」分享（${fmtTime(c.source.importedAt)} 匯入）` : '自行建立' },
  { key: 'note', title: '備註', width: 26, get: c => c.note || '' },
  { key: 'name', title: '姓名', width: 12, get: c => c.name || '' },
  { key: 'company', title: '公司', width: 26, get: c => c.company || '' },
  { key: 'dept', title: '部門', width: 14, get: c => c.dept || '' },
  { key: 'title', title: '職稱', width: 14, get: c => c.title || '' },
  { key: 'mobile', title: '手機', width: 16, get: c => (c.phones || []).filter(p => p.label === '手機').map(phoneText).join('\n') },
  { key: 'office', title: '公司電話（含分機）', width: 24, get: c => (c.phones || []).filter(p => p.label !== '手機').map(p => (p.label && p.label !== '公司' ? p.label + ' ' : '') + phoneText(p)).join('\n') },
  { key: 'email', title: 'Email', width: 28, get: c => (c.emails || []).map(e => (e.label ? e.label + ' ' : '') + e.value).join('\n') },
  { key: 'address', title: '地址', width: 30, get: c => c.address || '' },
  { key: 'website', title: '網站', width: 22, get: c => c.website || '' },
  { key: 'lineId', title: 'LINE ID', width: 14, get: c => c.lineId || '' },
  { key: 'tags', title: '標籤', width: 16, get: c => (c.tags || []).join('、') },
  { key: 'metDate', title: '認識日期', width: 12, get: c => (c.metDate || '').replace(/-/g, '/') },
  { key: 'metPlace', title: '認識場合', width: 20, get: c => c.metPlace || '' },
  { key: 'logs', title: '往來紀錄', width: 36, get: c => (c.logs || []).map(l => `${(l.date || '').replace(/-/g, '/')}　${l.text}`).join('\n') },
  { key: 'createdAt', title: '建立時間', width: 17, get: c => fmtTime(c.createdAt) },
  { key: 'updatedAt', title: '更新時間', width: 17, get: c => fmtTime(c.updatedAt) },
];

// ---------- XLSX 產生 ----------
const EMU = 9525; // 1 px
const xmlEsc = s => String(s ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function colName(i) { let s = ''; i++; while (i) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; }
const colPx = w => Math.floor(w * 7 + 5);

/**
 * @param cards 名片陣列（依此順序輸出）
 * @param opts.JSZip JSZip 類別
 * @param opts.catName id => 分類名稱
 * @param opts.loadImage async (photoId, maxW, maxH) => {bytes:Uint8Array, w, h} | null（已縮小的 JPEG）
 * @returns Promise<Uint8Array>
 */
export async function buildXlsx(cards, { JSZip, catName, loadImage, columns = EXCEL_COLUMNS, sheetName = '名片' }) {
  const zip = new JSZip();
  const ctx = { catName };
  const FACE_W = colPx(columns.find(c => c.image === 'faces')?.width || 30) - 14;
  const AV_BOX = colPx(columns.find(c => c.image === 'avatar')?.width || 15) - 14;
  const pics = []; // {col,row,offX,offY,w,h,rid}
  const media = [];
  const rows = [];
  // 表頭
  rows.push(`<row r="1" ht="24" customHeight="1">${columns.map((c, i) => `<c r="${colName(i)}1" t="inlineStr" s="2"><is><t>${xmlEsc(c.title)}</t></is></c>`).join('')}</row>`);
  for (let n = 0; n < cards.length; n++) {
    const card = cards[n]; const r = n + 2;
    let rowPx = 44;
    const cells = [];
    for (let i = 0; i < columns.length; i++) {
      const col = columns[i]; const ref = `${colName(i)}${r}`;
      if (col.num) { cells.push(`<c r="${ref}" s="1"><v>${n + 1}</v></c>`); continue; }
      if (col.image === 'faces') {
        let y = 6;
        for (const k of ['front', 'back']) {
          const id = card.photos?.[k]; if (!id) continue;
          const img = await loadImage(id, 900, 900);
          if (!img) continue;
          const w = FACE_W; const h = Math.round(img.h * w / img.w);
          media.push(img.bytes); pics.push({ col: i, row: r - 1, offX: 7, offY: y, w, h, rid: media.length, name: `${k === 'front' ? '正面' : '背面'} ${n + 1}` });
          y += h + 6;
        }
        rowPx = Math.max(rowPx, y);
        cells.push(`<c r="${ref}" s="1"/>`); continue;
      }
      if (col.image === 'avatar') {
        const id = card.photos?.avatar;
        if (id) {
          const img = await loadImage(id, 400, 400);
          if (img) {
            const s = Math.min(AV_BOX / img.w, AV_BOX / img.h);
            const w = Math.round(img.w * s), h = Math.round(img.h * s);
            media.push(img.bytes); pics.push({ col: i, row: r - 1, offX: 7, offY: 6, w, h, rid: media.length, name: `大頭照 ${n + 1}` });
            rowPx = Math.max(rowPx, h + 12);
          }
        }
        cells.push(`<c r="${ref}" s="1"/>`); continue;
      }
      const v = col.get(card, ctx);
      const lines = String(v).split('\n').length;
      rowPx = Math.max(rowPx, Math.min(400, lines * 20 + 10));
      cells.push(v === '' ? `<c r="${ref}" s="1"/>` : `<c r="${ref}" t="inlineStr" s="1"><is><t xml:space="preserve">${xmlEsc(v)}</t></is></c>`);
    }
    rows.push(`<row r="${r}" ht="${(rowPx * 0.75).toFixed(1)}" customHeight="1">${cells.join('')}</row>`);
  }
  const lastCol = colName(columns.length - 1);
  const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="jpeg" ContentType="image/jpeg"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${pics.length ? '<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>' : ''}<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`);
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  zip.file('docProps/core.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>名片夾匯出</dc:title><dc:creator>名片夾</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`);
  zip.file('docProps/app.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>名片夾</Application></Properties>`);
  zip.file('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook ${NS}><bookViews><workbookView/></bookViews><sheets><sheet name="${xmlEsc(sheetName)}" sheetId="1" r:id="rId1"/></sheets><definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'${xmlEsc(sheetName)}'!$A$1:$${lastCol}$${cards.length + 1}</definedName></definedNames></workbook>`);
  zip.file('xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`);
  zip.file('xl/styles.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="微軟正黑體"/><family val="2"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="微軟正黑體"/><family val="2"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1F6F5C"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color rgb="FFD0D5D2"/></left><right style="thin"><color rgb="FFD0D5D2"/></right><top style="thin"><color rgb="FFD0D5D2"/></top><bottom style="thin"><color rgb="FFD0D5D2"/></bottom><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf><xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`);
  zip.file('xl/worksheets/sheet1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet ${NS}><dimension ref="A1:${lastCol}${cards.length + 1}"/><sheetViews><sheetView workbookViewId="0" zoomScale="100"><pane xSplit="${Math.min(columns.length, 1)}" ySplit="1" topLeftCell="B2" activePane="bottomRight" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="16.5"/><cols>${columns.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width}" customWidth="1"/>`).join('')}</cols><sheetData>${rows.join('')}</sheetData><autoFilter ref="A1:${lastCol}${cards.length + 1}"/><pageMargins left="0.4" right="0.4" top="0.5" bottom="0.5" header="0.3" footer="0.3"/><pageSetup orientation="landscape" paperSize="9"/>${pics.length ? '<drawing r:id="rId1"/>' : ''}</worksheet>`);
  if (pics.length) {
    zip.file('xl/worksheets/_rels/sheet1.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/></Relationships>`);
    zip.file('xl/drawings/drawing1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${pics.map((p, k) =>
      `<xdr:oneCellAnchor><xdr:from><xdr:col>${p.col}</xdr:col><xdr:colOff>${p.offX * EMU}</xdr:colOff><xdr:row>${p.row}</xdr:row><xdr:rowOff>${p.offY * EMU}</xdr:rowOff></xdr:from><xdr:ext cx="${p.w * EMU}" cy="${p.h * EMU}"/><xdr:pic><xdr:nvPicPr><xdr:cNvPr id="${k + 2}" name="${xmlEsc(p.name)}"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr><xdr:blipFill><a:blip r:embed="rId${p.rid}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill><xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${p.w * EMU}" cy="${p.h * EMU}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic><xdr:clientData/></xdr:oneCellAnchor>`).join('')}</xdr:wsDr>`);
    zip.file('xl/drawings/_rels/drawing1.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${media.map((_, k) => `<Relationship Id="rId${k + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image${k + 1}.jpeg"/>`).join('')}</Relationships>`);
    media.forEach((b, k) => zip.file(`xl/media/image${k + 1}.jpeg`, b));
  }
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}

// ---------- 交給 Claude 辨識（批次） ----------
export const FORMAT_CLAUDE_REQ = 'mingpianjia-claude-request';
export const CLAUDE_PROVIDER = 'Claude 辨識';

export function claudeInstructions(count, dateStr) {
  return `請 Claude 辨識這批名片（共 ${count} 張）

這個 zip 由「名片夾」App 匯出，用途是請 Claude 協助辨識名片文字。
「照片」資料夾內是名片照片；「名片清單.json」記錄每張名片的識別碼（id）、照片檔名，以及 App 目前已有的欄位（current）。

請依照下列規則辨識，並產生一個可以匯回名片夾的「名片包」JSON 檔：

1. 逐張查看正面與背面照片，兩面的資訊合併成同一筆名片，例如正面有姓名、背面有手機。
2. 每筆的 id 必須與名片清單中的 id 完全相同，不可自行產生或修改。
3. 只填照片上看得到的資訊。看不清楚、無法確定的欄位請留空字串 ""，不要猜測。
4. 電話與分機一律以文字保存，保留開頭的 0、國碼與原本的分隔符號。分機另外放在 ext。
5. phones[].label 只能是「手機」「公司」「傳真」「其他」之一；emails[].label 可留空。
6. 繁體中文名片請維持繁體，不要轉成簡體；中英文都有時，name、company、title 以中文為主。
7. 輸出時 photos 一律為 {}，不要放入照片。
8. 檔案名稱請用「名片包_Claude辨識_${dateStr}.json」，以可下載的檔案提供（不要只貼在對話裡）。

輸出格式（JSON，UTF-8）：
{
  "format": "mingpianjia-pack",
  "version": 1,
  "provider": { "name": "${CLAUDE_PROVIDER}" },
  "exportedAt": "（ISO 8601 時間）",
  "included": [],
  "photos": {},
  "cards": [
    {
      "id": "（與名片清單相同）",
      "name": "", "company": "", "dept": "", "title": "",
      "phones": [ { "label": "手機", "value": "0912-345-678", "ext": "" } ],
      "emails": [ { "label": "", "value": "name@example.com" } ],
      "address": "", "website": "", "lineId": "",
      "photos": {}
    }
  ]
}

最後請用一個表格列出每張名片辨識結果的摘要（序號、姓名、公司、你不確定而留空的欄位），方便使用者核對。

使用者拿到檔案後，會在名片夾「我的 → 匯入名片包」匯入。同一張名片會顯示新舊差異，由使用者決定是否採用。
`;
}

/**
 * @param opts.loadPhoto async (photoId) => {bytes, mime}
 * @returns Promise<Uint8Array> zip
 */
export async function buildClaudeZip(cards, { JSZip, loadPhoto, provider, dateStr }) {
  const zip = new JSZip();
  const list = [];
  let n = 0;
  for (const c of cards) {
    n++;
    const seq = String(n).padStart(3, '0');
    const entry = { seq: n, id: c.id, front: null, back: null, current: {
      name: c.name || '', company: c.company || '', dept: c.dept || '', title: c.title || '',
      phones: (c.phones || []).map(p => ({ label: p.label || '', value: p.value, ext: p.ext || '' })),
      emails: (c.emails || []).map(e => ({ label: e.label || '', value: e.value })),
      address: c.address || '', website: c.website || '', lineId: c.lineId || '',
    } };
    for (const [k, zh] of [['front', '正面'], ['back', '背面']]) {
      const id = c.photos?.[k]; if (!id) continue;
      const p = await loadPhoto(id); if (!p) continue;
      const fn = `${seq}_${zh}.jpg`;
      zip.file('照片/' + fn, p.bytes); entry[k] = '照片/' + fn;
    }
    list.push(entry);
  }
  zip.file('名片清單.json', JSON.stringify({ format: FORMAT_CLAUDE_REQ, version: 1, provider, createdAt: new Date().toISOString(), cards: list }, null, 2));
  zip.file('給Claude的說明.txt', claudeInstructions(cards.length, dateStr));
  return zip.generateAsync({ type: 'uint8array', compression: 'STORE' });
}

export const EXCEL_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export { FIELD_LABELS };
