// 名片夾 核心邏輯（純函式，不依賴瀏覽器 DOM，可在 Node 測試）
export const FORMAT_PACK = 'mingpianjia-pack';
export const FORMAT_BACKUP = 'mingpianjia-backup';
export const PACK_VERSION = 1;
export const BACKUP_VERSION = 1;

export const DEFAULT_CATEGORIES = ['物業管理', '管委會／社區', '工程廠商', '專業顧問', '材料供應商', '其他'];

export const SCALAR_FIELDS = ['name', 'company', 'dept', 'title', 'address', 'website', 'lineId'];
export const FIELD_LABELS = {
  name: '姓名', company: '公司', dept: '部門', title: '職稱', address: '地址', website: '網站', lineId: 'LINE ID',
  phones: '電話', emails: 'Email', metDate: '認識日期', metPlace: '認識場合', note: '固定備註',
  category: '分類', tags: '標籤', front: '名片正面', back: '名片背面', avatar: '聯絡人大頭照',
};
export const PHONE_LABELS = ['手機', '公司', '傳真', '其他'];

// ---------- 通用 ----------
export function uuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const b = new Uint8Array(16); globalThis.crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
export const nowISO = () => new Date().toISOString();
const isStr = v => typeof v === 'string';
const clean = v => (isStr(v) ? v.trim() : '');

export function emptyCard() {
  const t = nowISO();
  return {
    id: uuid(), mergedIds: [],
    name: '', company: '', dept: '', title: '',
    phones: [], emails: [], address: '', website: '', lineId: '',
    photos: { front: null, back: null, avatar: null }, photoHashes: { front: null, back: null, avatar: null },
    categoryId: null, tags: [],
    metDate: '', metPlace: '', note: '', logs: [],
    ocr: { front: null, back: null }, review: {}, manual: {},
    status: 'ok', source: { type: 'self' }, imports: [],
    createdAt: t, updatedAt: t,
  };
}

// ---------- 正規化與搜尋 ----------
export function nfkc(s) { return (s || '').normalize('NFKC'); }
export function normText(s) { return nfkc(s).toLowerCase().replace(/\s+/g, ' ').trim(); }
/** 電話正規化：忽略空格、括號、連字號、點；保留開頭 + */
export function phoneDigits(s) {
  const t = nfkc(s).replace(/[\s()\-.‐-―\/]/g, '');
  const plus = t.startsWith('+');
  const d = t.replace(/\D/g, '');
  return plus ? '+' + d : d;
}
/** 比對用的電話鍵（含 +886 與 0 開頭互通） */
export function phoneKeys(s) {
  const d = phoneDigits(s).replace(/^\+/, '');
  if (!d) return [];
  const keys = new Set([d]);
  if (d.startsWith('886')) keys.add('0' + d.slice(3));
  if (d.startsWith('0') && d.length > 1) keys.add('886' + d.slice(1));
  return [...keys];
}

export function searchHaystack(card, categoriesById = {}) {
  const parts = [card.name, card.company, card.dept, card.title, card.address, card.website, card.lineId,
    card.metPlace, card.metDate, card.note,
    categoriesById[card.categoryId] || (card.categoryId ? '' : '未分類'),
    ...(card.tags || []),
    ...(card.phones || []).flatMap(p => [p.value, p.label, p.ext]),
    ...(card.emails || []).flatMap(e => [e.value, e.label]),
    ...(card.logs || []).map(l => l.text),
    card.status === 'pending' ? '待整理' : '',
    card.source?.provider || ''];
  return normText(parts.filter(Boolean).join(' \u0001 '));
}

export function matchCard(card, query, categoriesById = {}) {
  const q = normText(query);
  if (!q) return true;
  const hay = searchHaystack(card, categoriesById);
  const phoneStrs = (card.phones || []).flatMap(p => [...phoneKeys(p.value), ...(p.ext ? [phoneDigits(p.value).replace(/^\+/, '') + phoneDigits(p.ext)] : [])]);
  const tokens = q.split(' ');
  return tokens.every(tok => {
    if (hay.includes(tok)) return true;
    const dq = phoneDigits(tok).replace(/^\+/, '');
    if (dq.length >= 3 && /^[+\d\s()\-.]+$/.test(tok)) {
      const qkeys = [dq, ...(dq.startsWith('886') ? ['0' + dq.slice(3)] : [])];
      return phoneStrs.some(p => qkeys.some(k => p.includes(k)));
    }
    return false;
  });
}

