// 執行：node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as C from '../js/core.js';
import * as K from '../js/crypto.js';

const dir = new URL('.', import.meta.url);
const read = f => fs.readFileSync(new URL(f, dir), 'utf8');

function card(o = {}) { return { ...C.emptyCard(), ...o }; }

test('電話正規化：忽略空格、括號、連字號，保留開頭 0 與國碼', () => {
  assert.equal(C.phoneDigits('(02) 2700-1234'), '0227001234');
  assert.equal(C.phoneDigits('+886 912-345-678'), '+886912345678');
  assert.ok(C.phoneKeys('+886-2-2700-1234').includes('0227001234'));
});

test('搜尋涵蓋各欄位，電話忽略格式', () => {
  const cats = { c1: '物業管理' };
  const a = card({ name: '陳怡君', company: '大和物業', title: '副理', categoryId: 'c1', tags: ['外牆'], metPlace: '南港展覽館建材展', note: '聯絡前先傳 LINE',
    phones: [{ label: '公司', value: '(02) 2700-1234', ext: '305' }], emails: [{ value: 'yc@dahe.tw' }], logs: [{ id: 'l1', date: '2026-11-19', text: '電話確認管委會下週開會' }] });
  const b = card({ name: '王小明', company: '某工程行' });
  const all = [a, b];
  const q = s => C.filterCards(all, { query: s }, cats).map(c => c.name);
  assert.deepEqual(q('27001234'), ['陳怡君']);
  assert.deepEqual(q('02-2700 1234'), ['陳怡君']);
  assert.deepEqual(q('(02)2700-1234'), ['陳怡君']);
  assert.deepEqual(q('建材展'), ['陳怡君']);
  assert.deepEqual(q('先傳'), ['陳怡君']);
  assert.deepEqual(q('物業管理'), ['陳怡君']);
  assert.deepEqual(q('外牆'), ['陳怡君']);
  assert.deepEqual(q('YC@DAHE'), ['陳怡君']);
  assert.deepEqual(q('管委會'), ['陳怡君']);
  assert.deepEqual(q('工程行'), ['王小明']);
  assert.deepEqual(C.filterCards(all, { categoryId: 'none' }, cats).map(c => c.name), ['王小明']);
});

test('排序：最近新增／姓名／最近更新', () => {
  const a = card({ name: '乙', createdAt: '2026-01-01', updatedAt: '2026-03-01' });
  const b = card({ name: '甲', createdAt: '2026-02-01', updatedAt: '2026-02-02' });
  assert.deepEqual(C.filterCards([a, b], { sort: 'created' }).map(c => c.name), ['甲', '乙']);
  assert.deepEqual(C.filterCards([a, b], { sort: 'updated' }).map(c => c.name), ['乙', '甲']);
  assert.equal(C.filterCards([a, b], { sort: 'name' }).length, 2);
});

test('首字：姓名優先，只有公司時用公司首字', () => {
  assert.equal(C.initialOf({ name: '陳怡君', company: 'X' }), '陳');
  assert.equal(C.initialOf({ name: '', company: '大和物業' }), '大');
  assert.equal(C.initialOf({ name: 'amy' }), 'A');
});

test('OCR 分欄（真實 tesseract chi_tra+eng 輸出）：正反面整合為一筆', () => {
  const f = C.parseCardText(read('front.txt'));
  const b = C.parseCardText(read('back.txt'));
  const m = C.mergeFaces(f, b);
  assert.equal(m.fields.company, '大和物業管理顧問股份有限公司');
  assert.equal(m.fields.dept, '工務部');
  assert.equal(m.fields.title, '副理');
  assert.equal(m.fields.address, '台北市大安區忠孝東路四段100號8樓');
  assert.equal(m.fields.website, 'www.dahe-pm.com.tw');
  assert.equal(m.fields.lineId, 'yichun_dahe');
  assert.ok(m.review.has('name'), '姓名辨識把握度低應標記請核對');
  assert.deepEqual(m.emails.map(e => e.value), ['yichun.chen@dahe-pm.com.tw']);
  const office = m.phones.find(p => p.ext === '305');
  assert.equal(C.phoneDigits(office.value), '0227001234');
  assert.ok(m.phones.some(p => p.label === '手機' && C.phoneDigits(p.value) === '0912345678'), '背面手機要保留');
  assert.ok(m.phones.some(p => p.label === '傳真'));
});

test('無法判定的欄位留白', () => {
  const r = C.parseCardText('###\n@@@');
  assert.deepEqual(r.fields, {});
});

