// 執行：node --test tests/exporters.test.mjs（使用專案內附的 JSZip）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as C from '../js/core.js';
import * as X from '../js/exporters.js';
// 專案內附的 JSZip 是 UMD 格式，以 CommonJS 方式載入
const mod = { exports: {} };
new Function('module', 'exports', fs.readFileSync(new URL('../js/vendor/jszip.min.js', import.meta.url), 'utf8'))(mod, mod.exports);
const JSZip = mod.exports;

// 1x1 JPEG
const JPG = Uint8Array.from(Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64'));
const card = o => ({ ...C.emptyCard(), ...o });

test('Excel：欄位順序、全部欄位、正反面與大頭照嵌入', async () => {
  const a = card({ name: '陳怡君', company: '大和', note: '私人備註<&>', phones: [{ label: '手機', value: '0912-345-678' }, { label: '公司', value: '02-2700-1234', ext: '305' }],
    logs: [{ date: '2026-11-19', text: '開會' }], photos: { front: 'f', back: 'b', avatar: 'a' }, categoryId: 'c1' });
  const b = card({ company: '只有公司', photos: { front: null, back: null, avatar: null } });
  const out = await X.buildXlsx([a, b], { JSZip, catName: id => (id === 'c1' ? '物業管理' : ''), loadImage: async () => ({ bytes: JPG, w: 600, h: 340 }) });
  const z = await JSZip.loadAsync(out);
  const sheet = await z.file('xl/worksheets/sheet1.xml').async('string');
  const titles = [...sheet.matchAll(/<c r="[A-Z]+1"[^>]*><is><t>([^<]*)<\/t>/g)].map(m => m[1]);
  assert.deepEqual(titles.slice(0, 7), ['序號', '名片正反面', '大頭照', '分類', '來源', '備註', '姓名']);
  assert.equal(titles.length, X.EXCEL_COLUMNS.length);
  assert.ok(sheet.includes('私人備註&lt;&amp;&gt;'), '備註要匯出且正確跳脫');
  assert.ok(sheet.includes('02-2700-1234 分機 305'));
  assert.ok(sheet.includes('2026/11/19　開會'));
  assert.ok(sheet.includes('物業管理'));
  const media = Object.values(z.files).filter(f => !f.dir && f.name.startsWith('xl/media/'));
  assert.equal(media.length, 3, '正面、背面、大頭照共 3 張');
  const dr = await z.file('xl/drawings/drawing1.xml').async('string');
  const anchors = [...dr.matchAll(/<xdr:col>(\d+)<\/xdr:col><xdr:colOff>\d+<\/xdr:colOff><xdr:row>(\d+)<\/xdr:row><xdr:rowOff>(\d+)<\/xdr:rowOff>/g)].map(m => m.slice(1).map(Number));
  assert.equal(anchors[0][0], 1); assert.equal(anchors[1][0], 1, '正反面在同一欄');
  assert.equal(anchors[0][1], anchors[1][1], '正反面在同一列');
  assert.ok(anchors[1][2] > anchors[0][2], '背面在正面下方');
});

test('交給 Claude 的 zip：照片、清單（含 id）、說明', async () => {
  const a = card({ name: '陳怡君', note: '不該出現的私人備註', photos: { front: 'f', back: 'b', avatar: 'a' } });
  const out = await X.buildClaudeZip([a], { JSZip, provider: 'A', dateStr: '20261120', loadPhoto: async () => ({ bytes: JPG, mime: 'image/jpeg' }) });
  const z = await JSZip.loadAsync(out);
  assert.ok(z.file('照片/001_正面.jpg') && z.file('照片/001_背面.jpg'));
  assert.ok(!Object.keys(z.files).some(f => f.includes('大頭照')), '不含大頭照');
  const list = JSON.parse(await z.file('名片清單.json').async('string'));
  assert.equal(list.cards[0].id, a.id);
  const all = JSON.stringify(list) + await z.file('給Claude的說明.txt').async('string');
  assert.ok(!all.includes('不該出現的私人備註'), '不含私人備註');
  assert.ok(all.includes('mingpianjia-pack'));
});

test('Claude 回傳的名片包：同 id 為已存在；手動修改過的欄位可保留；待整理改為一般', () => {
  const local = card({ name: '陳怡君', manual: { name: true }, status: 'pending', phones: [] });
  const pack = C.parsePack(JSON.stringify({ format: C.FORMAT_PACK, version: 1, provider: { name: X.CLAUDE_PROVIDER }, photos: {}, cards: [
    { id: local.id, name: '陳怡', company: '大和物業', phones: [{ label: '手機', value: '0912-345-678', ext: '' }], emails: [], photos: {} }] }));
  const an = C.analyzeImport(pack, [local]);
  assert.equal(an.items[0].status, 'exists');
  const m = C.mergeIncoming(local, an.items[0].incoming, an.items[0].diffs, { name: 'local' }, { provider: X.CLAUDE_PROVIDER, importedAt: C.nowISO(), categoryIdForName: () => null });
  assert.equal(m.card.name, '陳怡君'); assert.equal(m.card.company, '大和物業'); assert.equal(m.card.status, 'ok');
});