/** 整句搜尋：若整句是電話（含空格），先以電話比對 */
export function filterCards(cards, { query = '', categoryId = 'all', sort = 'created' } = {}, categoriesById = {}) {
  const q = query || '';
  const asPhone = /^[+\d\s()\-.]{3,}$/.test(q.trim()) ? phoneDigits(q).replace(/^\+/, '') : '';
  let list = cards.filter(c => {
    if (categoryId === 'none' && c.categoryId) return false;
    if (categoryId === 'pending' && c.status !== 'pending') return false;
    if (!['all', 'none', 'pending'].includes(categoryId) && c.categoryId !== categoryId) return false;
    if (asPhone && asPhone.length >= 3) {
      const ks = asPhone.startsWith('886') ? [asPhone, '0' + asPhone.slice(3)] : [asPhone];
      if ((c.phones || []).some(p => phoneKeys(p.value).some(pk => ks.some(k => pk.includes(k))))) return true;
    }
    return matchCard(c, q, categoriesById);
  });
  const coll = new Intl.Collator('zh-Hant-TW');
  const label = c => c.name || c.company || '';
  if (sort === 'name') list.sort((a, b) => (!label(a)) - (!label(b)) || coll.compare(label(a), label(b)));
  else if (sort === 'updated') list.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  else list.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  return list;
}

export function initialOf(card) {
  const s = clean(card.name) || clean(card.company);
  if (!s) return '？';
  const ch = [...s][0];
  return /[a-z]/i.test(ch) ? ch.toUpperCase() : ch;
}

// ---------- OCR 文字分欄 ----------
const CJK = '㐀-鿿豈-﫿';
const reCJKSpace = new RegExp(`([${CJK}])\\s+(?=[${CJK}])`, 'g');
export function tidyOcrLine(s) {
  let t = nfkc(s).replace(/[|]/g, ' ').replace(/[ \t]+/g, ' ').trim();
  t = t.replace(reCJKSpace, '$1');
  return t;
}