test('重新辨識建議變更：保留使用者手動修改的欄位', () => {
  const c = card({ name: '陳怡君', company: '', manual: { name: true }, phones: [{ label: '公司', value: '02-2700-1234', ext: '' }] });
  const parsed = { fields: { name: '陳怡', company: '大和物業' }, phones: [{ label: '手機', value: '0912345678', ext: '' }, { label: '公司', value: '(02)27001234', ext: '' }], emails: [], review: new Set(), candidates: {} };
  const s = C.suggestChanges(c, parsed);
  assert.ok(!s.some(x => x.field === 'name'));
  assert.ok(s.some(x => x.field === 'company' && x.kind === 'set'));
  assert.equal(s.filter(x => x.field === 'phones').length, 1);
  const out = C.applySuggestions(c, s);
  assert.equal(out.name, '陳怡君'); assert.equal(out.phones.length, 2);
});

async function makePack(cards, options) {
  return C.buildPack(cards, { provider: '使用者A', options, categoriesById: { c1: '物業管理' }, photoLoader: async id => ({ mime: 'image/jpeg', b64: Buffer.from('IMG-' + id).toString('base64') }) });
}

test('名片包只含勾選的資料；未勾選的資料（含原文與內部欄位）不寫入檔案', async () => {
  const secret = '絕對不能外流的備註XYZ';
  const c = card({ name: '陳怡君', company: '大和', categoryId: 'c1', tags: ['VIP標籤'], metPlace: '秘密場合', metDate: '2026-01-02', note: secret,
    logs: [{ id: 'l1', date: '2026-11-19', text: '私密往來ABC' }], photos: { front: 'f1', back: 'b1', avatar: 'a1' },
    ocr: { front: { text: secret } }, review: { name: true }, manual: { name: true } });
  const { pack, summary } = await makePack([c], {});
  const txt = JSON.stringify(pack);
  for (const bad of [secret, '私密往來ABC', '秘密場合', 'VIP標籤', '物業管理', 'IMG-a1', '"ocr"', '"manual"', '"review"', '"note"', '"logs"', '"tags"', '"source"', '"mergedIds"'])
    assert.ok(!txt.includes(bad), '不應包含 ' + bad);
  assert.ok(txt.includes(Buffer.from('IMG-f1').toString('base64')));
  assert.ok(txt.includes(Buffer.from('IMG-b1').toString('base64')));
  assert.deepEqual(summary.photoKinds, { front: 1, back: 1, avatar: 0 });
  assert.equal(pack.provider.name, '使用者A');
  assert.equal(pack.cards[0].id, c.id);
  const { pack: p2 } = await makePack([c], { avatar: true, note: true, logs: true, classify: true, met: true });
  const t2 = JSON.stringify(p2);
  for (const ok of [secret, '私密往來ABC', '秘密場合', 'VIP標籤', '物業管理']) assert.ok(t2.includes(ok));
  assert.ok(!t2.includes('"ocr"'));
});

test('名片包驗證：損毀、格式錯誤、版本不支援', () => {
  assert.throws(() => C.parsePack('{bad json'), C.PackError);
  assert.throws(() => C.parsePack('{"format":"x"}'), C.PackError);
  assert.throws(() => C.parsePack(JSON.stringify({ format: C.FORMAT_PACK, version: 99, cards: [] })), /版本/);
  assert.throws(() => C.parsePack(JSON.stringify({ format: C.FORMAT_PACK, version: 1, cards: [{ id: 'abcdefgh-1', photos: { front: 'p9' } }], photos: {} })), /照片/);
});