const COMPANY_RE = /(公司|有限|股份|企業|集團|事務所|工程行|工程|顧問|協會|管委會|管理委員會|社區|大廈|物業|實業|建設|營造|銀行|學校|大學|醫院|基金會|工作室|商行|\bco\.?\b|\bltd\.?\b|\binc\.?\b|\bcorp\.?|corporation|company|limited|group|studio)/i;
const TITLE_WORDS = ['董事長', '總經理', '副總經理', '執行長', '總監', '協理', '經理', '副理', '襄理', '主任委員', '副主任委員', '主委', '委員', '總幹事', '主任', '課長', '組長', '專員', '工程師', '技師', '建築師', '律師', '會計師', '顧問', '業務', '助理', '秘書', '監事', '理事長', '理事', '負責人', '店長', '設計師', '監造', '工地主任', '所長', '處長', '廠長', '特助'];
const TITLE_EN = /\b(manager|director|engineer|ceo|cto|cfo|coo|president|vice|sales|consultant|assistant|supervisor|specialist|architect|officer|chairman|founder|partner|lead|head|designer|representative|secretary|attorney|accountant)\b/i;
const DEPT_RE = /([^\s]{1,10}(部|處|課|組|室|中心|事業群|事業部|科))(?![a-z])|\b(dept\.?|department|division)\b/i;
const ADDR_RE = /(市|縣|區|鄉|鎮|路|街|段|巷|弄|號|樓)/;
const ADDR_EN = /\b(rd\.?|road|st\.?|street|ave\.?|avenue|sec\.?|no\.|floor|f\.|dist\.?|district|city|taiwan|r\.o\.c)\b/i;
const EMAIL_RE = /[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/ig;
const URL_RE = /\b((https?:\/\/)?(www\.)?[a-z0-9\-]+(\.[a-z0-9\-]+)*\.(com|net|org|tw|cn|hk|jp|io|co|biz|info|gov|edu)(\.[a-z]{2})?(\/[^\s]*)?)\b/ig;
const PHONE_RE = /(\+?\(?\d[\d\s()\-.]{6,}\d)/g;
const EXT_RE = /(?:分機|ext\.?|ex\.?|轉|#|x)\s*[:：]?\s*(\d{1,6})/i;
const LABEL_PREFIX = /^(姓名|名字|name|公司|company|職稱|title|部門|dept|地址|address|add|addr|電話|tel|手機|mobile|傳真|fax|email|e-mail|mail|網址|網站|web|website|line\s*id|line)\s*[:：.]?\s*/i;

function phoneLabelFor(context, digits) {
  const c = context.toLowerCase();
  if (/傳真|fax|\bf\s*[:：]/.test(c)) return '傳真';
  if (/手機|行動|mobile|cell|\bm\s*[:：]/.test(c)) return '手機';
  const d = digits.replace(/^\+?886/, '0');
  if (/^09\d{8}$/.test(d)) return '手機';
  if (/電話|tel|office|公司|總機|\bt\s*[:：]/.test(c)) return '公司';
  return '公司';
}

/**
 * 解析單面 OCR 結果。
 * @param {Array<{text:string, confidence?:number}>|string} input 行陣列或原始文字
 * @returns {{fields, phones, emails, review:Set, candidates, unassigned:string[]}}
 */
export function parseCardText(input) {
  let lines = isStr(input) ? input.split(/\r?\n/).map(t => ({ text: t, confidence: 90 })) : (input || []);
  // 一行內有大段空白時分成多段（雙欄排版）
  const segs = [];
  for (const ln of lines) {
    for (const part of nfkc(ln.text || '').split(/\s{3,}|\t+/)) {
      const t = tidyOcrLine(part);
      if (t && /[\p{L}\p{N}]/u.test(t)) segs.push({ text: t, confidence: ln.confidence ?? 90 });
    }
  }
  const cands = { name: [], company: [], dept: [], title: [], address: [], website: [], lineId: [] };
  const phones = []; const emails = []; const used = new Set();
  const add = (f, v, conf, i) => { v = clean(v).replace(LABEL_PREFIX, '').trim(); if (v) { cands[f].push({ value: v, conf }); used.add(i); } };

  segs.forEach((s, i) => {
    let t = s.text;
    // Email（OCR 常在 . @ 旁多出空白）
    if (t.includes('@')) t = t.replace(/\s*([.@_\-])\s*(?=[a-z0-9])/gi, '$1');
    const em = t.match(EMAIL_RE);
    if (em) {
      em.forEach(e => { if (!emails.some(x => x.value.toLowerCase() === e.toLowerCase())) emails.push({ label: '', value: e, conf: s.confidence }); });
      used.add(i); t = t.replace(EMAIL_RE, ' ');
    }
    // LINE
    const lm = t.match(/line\s*(id)?\s*[:：]?\s*([@a-z0-9._\-]{3,})/i);
    if (lm) { add('lineId', lm[2], s.confidence, i); return; }
    // 電話
    const ph = [...t.matchAll(PHONE_RE)].filter(m => phoneDigits(m[1]).replace('+', '').length >= 7 && phoneDigits(m[1]).replace('+', '').length <= 15);
    if (ph.length && !(ADDR_RE.test(t) && /號|樓|路|街/.test(t) && !/(電話|tel|手機|mobile|傳真|fax)/i.test(t))) {
      ph.forEach((m, k) => {
        const before = t.slice(0, m.index).slice(-12) || t;
        const after = t.slice(m.index + m[0].length);
        const ext = (after.match(EXT_RE) || [])[1] || '';
        const value = m[1].trim().replace(/\s+/g, ' ');
        const digits = phoneDigits(value);
        if (!phones.some(p => phoneDigits(p.value) === digits)) phones.push({ label: phoneLabelFor(before + (k === 0 ? t : ''), digits), value, ext, conf: s.confidence });
      });
      used.add(i); return;
    }
    // 網址
    const um = t.match(URL_RE);
    if (um && !/@/.test(t)) { add('website', um[0], s.confidence, i); t = t.replace(URL_RE, ' ').trim(); if (!t || t.length < 2) return; }
    if (/^(網址|網站|web|website)/i.test(t)) return;
    // 地址
    if ((ADDR_RE.test(t) && /\d|[一二三四五六七八九十]/.test(t) && /(路|街|段|號|樓|巷|里)/.test(t)) || (/^(地址|add|addr|address)/i.test(t)) || (ADDR_EN.test(t) && /\d/.test(t) && t.length > 12)) {
      add('address', t.replace(/^(地址|add(ress)?|addr)\s*[:：.]?\s*/i, ''), s.confidence, i); return;
    }
    // 公司
    if (COMPANY_RE.test(t) && !TITLE_WORDS.some(w => t === w)) { add('company', t, s.confidence, i); return; }
    // 職稱 / 部門（同段可能並存，例如「工務部 副理」）
    const titleHit = TITLE_WORDS.find(w => t.includes(w)) || (TITLE_EN.test(t) ? 'en' : null);
    const deptM = t.match(DEPT_RE);
    if (titleHit || deptM) {
      const words = t.split(' ');
      const zhSplit = titleHit && titleHit !== 'en' ? t.replace(/\s/g, '').match(/^(.+?(部|處|課|組|室|中心|事業群|科))(.+)$/) : null;
      if (zhSplit && TITLE_WORDS.some(w => zhSplit[3].includes(w)) && !TITLE_WORDS.some(w => zhSplit[1].includes(w))) {
        add('dept', zhSplit[1], s.confidence, i); add('title', zhSplit[3], s.confidence, i);
      } else if (words.length > 1 && titleHit && deptM && titleHit !== 'en') {
        const tWords = words.filter(w => TITLE_WORDS.some(x => w.includes(x)));
        const dWords = words.filter(w => !tWords.includes(w));
        if (dWords.length) add('dept', dWords.join(' '), s.confidence, i);
        add('title', tWords.join(' '), s.confidence, i);
      } else if (titleHit && titleHit !== 'en' && /[a-z]{3,}/i.test(t) && new RegExp(`[${CJK}]`).test(t)) {
        // 「專案經理 Project Manager」：中文為主，英文列為候選
        const zhPart = t.replace(/[a-z][a-z .,&'\-]*/gi, ' ').replace(/\s+/g, ' ').trim();
        const enPart = (t.match(/[a-z][a-z .,&'\-]*[a-z]/gi) || []).join(' ').trim();
        add('title', zhPart, s.confidence, i); if (enPart) add('title', enPart, s.confidence, i);
      } else if (titleHit) {
        // 英文職稱行若含 Dept.，拆出部門
        const m2 = t.match(/^(.*?),\s*(.*(dept\.?|department|division).*)$/i);
        if (m2) { add('title', m2[1], s.confidence, i); add('dept', m2[2], s.confidence, i); }
        else add('title', t, s.confidence, i);
      } else add('dept', t, s.confidence, i);
      return;
    }
    // 姓名（中文 2–4 字；英文 2–3 個大寫開頭單字）
    const compact = t.replace(/\s/g, '');
    if (new RegExp(`^[${CJK}]{2,4}$`).test(compact)) { add('name', compact, s.confidence, i); return; }
    // 中文姓名後接雜訊，例如「陳怡 a」→ 視為低把握度姓名
    const mixed = t.match(new RegExp(`^([${CJK}]{2,4})\\s+[a-z0-9]{1,2}$`, 'i'));
    if (mixed) { add('name', mixed[1], Math.min(s.confidence, 40), i); return; }
    if (/^[A-Z][a-zA-Z'\-]+(\s[A-Z][a-zA-Z'\-]+){1,2}$/.test(t)) { add('name', t, Math.min(s.confidence, 80), i); return; }
  });

  const unassigned = segs.filter((_, i) => !used.has(i)).map(s => s.text);
  const fields = {}; const review = new Set(); const candidates = {};
  for (const f of Object.keys(cands)) {
    let list = cands[f];
    if (list.length > 1 && f !== 'address') {
      // 中文優先；英文保留為候選
      const zh = list.filter(c => new RegExp(`[${CJK}]`).test(c.value));
      if (zh.length) list = [...zh, ...list.filter(c => !zh.includes(c))];
    }
    if (!list.length) continue;
    fields[f] = list[0].value;
    candidates[f] = [...new Set(list.map(c => c.value))];
    const zhCount = list.filter(c => new RegExp(`[${CJK}]`).test(c.value)).length;
    const multiAmbiguous = ['website', 'lineId', 'address'].includes(f) ? list.length > 1 : zhCount > 1 || (zhCount === 0 && list.length > 1);
    if (list[0].conf < 70 || multiAmbiguous) review.add(f);
  }
  if (f_any(phones, p => p.conf < 70)) review.add('phones');
  if (f_any(emails, e => e.conf < 70)) review.add('emails');
  return {
    fields, review, candidates, unassigned,
    phones: phones.map(({ conf, ...p }) => p), emails: emails.map(({ conf, ...e }) => e),
  };
}
function f_any(a, fn) { return a.some(fn); }

/** 正反面合併：兩面資訊都保留；衝突時以正面為值、標記請核對 */
export function mergeFaces(front, back) {
  const out = { fields: {}, review: new Set(), candidates: {}, phones: [], emails: [] };
  const faces = [front, back].filter(Boolean);
  for (const f of SCALAR_FIELDS) {
    const vals = faces.map(x => x.fields[f]).filter(Boolean);
    if (!vals.length) continue;
    out.fields[f] = vals[0];
    const all = [...new Set(faces.flatMap(x => x.candidates[f] || []))];
    out.candidates[f] = all;
    if (faces.some(x => x.review.has(f)) || new Set(vals).size > 1) out.review.add(f);
  }
  for (const x of faces) {
    for (const p of x.phones) if (!out.phones.some(q => phoneDigits(q.value) === phoneDigits(p.value))) out.phones.push(p);
    for (const e of x.emails) if (!out.emails.some(q => q.value.toLowerCase() === e.value.toLowerCase())) out.emails.push(e);
    if (x.review.has('phones')) out.review.add('phones');
    if (x.review.has('emails')) out.review.add('emails');
  }
  return out;
}

/** 將辨識結果套到「新」名片（尚無人工資料） */
export function applyParsedToCard(card, parsed) {
  const c = structuredClone(card);
  for (const f of SCALAR_FIELDS) if (parsed.fields[f] && !c.manual[f]) c[f] = parsed.fields[f];
  if (!c.manual.phones) c.phones = parsed.phones.map(p => ({ ...p }));
  if (!c.manual.emails) c.emails = parsed.emails.map(e => ({ ...e }));
  c.review = {};
  for (const f of parsed.review) c.review[f] = true;
  for (const f of SCALAR_FIELDS) if (!c[f]) delete c.review[f];
  return c;
}

/**
 * 重新辨識或補拍背面時的建議變更：不動已人工修改的欄位。
 * 回傳 [{field, from, to, kind:'set'|'replace'|'add', item?, defaultOn}]
 */
export function suggestChanges(card, parsed) {
  const out = [];
  for (const f of SCALAR_FIELDS) {
    const to = parsed.fields[f];
    if (!to || card.manual?.[f]) continue;
    const from = card[f] || '';
    if (from === to) continue;
    out.push({ field: f, from, to, kind: from ? 'replace' : 'set', defaultOn: !from });
  }
  if (!card.manual?.phones) for (const p of parsed.phones) {
    if (!(card.phones || []).some(q => phoneDigits(q.value) === phoneDigits(p.value))) out.push({ field: 'phones', kind: 'add', item: p, from: '', to: p.value, defaultOn: true });
  }
  if (!card.manual?.emails) for (const e of parsed.emails) {
    if (!(card.emails || []).some(q => q.value.toLowerCase() === e.value.toLowerCase())) out.push({ field: 'emails', kind: 'add', item: e, from: '', to: e.value, defaultOn: true });
  }
  return out;
}
export function applySuggestions(card, suggestions) {
  const c = structuredClone(card);
  for (const s of suggestions) {
    if (s.kind === 'add') c[s.field] = [...(c[s.field] || []), { ...s.item }];
    else c[s.field] = s.to;
  }
  return c;
}

// ---------- 名片包（匯出） ----------
export const SHARE_OPTIONS = {
  avatar: '大頭照', classify: '分類與標籤', met: '認識日期與場合', note: '私人備註', logs: '往來紀錄',
};
export function defaultShareOptions() { return { avatar: false, classify: false, met: false, note: false, logs: false }; }

export function sharedFieldList(opts) {
  const base = ['基本資料（姓名、公司、部門、職稱）', '聯絡資料（電話、Email、地址、網站、LINE ID）', '名片正反面'];
  return [...base, ...Object.entries(SHARE_OPTIONS).filter(([k]) => opts[k]).map(([, v]) => v)];
}

/**
 * 建立名片包（白名單：未勾選的資料完全不寫入）
 * @param cards 完整名片
 * @param photoLoader async (photoId) => {mime, b64}
 */
export async function buildPack(cards, { provider, options, categoriesById = {}, photoLoader }) {
  const opts = { ...defaultShareOptions(), ...options };
  const photos = {}; let pc = 0;
  const photoKinds = { front: 0, back: 0, avatar: 0 };
  const outCards = [];
  for (const c of cards) {
    const o = {
      id: c.id, updatedAt: c.updatedAt,
      name: c.name || '', company: c.company || '', dept: c.dept || '', title: c.title || '',
      phones: (c.phones || []).map(p => ({ label: p.label || '', value: p.value || '', ext: p.ext || '' })),
      emails: (c.emails || []).map(e => ({ label: e.label || '', value: e.value || '' })),
      address: c.address || '', website: c.website || '', lineId: c.lineId || '',
      photos: {},
    };
    const kinds = ['front', 'back', ...(opts.avatar ? ['avatar'] : [])];
    for (const k of kinds) {
      const pid = c.photos?.[k];
      if (!pid) continue;
      const ph = await photoLoader(pid);
      if (!ph) continue;
      const key = 'p' + (++pc);
      photos[key] = { mime: ph.mime || 'image/jpeg', data: ph.b64 };
      o.photos[k] = key; photoKinds[k]++;
    }
    if (opts.classify) { o.category = categoriesById[c.categoryId] || ''; o.tags = [...(c.tags || [])]; }
    if (opts.met) { o.metDate = c.metDate || ''; o.metPlace = c.metPlace || ''; }
    if (opts.note) o.note = c.note || '';
    if (opts.logs) o.logs = (c.logs || []).map(l => ({ id: l.id, date: l.date, text: l.text }));
    outCards.push(o);
  }
  const included = Object.keys(opts).filter(k => opts[k]);
  return {
    pack: { format: FORMAT_PACK, version: PACK_VERSION, provider: { name: provider }, exportedAt: nowISO(), included, cards: outCards, photos },
    summary: { count: outCards.length, fields: sharedFieldList(opts), photoKinds },
  };
}

export class PackError extends Error { constructor(msg) { super(msg); this.name = 'PackError'; } }

export function parsePack(text) {
  let j;
  try { j = typeof text === 'string' ? JSON.parse(text) : text; } catch { throw new PackError('檔案損毀或不是名片包（無法讀取內容）。'); }
  if (!j || typeof j !== 'object') throw new PackError('檔案內容不正確。');
  if (j.format === FORMAT_BACKUP) throw new PackError('這是「完整備份」檔，請到「我的 → 還原備份」使用。');
  if (j.format !== FORMAT_PACK) throw new PackError('這不是名片夾的名片包檔案。');
  if (typeof j.version !== 'number' || j.version > PACK_VERSION) throw new PackError(`名片包格式版本 ${j.version} 不支援，請更新 App。`);
  if (!Array.isArray(j.cards)) throw new PackError('名片包缺少名片清單。');
  const photos = j.photos && typeof j.photos === 'object' ? j.photos : {};
  for (const c of j.cards) {
    if (!c || !isStr(c.id) || c.id.length < 8) throw new PackError('名片包內有名片缺少識別碼，檔案可能損毀。');
    for (const [k, ref] of Object.entries(c.photos || {})) {
      if (!['front', 'back', 'avatar'].includes(k)) throw new PackError('名片包內照片欄位不正確。');
      if (!photos[ref] || !isStr(photos[ref].data)) throw new PackError('名片包內照片遺失，檔案可能損毀。');
    }
    if (c.phones && !Array.isArray(c.phones)) throw new PackError('名片包內電話格式不正確。');
    if (c.emails && !Array.isArray(c.emails)) throw new PackError('名片包內 Email 格式不正確。');
  }
  return { provider: clean(j.provider?.name) || '（未具名）', exportedAt: j.exportedAt || '', included: j.included || [], cards: j.cards, photos };
}

// ---------- 匯入比對 ----------
function cardKeysForDup(c) {
  return {
    phones: new Set((c.phones || []).flatMap(p => phoneKeys(p.value))),
    emails: new Set((c.emails || []).map(e => normText(e.value)).filter(Boolean)),
  };
}

/**
 * 分析名片包：每筆標記 new / exists / dup。
 * exists：同識別碼（或曾合併過的識別碼）；dup：識別碼不同但電話或 Email 相同（只提示，不自動合併）
 */
export function analyzeImport(pack, localCards, categoriesById = {}, photoHashOf = () => null) {
  const byId = new Map();
  for (const c of localCards) { byId.set(c.id, c); for (const m of c.mergedIds || []) byId.set(m, c); }
  const items = pack.cards.map(ic => {
    const local = byId.get(ic.id);
    if (local) {
      const diffs = diffFields(local, ic, pack, categoriesById, photoHashOf);
      const extra = extraChanges(local, ic);
      const changed = diffs.length > 0 || extra.logs > 0 || extra.tags > 0;
      return { incoming: ic, status: 'exists', local, diffs, extra, action: changed ? 'merge' : 'skip', selected: changed };
    }
    const k = cardKeysForDup(ic);
    const matches = localCards.filter(c => {
      const lk = cardKeysForDup(c);
      return [...k.emails].some(e => lk.emails.has(e)) || [...k.phones].some(p => lk.phones.has(p));
    }).map(c => {
      const lk = cardKeysForDup(c);
      return { card: c, by: [...k.emails].some(e => lk.emails.has(e)) ? 'Email' : '電話' };
    });
    if (matches.length) {
      const local2 = matches[0].card;
      return { incoming: ic, status: 'dup', matches, local: local2, diffs: diffFields(local2, ic, pack, categoriesById, photoHashOf), action: 'separate', selected: true };
    }
    return { incoming: ic, status: 'new', action: 'add', selected: true, diffs: [] };
  });
  const counts = { new: 0, exists: 0, dup: 0 };
  items.forEach(i => counts[i.status]++);
  return { items, counts };
}

/** 名片包中尚未出現在本機的往來紀錄與標籤數量 */
export function extraChanges(local, ic) {
  const ids = new Set((local.logs || []).map(l => l.id));
  const keys = new Set((local.logs || []).map(logKey));
  const logs = (ic.logs || []).filter(l => l && clean(l.text) && !(l.id && ids.has(l.id)) && !keys.has(logKey(l))).length;
  const tags = (ic.tags || []).map(clean).filter(t => t && !(local.tags || []).includes(t)).length;
  return { logs, tags };
}

function fmtPhones(list) { return (list || []).map(p => `${p.label ? p.label + ' ' : ''}${p.value}${p.ext ? ' 分機 ' + p.ext : ''}`).join('\n'); }
function fmtEmails(list) { return (list || []).map(e => e.value).join('\n'); }

/** 有差異的欄位；對方沒分享或空白的欄位不列（不得清空本機資料） */
export function diffFields(local, ic, pack, categoriesById = {}, photoHashOf = () => null) {
  const d = [];
  const has = k => Object.prototype.hasOwnProperty.call(ic, k);
  for (const f of SCALAR_FIELDS) {
    if (!has(f)) continue;
    const iv = clean(ic[f]); if (!iv) continue;
    if (iv !== clean(local[f])) d.push({ field: f, local: local[f] || '', incoming: iv });
  }
  if (Array.isArray(ic.phones) && ic.phones.length) {
    const norm = l => (l || []).map(p => phoneDigits(p.value) + '#' + phoneDigits(p.ext || '')).sort().join('|');
    if (norm(ic.phones) !== norm(local.phones)) d.push({ field: 'phones', local: fmtPhones(local.phones), incoming: fmtPhones(ic.phones), incomingList: ic.phones });
  }
  if (Array.isArray(ic.emails) && ic.emails.length) {
    const norm = l => (l || []).map(e => normText(e.value)).sort().join('|');
    if (norm(ic.emails) !== norm(local.emails)) d.push({ field: 'emails', local: fmtEmails(local.emails), incoming: fmtEmails(ic.emails), incomingList: ic.emails });
  }
  for (const f of ['metDate', 'metPlace', 'note']) {
    if (!has(f)) continue; const iv = clean(ic[f]); if (!iv) continue;
    if (iv !== clean(local[f])) d.push({ field: f, local: local[f] || '', incoming: iv });
  }
  if (has('category') && clean(ic.category) && clean(ic.category) !== (categoriesById[local.categoryId] || '')) {
    d.push({ field: 'category', local: categoriesById[local.categoryId] || '未分類', incoming: clean(ic.category) });
  }
  for (const k of ['front', 'back', 'avatar']) {
    const ref = ic.photos?.[k]; if (!ref) continue;
    const ih = photoHashOf(ref);
    if (!local.photoHashes?.[k] || ih !== local.photoHashes[k]) d.push({ field: k, local: local.photos?.[k] ? '（本機照片）' : '（無）', incoming: '（對方照片）', photoRef: ref, localPhotoId: local.photos?.[k] || null });
  }
  return d;
}

/**
 * 依使用者選擇合併。choices: {field: 'local'|'incoming'}；未列者沿用預設。
 * - 標籤：聯集；往來紀錄：依 id 去重後加入；私人備註與往來紀錄不會被清除。
 * 回傳 {card, photoTasks:[{kind, ref}]}（需由呼叫端寫入照片）
 */
export function mergeIncoming(local, ic, diffs, choices, { provider, importedAt, categoryIdForName }) {
  const c = structuredClone(local);
  const photoTasks = [];
  for (const df of diffs) {
    const pick = choices[df.field] || 'incoming';
    if (pick !== 'incoming') continue;
    if (SCALAR_FIELDS.includes(df.field) || ['metDate', 'metPlace'].includes(df.field)) c[df.field] = df.incoming;
    else if (df.field === 'note') c.note = df.incoming;
    else if (df.field === 'phones') c.phones = df.incomingList.map(p => ({ label: p.label || '', value: p.value, ext: p.ext || '' }));
    else if (df.field === 'emails') c.emails = df.incomingList.map(e => ({ label: e.label || '', value: e.value }));
    else if (df.field === 'category') c.categoryId = categoryIdForName(df.incoming);
    else if (['front', 'back', 'avatar'].includes(df.field)) photoTasks.push({ kind: df.field, ref: df.photoRef });
  }
  if (Array.isArray(ic.tags)) c.tags = [...new Set([...(c.tags || []), ...ic.tags.map(clean).filter(Boolean)])];
  if (Array.isArray(ic.logs)) addLogs(c, ic.logs);
  if (ic.id !== c.id && !c.mergedIds.includes(ic.id)) c.mergedIds = [...(c.mergedIds || []), ic.id];
  c.imports = [...(c.imports || []), { provider, at: importedAt }];
  for (const df of diffs) if ((choices[df.field] || 'incoming') === 'incoming' && c.review) delete c.review[df.field];
  if (c.status === 'pending' && (clean(c.name) || clean(c.company))) c.status = 'ok';
  c.updatedAt = nowISO();
  return { card: c, photoTasks };
}

function logKey(l) { return `${l.date || ''}\u0001${clean(l.text)}`; }
export function addLogs(card, logs) {
  const ids = new Set((card.logs || []).map(l => l.id));
  const keys = new Set((card.logs || []).map(logKey));
  for (const l of logs) {
    if (!l || !clean(l.text)) continue;
    if ((l.id && ids.has(l.id)) || keys.has(logKey(l))) continue;
    card.logs.push({ id: l.id || uuid(), date: l.date || '', text: clean(l.text), createdAt: nowISO() });
    ids.add(l.id); keys.add(logKey(l));
  }
  sortLogs(card);
}
export function sortLogs(card) {
  card.logs.sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.createdAt || '').localeCompare(a.createdAt || ''));
}

/** 由名片包建立新名片（保留對方識別碼） */
export function cardFromIncoming(ic, { provider, importedAt, categoryIdForName }) {
  const c = emptyCard();
  c.id = ic.id;
  for (const f of SCALAR_FIELDS) c[f] = clean(ic[f]);
  c.phones = (ic.phones || []).filter(p => clean(p.value)).map(p => ({ label: clean(p.label), value: clean(p.value), ext: clean(p.ext) }));
  c.emails = (ic.emails || []).filter(e => clean(e.value)).map(e => ({ label: clean(e.label), value: clean(e.value) }));
  if (clean(ic.category)) c.categoryId = categoryIdForName(clean(ic.category));
  if (Array.isArray(ic.tags)) c.tags = [...new Set(ic.tags.map(clean).filter(Boolean))];
  c.metDate = clean(ic.metDate); c.metPlace = clean(ic.metPlace); c.note = clean(ic.note);
  if (Array.isArray(ic.logs)) addLogs(c, ic.logs);
  c.source = { type: 'import', provider, importedAt };
  c.imports = [{ provider, at: importedAt }];
  return c;
}

// ---------- 備份格式 ----------
export function backupSummary(payload, localCards) {
  const ids = new Set(localCards.flatMap(c => [c.id, ...(c.mergedIds || [])]));
  const bc = payload.cards || [];
  const overlap = bc.filter(c => ids.has(c.id)).length;
  const photoCount = Object.keys(payload.photos || {}).length;
  return {
    createdAt: payload.createdAt, userName: payload.userName, cardCount: bc.length, photoCount,
    categoryCount: (payload.categories || []).length,
    logCount: bc.reduce((n, c) => n + (c.logs || []).length, 0),
    newCount: bc.length - overlap, overlapCount: overlap,
    localOnly: localCards.filter(c => !bc.some(b => b.id === c.id)).length,
  };
}

// ---------- base64 ----------
export function bytesToB64(u8) {
  if (typeof Buffer !== 'undefined') return Buffer.from(u8).toString('base64');
  let s = ''; const CH = 0x8000;
  for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
  return btoa(s);
}
export function b64ToBytes(b64) {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(b64, 'base64'));
  const s = atob(b64); const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u;
}