test('匯入比對：同識別碼＝已存在；電話相同＝可能重複但不自動合併；同公司總機可分開保留', async () => {
  const mine = card({ name: '陳怡君', company: '大和', phones: [{ label: '公司', value: '02-2700-1234', ext: '305' }], note: '我的私人備註', logs: [{ id: 'mylog', date: '2026-11-01', text: '我的紀錄' }] });
  const colleagueOfMine = card({ name: '林大偉', company: '大和', phones: [{ label: '公司', value: '02-2700-1234', ext: '201' }] });
  const updated = { ...structuredClone(mine), phones: [{ label: '公司', value: '02-2700-1234', ext: '306' }] };
  const other = card({ name: '張三', company: '大和', phones: [{ label: '公司', value: '(02) 2700 1234', ext: '110' }] });
  const brandNew = card({ name: '新朋友', emails: [{ value: 'new@x.tw' }] });
  const { pack } = await makePack([updated, other, brandNew], {});
  const parsed = C.parsePack(JSON.stringify(pack));
  const local = [mine, colleagueOfMine];
  const an = C.analyzeImport(parsed, local);
  assert.deepEqual(an.counts, { new: 1, exists: 1, dup: 1 });
  const ex = an.items.find(i => i.status === 'exists');
  const phoneDiff = ex.diffs.find(d => d.field === 'phones');
  assert.ok(phoneDiff.local.includes('305') && phoneDiff.incoming.includes('306'), '要能看見新舊分機差異');
  assert.ok(!ex.diffs.some(d => d.field === 'note'), '對方未分享備註，不可列為差異');
  const dup = an.items.find(i => i.status === 'dup');
  assert.equal(dup.action, 'separate', '電話相同只提示，預設分開保留');

  // 使用者選擇保留本機分機
  const keepLocal = C.mergeIncoming(mine, ex.incoming, ex.diffs, { phones: 'local' }, { provider: '使用者A', importedAt: C.nowISO(), categoryIdForName: () => null });
  assert.equal(keepLocal.card.phones[0].ext, '305');
  // 採用新分機
  const takeNew = C.mergeIncoming(mine, ex.incoming, ex.diffs, { phones: 'incoming' }, { provider: '使用者A', importedAt: C.nowISO(), categoryIdForName: () => null });
  assert.equal(takeNew.card.phones[0].ext, '306');
  assert.equal(takeNew.card.note, '我的私人備註', '原有備註仍在');
  assert.equal(takeNew.card.logs.length, 1);

  // 套用後重複匯入同一檔案：不重複新增
  const afterNew = C.cardFromIncoming(an.items.find(i => i.status === 'new').incoming, { provider: '使用者A', importedAt: C.nowISO(), categoryIdForName: () => null });
  const otherKept = C.cardFromIncoming(dup.incoming, { provider: '使用者A', importedAt: C.nowISO(), categoryIdForName: () => null });
  const local2 = [takeNew.card, colleagueOfMine, afterNew, otherKept];
  const an2 = C.analyzeImport(parsed, local2);
  assert.deepEqual(an2.counts, { new: 0, exists: 3, dup: 0 });
  assert.ok(an2.items.every(i => i.diffs.length === 0 && !i.selected), '第二次匯入不應有任何變更');
  assert.equal(afterNew.source.type, 'import'); assert.equal(afterNew.source.provider, '使用者A');
});

test('合併可能重複的名片後，再次匯入仍視為同一筆；往來紀錄不重複', async () => {
  const mine = card({ name: '陳怡君', emails: [{ value: 'yc@dahe.tw' }], logs: [] });
  const theirs = card({ name: '陳怡君', title: '副理', emails: [{ value: 'yc@dahe.tw' }], logs: [{ id: 'L1', date: '2026-11-19', text: '電話確認' }] });
  const { pack } = await makePack([theirs], { logs: true });
  const p = C.parsePack(JSON.stringify(pack));
  const a1 = C.analyzeImport(p, [mine]);
  assert.equal(a1.items[0].status, 'dup');
  const m = C.mergeIncoming(mine, a1.items[0].incoming, a1.items[0].diffs, {}, { provider: 'B', importedAt: C.nowISO(), categoryIdForName: () => null });
  assert.equal(m.card.title, '副理'); assert.equal(m.card.logs.length, 1);
  const a2 = C.analyzeImport(p, [m.card]);
  assert.equal(a2.items[0].status, 'exists');
  const m2 = C.mergeIncoming(m.card, a2.items[0].incoming, a2.items[0].diffs, {}, { provider: 'B', importedAt: C.nowISO(), categoryIdForName: () => null });
  assert.equal(m2.card.logs.length, 1, '往來紀錄不得重複');
});

test('往來紀錄依時間倒序，新增不覆蓋', () => {
  const c = card();
  C.addLogs(c, [{ id: 'a', date: '2026-11-01', text: '第一次' }]);
  C.addLogs(c, [{ id: 'b', date: '2026-11-19', text: '第二次' }]);
  assert.deepEqual(c.logs.map(l => l.text), ['第二次', '第一次']);
});

test('PIN：不保存明文；錯誤 PIN 無法解開', async () => {
  const { record } = await K.createUserKeys('1234');
  assert.ok(!JSON.stringify([...record.wrapped]).includes('1234'));
  assert.equal(await K.unlockUserKey('0000', record), null);
  assert.ok(await K.unlockUserKey('1234', record));
  const re = await K.rewrapUserKey('1234', '5678', record);
  assert.ok(await K.unlockUserKey('5678', re));
});

test('完整備份：正確密碼可還原；錯誤密碼丟出錯誤', async () => {
  const payload = { createdAt: '2026-11-19T00:00:00Z', userName: 'A', cards: [card({ name: '甲' })], photos: { x: { mime: 'image/jpeg', data: 'AAAA' } }, categories: [{ id: 'c', name: '其他' }] };
  const sealed = await K.sealBackup(payload, 'correct horse');
  assert.ok(!sealed.includes('甲'));
  const back = await K.openBackup(sealed, 'correct horse');
  assert.equal(back.cards[0].name, '甲');
  await assert.rejects(K.openBackup(sealed, 'wrong'), e => e.code === 'password');
  await assert.rejects(K.openBackup('not json', 'x'), e => e.code === 'corrupt');
  const s = C.backupSummary(back, [card({ id: back.cards[0].id }), card()]);
  assert.equal(s.cardCount, 1); assert.equal(s.overlapCount, 1); assert.equal(s.localOnly, 1);
});
