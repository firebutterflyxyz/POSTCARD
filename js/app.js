// 名片夾 主程式
import * as C from './core.js';
import * as DB from './db.js';
import * as OCR from './ocr.js';
import * as K from './crypto.js';
import * as X from './exporters.js';
import { h, $, put, icon, toast, sheet, confirmBox, menu, promptBox, pickFile, compressImage, zoomImage, fmtDate, today, stamp, safeName, shareOrSave, closeAllSheets } from './ui.js';

const APP_VERSION = '1.1.0';
const AUTO_LOCK_MS = 5 * 60 * 1000;
const S = {
  session: null, gen: 0, cards: new Map(), cats: [], query: '', cat: 'all', sort: 'created',
  selecting: false, selected: new Set(), urls: new Map(), pages: [], hiddenAt: 0, pendingFiles: [],
};
window.__MPJ = S; // 供自動化測試檢查（不含金鑰）
const app = () => $('#app');
const catsById = () => Object.fromEntries(S.cats.map(c => [c.id, c.name]));
const catName = id => S.cats.find(c => c.id === id)?.name || '';

// ================= 啟動 =================
async function boot() {
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
  if ('launchQueue' in window) {
    window.launchQueue.setConsumer(async p => { for (const fh of p.files || []) S.pendingFiles.push(await fh.getFile()); if (S.session) drainInbox(); });
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) S.hiddenAt = Date.now();
    else if (S.session && S.hiddenAt && Date.now() - S.hiddenAt > AUTO_LOCK_MS) lock('閒置過久，已自動鎖定');
  });
  window.addEventListener('popstate', onPop);
  try { await DB.openDB(); } catch (e) { put(app(), h('div', { class: 'auth' }, h('h1', {}, '無法開啟本機儲存'), h('p', { class: 'lead' }, '瀏覽器不允許儲存資料（可能是無痕模式）。請改用一般模式開啟。'))); return; }
  await showLogin();
}

// ================= 登入與使用者 =================
function clearSession() {
  S.gen++;
  for (const u of S.urls.values()) URL.revokeObjectURL(u);
  S.urls.clear(); S.cards.clear(); S.cats = []; S.query = ''; S.cat = 'all'; S.selecting = false; S.selected.clear(); mainTab = 'list';
  S.pages = [];
  closeAllSheets(); document.querySelectorAll('.zoomer').forEach(z => z.remove());
  document.querySelectorAll('input[type=file]').forEach(i => i.remove());
  put(app(), );
  S.session?.close(); S.session = null;
}
async function lock(msg) { clearSession(); await showLogin(); if (msg) toast(msg); }

async function showLogin(preselect) {
  const users = await DB.listUsers();
  if (!users.length) return showCreateUser(true);
  const pre = users.find(u => u.id === preselect);
  if (pre) return showPin(pre, users.length > 1);
  if (preselect !== '__list__' && users.length === 1) return showPin(users[0], false);
  put(app(), h('div', { class: 'auth' },
    h('h1', {}, '名片夾'), h('p', { class: 'lead' }, '選擇使用者'),
    h('div', { class: 'users' }, users.map(u => h('button', { class: 'btn', onclick: () => showPin(u, true) }, h('span', { class: 'avatar' }, [...u.name][0]), u.name))),
    h('button', { class: 'btn ghost', style: { marginTop: '18px' }, onclick: () => showCreateUser(false) }, '＋ 新增使用者')));
}

function showCreateUser(first) {
  const name = h('input', { class: 'inp', placeholder: '例如：蝴蝶', maxlength: 30, autocomplete: 'off' });
  const pin = h('input', { class: 'inp', type: 'password', inputmode: 'numeric', pattern: '[0-9]*', maxlength: 8, placeholder: '4–8 位數字', autocomplete: 'new-password' });
  const pin2 = h('input', { class: 'inp', type: 'password', inputmode: 'numeric', pattern: '[0-9]*', maxlength: 8, placeholder: '再輸入一次', autocomplete: 'new-password' });
  const err = h('div', { class: 'err-msg' });
  const go = async () => {
    err.textContent = '';
    if (pin.value !== pin2.value) { err.textContent = '兩次輸入的 PIN 不一致'; return; }
    btn.disabled = true; btn.textContent = '建立中…';
    try { const s = await DB.createUser(name.value, pin.value); await enterSession(s); }
    catch (e) { err.textContent = e.message; btn.disabled = false; btn.textContent = '建立並開始使用'; }
  };
  const btn = h('button', { class: 'btn primary big', onclick: go }, '建立並開始使用');
  put(app(), h('div', { class: 'auth' },
    h('h1', {}, first ? '歡迎使用名片夾' : '新增使用者'),
    h('p', { class: 'lead' }, '資料只存在這支手機，不需要 Email 或網路註冊。每位使用者有自己的名片庫與 PIN。'),
    h('label', { class: 'field' }, h('span', { class: 'lb' }, '使用者名稱'), name),
    h('label', { class: 'field' }, h('span', { class: 'lb' }, '設定 PIN'), pin),
    h('label', { class: 'field' }, h('span', { class: 'lb' }, '確認 PIN'), pin2),
    err, btn,
    first ? null : h('button', { class: 'btn ghost', style: { marginTop: '10px' }, onclick: () => showLogin() }, '返回')));
  name.focus();
}

function showPin(user, canSwitch) {
  let val = '';
  const dots = h('div', { class: 'pin-dots', 'aria-label': 'PIN' });
  const err = h('div', { class: 'err-msg' });
  const draw = () => { put(dots, ...Array.from({ length: Math.max(4, val.length) }, (_, i) => h('i', { class: i < val.length ? 'on' : '' }))); };
  const submit = async () => {
    if (val.length < 4) { err.textContent = 'PIN 至少 4 位'; return; }
    err.textContent = '解鎖中…';
    try { const s = await DB.unlock(user.id, val); await enterSession(s); }
    catch (e) { val = ''; draw(); err.textContent = e.message; }
  };
  const press = d => { err.textContent = ''; if (d === 'del') val = val.slice(0, -1); else if (d === 'ok') return submit(); else if (val.length < 8) val += d; draw(); };
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'del', '0', 'ok'];
  const pad = h('div', { class: 'pad' }, keys.map(k => h('button', { class: k.length > 1 ? 'fn' : '', 'aria-label': k === 'del' ? '刪除' : k === 'ok' ? '確定' : k, onclick: () => press(k) }, k === 'del' ? '刪除' : k === 'ok' ? '確定' : k)));
  const hidden = h('input', { type: 'password', inputmode: 'numeric', autocomplete: 'current-password', 'aria-label': '輸入 PIN', style: { position: 'absolute', opacity: 0, width: '1px', height: '1px' },
    onkeydown: e => { if (/^\d$/.test(e.key)) press(e.key); else if (e.key === 'Backspace') press('del'); else if (e.key === 'Enter') press('ok'); e.preventDefault(); } });
  draw();
  put(app(), h('div', { class: 'auth' },
    h('h1', {}, user.name), h('p', { class: 'lead' }, '輸入 PIN 解鎖'), dots, err, hidden, pad,
    h('div', { class: 'row-btns', style: { justifyContent: 'center', marginTop: '16px' } },
      canSwitch ? h('button', { class: 'linkbtn', onclick: () => showLogin('__list__') }, '切換使用者') : null,
      h('button', { class: 'linkbtn', onclick: () => showCreateUser(false) }, '新增使用者'))));
  hidden.focus();
}

async function enterSession(session) {
  clearSession();
  S.session = session;
  const gen = S.gen;
  S.cats = await session.getCategories();
  const cards = await session.loadCards();
  if (gen !== S.gen) return;
  for (const c of cards) S.cards.set(c.id, c);
  navigator.storage?.persist?.().catch(() => {});
  history.replaceState({ root: true }, '');
  renderMain();
  drainInbox();
}
async function reloadCards() {
  const cards = await S.session.loadCards();
  S.cards.clear(); for (const c of cards) S.cards.set(c.id, c);
  S.cats = await S.session.getCategories();
}

// 由系統分享（Android）或檔案開啟交進來的名片包
async function drainInbox() {
  try {
    if ('caches' in window) {
      const cache = await caches.open('mpj-inbox');
      const keys = await cache.keys();
      for (const k of keys) {
        const r = await cache.match(k); await cache.delete(k);
        if (r) S.pendingFiles.push(new File([await r.blob()], decodeURIComponent(r.headers.get('x-name') || '名片包.json'), { type: 'application/json' }));
      }
    }
  } catch { }
  const f = S.pendingFiles.shift();
  if (f && S.session) importFromFile(f);
}

// ================= 照片網址（解密後的暫存預覽，鎖定時全部清除） =================
async function photoURL(id) {
  if (!id) return null;
  if (S.urls.has(id)) return S.urls.get(id);
  const gen = S.gen;
  const p = await S.session.getPhoto(id);
  if (!p || gen !== S.gen) return null;
  const u = URL.createObjectURL(new Blob([p.bytes], { type: p.mime }));
  S.urls.set(id, u);
  return u;
}
function imgInto(el, id, alt) {
  photoURL(id).then(u => { if (u && el.isConnected !== false) put(el, h('img', { src: u, alt: alt || '' })); });
}
function avatarEl(card, big) {
  const el = h('span', { class: 'avatar' + (big ? ' lg' : ''), 'aria-hidden': 'true' }, C.initialOf(card));
  if (card.photos?.avatar) imgInto(el, card.photos.avatar, '大頭照');
  return el;
}

// ================= 頁面堆疊 =================
function pushPage(el, opts = {}) {
  const entry = { el, ...opts };
  S.pages.push(entry);
  app().append(el);
  history.pushState({ page: S.pages.length }, '');
  return entry;
}
function closePage() { history.back(); }
async function onPop() {
  const top = S.pages[S.pages.length - 1];
  if (!top) return;
  if (top.guard && top.guard()) {
    history.pushState({ page: S.pages.length }, '');
    const ok = await confirmBox('放棄未儲存的變更？', '這張名片的修改尚未儲存。', '放棄', true);
    if (!ok) return;
    top.guard = null; history.back(); return;
  }
  S.pages.pop(); top.el.remove(); top.onClose?.();
}
function pageShell(title, { back = '返回', action = null, body, bottom = null }) {
  return h('div', { class: 'page' },
    h('div', { class: 'topbar' }, h('button', { class: 'back', onclick: closePage }, '‹ ' + back), h('h1', { style: { fontSize: '18px', textAlign: 'center' } }, title), action || h('span', { style: { minWidth: '44px' } })),
    h('div', { class: 'content' }, body), bottom);
}

// ================= 主畫面 =================
let mainTab = 'list';
function renderMain() {
  const content = h('div', { class: 'content', id: 'main-content' });
  const tab = (id, label, ic, extra = '') => h('button', { class: (mainTab === id ? 'on ' : '') + extra, 'aria-label': label, onclick: () => onTab(id) },
    extra === 'cam' ? h('span', { class: 'bubble' }, icon(ic)) : icon(ic), label);
  const bar = h('nav', { class: 'tabbar' }, tab('list', '名片夾', 'cards'), tab('capture', '拍名片', 'camera', 'cam'), tab('me', '我的', 'me'));
  const shell = h('div', { class: 'shell', id: 'main' }, h('div', { id: 'main-top' }), content, bar);
  const old = $('#main'); if (old) old.replaceWith(shell); else app().prepend(shell);
  if (mainTab === 'me') renderMe(); else renderList();
}
function onTab(id) {
  if (id === 'capture') { openEditor(null, { auto: 'camera' }); return; }
  mainTab = id; S.selecting = false; S.selected.clear(); renderMain();
}

// ---------- 名片夾 ----------
function renderList() {
  const top = $('#main-top'); const content = $('#main-content');
  const selBtn = h('button', { class: 'act', onclick: () => { S.selecting = !S.selecting; S.selected.clear(); renderList(); } }, S.selecting ? '取消' : '選取');
  const input = h('input', { type: 'search', placeholder: '搜尋姓名、公司、電話、場合、備註…', value: S.query, 'aria-label': '搜尋', enterkeyhint: 'search',
    oninput: () => { S.query = input.value; clr.classList.toggle('hidden', !input.value); drawRows(); } });
  const clr = h('button', { class: 'clear' + (S.query ? '' : ' hidden'), 'aria-label': '清除搜尋', onclick: () => { input.value = ''; S.query = ''; clr.classList.add('hidden'); drawRows(); input.focus(); } }, '×');
  const all = [...S.cards.values()];
  const hasPending = all.some(c => c.status === 'pending');
  const chipDefs = [['all', '全部'], ['none', '未分類'], ...S.cats.map(c => [c.id, c.name]), ...(hasPending ? [['pending', '待整理']] : [])];
  if (!chipDefs.some(([id]) => id === S.cat)) S.cat = 'all';
  const chips = h('div', { class: 'chips', role: 'tablist' }, chipDefs.map(([id, n]) => h('button', { class: 'chip' + (S.cat === id ? ' on' : ''), role: 'tab', 'aria-selected': String(S.cat === id), onclick: () => { S.cat = id; renderList(); } }, n)));
  const count = h('span');
  const sort = h('select', { 'aria-label': '排序', onchange: () => { S.sort = sort.value; drawRows(); } },
    [['created', '最近新增'], ['name', '依姓名'], ['updated', '最近更新']].map(([v, l]) => h('option', { value: v, selected: S.sort === v }, l)));
  put(top, h('div', { class: 'topbar' }, h('h1', {}, '名片夾'), selBtn),
    h('div', { class: 'search' }, icon('search'), input, clr), chips, h('div', { class: 'listbar' }, count, sort));
  const ul = h('ul', { class: 'list', id: 'card-list' });
  const selBar = h('div', { class: 'bottombar', style: { bottom: 'calc(var(--tab-h) + var(--safe-b))' } });
  put(content, ul);
  if (S.selecting) content.append(selBar);

  function drawRows() {
    const list = C.filterCards(all, { query: S.query, categoryId: S.cat, sort: S.sort }, catsById());
    count.textContent = `${list.length} 位` + (S.query ? '（搜尋結果）' : '');
    if (!all.length) {
      ul.replaceWith(h('div', { class: 'empty', id: 'card-list' }, h('p', {}, '還沒有名片。'), h('button', { class: 'btn primary', onclick: () => openEditor(null, { auto: 'camera' }) }, '拍第一張名片')));
      drawSelBar(list); return;
    }
    const cur = $('#card-list'); if (cur && cur !== ul) cur.replaceWith(ul);
    put(ul, ...(list.length ? list.map(row) : [h('li', { class: 'empty' }, '找不到符合的名片')]));
    drawSelBar(list);
  }
  function drawSelBar(list) {
    if (S.selecting) {
      const n = S.selected.size;
      put(selBar, 
        h('button', { class: 'btn', onclick: () => { const ids = list.map(c => c.id); const allOn = ids.every(i => S.selected.has(i)); ids.forEach(i => allOn ? S.selected.delete(i) : S.selected.add(i)); drawRows(); } }, '全選'),
        h('button', { class: 'btn primary', disabled: !n, onclick: () => exportMenu([...S.selected].map(id => S.cards.get(id)).filter(Boolean)) }, `匯出 ${n} 張…`));
    }
  }
  function row(c) {
    const sub = [c.name ? c.company : '', c.title].filter(Boolean).join('・') || (c.name ? '' : c.title || '');
    const on = S.selected.has(c.id);
    return h('li', {}, h('button', { class: 'item', 'data-id': c.id, onclick: () => {
      if (S.selecting) { on ? S.selected.delete(c.id) : S.selected.add(c.id); drawRows(); } else openDetail(c.id);
    } },
      S.selecting ? h('span', { class: 'check' + (on ? ' on' : '') }, on ? '✓' : '') : null,
      avatarEl(c),
      h('span', { class: 'meta' },
        h('div', { class: 'nm' }, c.name || c.company || '（未命名）', c.status === 'pending' ? h('span', { class: 'badge warn' }, '待整理') : null, c.source?.type === 'import' ? h('span', { class: 'badge brand' }, '匯入') : null),
        h('div', { class: 'sub' }, sub || '　'))));
  }
  drawRows();
}

// ---------- 名片詳情 ----------
function openDetail(id) {
  const body = h('div');
  const editBtn = h('button', { class: 'act', onclick: () => { const c = S.cards.get(id); if (c) openEditor(c, { onSaved: draw }); } }, '編輯');
  const page = pageShell('', { back: '名片夾', action: editBtn, body });
  pushPage(page, { onClose: () => renderMainKeepScroll() });
  function draw() {
    const c = S.cards.get(id);
    if (!c) { closePage(); return; }
    const phones = c.phones || []; const emails = c.emails || [];
    const telHref = p => 'tel:' + C.phoneDigits(p.value) + (p.ext ? ',' + C.phoneDigits(p.ext) : '');
    const callBtn = h('button', { class: 'btn primary', disabled: !phones.length, onclick: async () => {
      const p = phones.length === 1 ? phones[0] : await menu('撥打哪一支電話？', phones.map(p => ({ label: `${p.label || '電話'}　${p.value}${p.ext ? ' 分機 ' + p.ext : ''}`, value: p })));
      if (p) location.href = telHref(p);
    } }, '撥電話');
    const mailBtn = h('button', { class: 'btn', disabled: !emails.length, onclick: async () => {
      const e = emails.length === 1 ? emails[0] : await menu('寄到哪個 Email？', emails.map(e => ({ label: `${e.label ? e.label + '　' : ''}${e.value}`, value: e })));
      if (e) location.href = 'mailto:' + e.value;
    } }, '寄信');
    const kv = (k, v) => v ? h('div', { class: 'kv' }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v)) : null;
    const contact = [
      ...phones.map(p => kv(p.label || '電話', h('a', { href: telHref(p) }, p.value + (p.ext ? `　分機 ${p.ext}` : '')))),
      ...emails.map(e => kv(e.label || 'Email', h('a', { href: 'mailto:' + e.value }, e.value))),
      kv('地址', c.address), kv('網站', c.website ? h('a', { href: /^https?:/i.test(c.website) ? c.website : 'https://' + c.website, target: '_blank', rel: 'noopener' }, c.website) : null),
      kv('LINE ID', c.lineId)].filter(Boolean);
    const thumb = kind => {
      const t = h('button', { class: 'thumb', 'aria-label': C.FIELD_LABELS[kind] }, c.photos?.[kind] ? '載入中…' : '＋ 補拍' + C.FIELD_LABELS[kind].replace('名片', ''));
      if (c.photos?.[kind]) {
        photoURL(c.photos[kind]).then(u => { if (u) put(t, h('img', { src: u, alt: C.FIELD_LABELS[kind] }), h('span', { class: 'cap' }, C.FIELD_LABELS[kind])); });
        t.onclick = async () => { const u = await photoURL(c.photos[kind]); if (u) zoomImage(u, C.FIELD_LABELS[kind]); };
      } else t.onclick = () => openEditor(c, { face: kind, auto: 'camera', onSaved: draw });
      return t;
    };
    const src = c.source?.type === 'import' ? `由「${c.source.provider}」分享，匯入於 ${fmtDate(c.source.importedAt)}` : '自行建立';
    put(body, 
      h('div', { class: 'hero' }, avatarEl(c, true), h('div', {},
        h('div', { class: 'nm' }, c.name || c.company || '（未命名）'),
        c.name && c.company ? h('div', { class: 'sub' }, c.company) : null,
        (c.dept || c.title) ? h('div', { class: 'sub' }, [c.dept, c.title].filter(Boolean).join('　')) : null,
        c.status === 'pending' ? h('span', { class: 'badge warn', style: { marginLeft: 0 } }, '待整理') : null)),
      h('div', { class: 'quick' }, callBtn, mailBtn),
      h('div', { class: 'quick', style: { paddingTop: '6px' } },
        h('button', { class: 'btn', onclick: () => addLogSheet(c, draw) }, '新增往來'),
        h('button', { class: 'btn', onclick: () => openExport([c]) }, '分享名片')),
      h('div', { class: 'section' }, h('h2', {}, '聯絡資訊'), contact.length ? contact : h('div', { class: 'muted' }, '尚無聯絡資料')),
      h('div', { class: 'section' }, h('h2', {}, '名片正反面'), h('div', { class: 'thumbs' }, thumb('front'), thumb('back')),
        h('div', { style: { marginTop: '10px' } }, h('div', { class: 'thumbs', style: { gridTemplateColumns: '1fr 1fr' } }, thumb('avatar')))),
      h('div', { class: 'section' }, h('h2', {}, '分類與標籤'), kv('分類', catName(c.categoryId) || '未分類'),
        kv('標籤', (c.tags || []).length ? h('span', {}, c.tags.map(t => h('span', { class: 'tag' }, t))) : h('span', { class: 'muted' }, '無'))),
      h('div', { class: 'section' }, h('h2', {}, '認識資訊'), kv('認識日期', c.metDate || h('span', { class: 'muted' }, '未填')), kv('認識場合', c.metPlace || h('span', { class: 'muted' }, '未填')),
        kv('建立時間', fmtDate(c.createdAt)), kv('更新時間', fmtDate(c.updatedAt)), kv('來源', src),
        (c.imports || []).length > (c.source?.type === 'import' ? 1 : 0) ? kv('匯入紀錄', c.imports.map(i => `${fmtDate(i.at)}　${i.provider}`).join('\n')) : null),
      h('div', { class: 'section' }, h('h2', {}, '固定備註'), c.note ? h('div', { style: { whiteSpace: 'pre-wrap' } }, c.note) : h('div', { class: 'muted' }, '無'),
        h('button', { class: 'linkbtn', onclick: async () => {
          const v = await sheet(close => { const ta = h('textarea', { class: 'inp', style: { minHeight: '120px' } }, c.note || ''); return h('div', {}, h('h3', {}, '固定備註'), ta, h('div', { class: 'acts' }, h('button', { class: 'btn', onclick: () => close(null) }, '取消'), h('button', { class: 'btn primary', onclick: () => close(ta.value) }, '儲存'))); });
          if (v == null) return; const n = structuredClone(c); n.note = v.trim(); n.updatedAt = C.nowISO(); await saveCardOnly(n); draw();
        } }, '編輯備註')),
      h('div', { class: 'section logs' }, h('h2', {}, `往來紀錄（${(c.logs || []).length}）`),
        (c.logs || []).length ? c.logs.map(l => h('div', { class: 'log' }, h('div', { class: 'd' }, (l.date || '').replace(/-/g, '/')), h('div', { class: 't' }, l.text),
          h('button', { class: 'linkbtn', style: { color: 'var(--danger)' }, 'aria-label': '刪除這筆往來', onclick: async () => {
            if (!await confirmBox('刪除這筆往來紀錄？', l.text, '刪除', true)) return;
            const n = structuredClone(c); n.logs = n.logs.filter(x => x.id !== l.id); n.updatedAt = C.nowISO(); await saveCardOnly(n); draw();
          } }, '×'))) : h('div', { class: 'muted' }, '尚無紀錄'),
        h('button', { class: 'btn small', style: { marginTop: '8px' }, onclick: () => addLogSheet(c, draw) }, '＋ 新增往來')),
      rawTextSection(c));
  }
  draw();
}
function rawTextSection(c) {
  const faces = ['front', 'back'].filter(k => c.ocr?.[k]?.text);
  if (!faces.length) return null;
  return h('div', { class: 'section' }, h('h2', {}, '辨識原文'),
    faces.map(k => h('details', {}, h('summary', {}, C.FIELD_LABELS[k]), h('pre', { style: { whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: '14px' } }, c.ocr[k].text))));
}
async function saveCardOnly(card) {
  await S.session.saveCard(card); S.cards.set(card.id, card);
}
function renderMainKeepScroll() {
  if (!S.session) return;
  const sc = $('#main-content')?.scrollTop || 0;
  if (mainTab === 'me') renderMe(); else renderList();
  const mc = $('#main-content'); if (mc) mc.scrollTop = sc;
}
async function addLogSheet(c, after) {
  const r = await sheet(close => {
    const d = h('input', { class: 'inp', type: 'date', value: today() });
    const t = h('textarea', { class: 'inp', style: { minHeight: '110px' }, placeholder: '例如：電話確認管委會下週開會' });
    return h('div', {}, h('h3', {}, '新增往來紀錄'),
      h('label', { class: 'field' }, h('span', { class: 'lb' }, '日期'), d),
      h('label', { class: 'field' }, h('span', { class: 'lb' }, '內容'), t),
      h('div', { class: 'acts' }, h('button', { class: 'btn', onclick: () => close(null) }, '取消'), h('button', { class: 'btn primary', onclick: () => close({ date: d.value, text: t.value }) }, '新增')));
  });
  if (!r || !r.text.trim()) return;
  const cur = S.cards.get(c.id) || c;
  const n = structuredClone(cur);
  n.logs = n.logs || [];
  n.logs.push({ id: C.uuid(), date: r.date || today(), text: r.text.trim(), createdAt: C.nowISO() });
  C.sortLogs(n); n.updatedAt = C.nowISO();
  await saveCardOnly(n); toast('已新增往來紀錄'); after?.();
}

// ================= 拍名片／核對／編輯 =================
function openEditor(existing, opts = {}) {
  const isNew = !existing;
  let card = existing ? structuredClone(existing) : C.emptyCard();
  card.manual = card.manual || {}; card.review = card.review || {}; card.ocr = card.ocr || { front: null, back: null };
  const pend = { front: null, back: null, avatar: null };
  const removed = new Set();
  const ocrSt = { front: { s: 'idle' }, back: { s: 'idle' } };
  const parsed = { front: null, back: null };
  let candidates = {};
  let face = opts.face || 'front';
  let dirty = false; let manualMode = !isNew; let forcePending = false;

  const viewer = h('div', { class: 'viewer' });
  const faces = h('div', { class: 'faces', role: 'tablist' });
  const slotbar = h('div', { class: 'slotbar' });
  const status = h('div');
  const form = h('div');
  const bottom = h('div', { class: 'bottombar' });
  const body = h('div', {}, viewer, faces, slotbar, status, form);
  const page = pageShell(isNew ? '新增名片' : '編輯名片', { back: '取消', body, bottom });
  const entry = pushPage(page, { guard: () => dirty });

  const hasPhoto = k => !!(pend[k] || (!removed.has(k) && card.photos?.[k]));
  const photoUrlOf = async k => pend[k]?.url || (!removed.has(k) && card.photos?.[k] ? await photoURL(card.photos[k]) : null);

  async function drawViewer() {
    const u = await photoUrlOf(face);
    if (u) put(viewer, h('img', { src: u, alt: C.FIELD_LABELS[face], onclick: () => zoomImage(u, C.FIELD_LABELS[face]) }), h('button', { class: 'zoom', onclick: () => zoomImage(u, C.FIELD_LABELS[face]) }, '放大'));
    else put(viewer, h('div', { class: 'ph' }, isNew && !manualMode && face === 'front' ? h('div', {}, h('div', { style: { fontSize: '17px', color: '#dfe6e2', marginBottom: '6px' } }, '先拍名片正面'), '拍完會自動辨識文字') : `尚未加入${C.FIELD_LABELS[face]}`));
  }
  function drawFaces() {
    const lab = { front: '正面', back: '背面', avatar: '大頭照' };
    put(faces, ...['front', 'back', 'avatar'].map(k => {
      const st = ocrSt[k]?.s === 'run' ? '辨識中…' : hasPhoto(k) ? '已加入' : (k === 'front' ? '未拍' : '可略過');
      return h('button', { class: face === k ? 'on' : '', role: 'tab', 'aria-selected': String(face === k), onclick: () => {
        face = k; drawAll();
        if (!hasPhoto(k) && k !== 'front') capture(k, 'camera');
      } }, (hasPhoto(k) || k === 'front' ? '' : '＋') + lab[k], h('span', { class: 'st' }, st));
    }));
    const k = face;
    put(slotbar, 
      h('button', { class: 'btn small', onclick: () => capture(k, 'camera') }, hasPhoto(k) ? '重拍' : '拍攝'),
      h('button', { class: 'btn small', onclick: () => capture(k, 'album') }, hasPhoto(k) ? '從相簿替換' : '從相簿選'),
      hasPhoto(k) ? h('button', { class: 'btn small', onclick: async () => { const u = await photoUrlOf(k); if (u) zoomImage(u, C.FIELD_LABELS[k]); } }, '查看') : null,
      hasPhoto(k) ? h('button', { class: 'btn small danger', onclick: async () => {
        if (!await confirmBox(`移除${C.FIELD_LABELS[k]}？`, '儲存後才會真正刪除。', '移除', true)) return;
        if (pend[k]) { URL.revokeObjectURL(pend[k].url); pend[k] = null; }
        if (card.photos?.[k]) removed.add(k);
        dirty = true; drawAll();
      } }, '移除') : null,
      hasPhoto(k) && k !== 'avatar' ? h('button', { class: 'btn small', onclick: () => runOCR(k) }, '重新辨識') : null);
  }
  function drawStatus() {
    const st = ocrSt[face] || { s: 'idle' };
    const any = ['front', 'back'].find(k => ocrSt[k].s === 'run');
    if (any) {
      const p = ocrSt[any];
      put(status, h('div', { class: 'status' }, `正在辨識${C.FIELD_LABELS[any]}…${p.msg ? '（' + p.msg + '）' : ''}`, h('div', { class: 'progress' }, h('i', { style: { width: Math.round((p.p || 0) * 100) + '%' } })),
        h('div', { class: 'small muted', style: { marginTop: '4px' } }, '可以先填其他欄位或加拍背面、大頭照。')));
    } else if (st.s === 'fail') {
      put(status, h('div', { class: 'status err' }, h('b', {}, '辨識失敗：'), st.err || '沒有辨識到文字', h('div', { class: 'small' }, '照片已保留，不需要重拍。'),
        h('div', { class: 'row-btns' },
          h('button', { class: 'btn small', onclick: () => runOCR(face) }, '重試'),
          h('button', { class: 'btn small', onclick: () => { manualMode = true; drawAll(); form.querySelector('input')?.focus(); } }, '手動輸入'),
          h('button', { class: 'btn small', onclick: () => save(true) }, '存為待整理'))));
    } else if (st.s === 'done') {
      const n = Object.keys(card.review || {}).filter(k => card.review[k]).length;
      put(status, h('div', { class: 'status' + (n ? ' warn' : '') }, n ? `已辨識。有 ${n} 個欄位標示「請核對」，請確認後儲存。` : '已辨識，請核對內容後儲存。'));
    } else put(status, );
  }
  function fieldEl(f, attrs = {}, multiline = false) {
    const rv = !!card.review?.[f];
    const inp = multiline ? h('textarea', { ...attrs }, card[f] || '') : h('input', { value: card[f] || '', ...attrs });
    const wrap = h('label', { class: 'field' + (rv ? ' review' : ''), 'data-field': f });
    const lb = h('span', { class: 'lb' }, C.FIELD_LABELS[f] || f, rv ? h('span', { class: 'rv' }, '請核對') : null);
    inp.addEventListener('input', () => {
      card[f] = inp.value; card.manual[f] = true; delete card.review[f]; dirty = true;
      wrap.classList.remove('review'); lb.querySelector('.rv')?.remove(); cands?.remove();
    });
    const cl = (candidates[f] || []).filter(v => v !== card[f]);
    const cands = rv && cl.length ? h('div', { class: 'cands' }, h('span', { class: 'small muted' }, '其他候選：'), cl.map(v => h('button', { type: 'button', onclick: e => { e.preventDefault(); inp.value = v; inp.dispatchEvent(new Event('input')); } }, v))) : null;
    wrap.append(lb, inp); if (cands) wrap.append(cands);
    return wrap;
  }
  function multiEl(kind) {
    const isPhone = kind === 'phones';
    const rv = !!card.review?.[kind];
    const box = h('div', { class: 'field' + (rv ? ' review' : '') });
    const mark = () => { card.manual[kind] = true; delete card.review[kind]; dirty = true; };
    const draw = () => {
      put(box, h('span', { class: 'lb' }, isPhone ? '電話（可多筆）' : 'Email（可多筆）', card.review?.[kind] ? h('span', { class: 'rv' }, '請核對') : null));
      (card[kind] || []).forEach((it, i) => {
        const labSel = isPhone
          ? h('select', { 'aria-label': '用途', onchange: e => { it.label = e.target.value; mark(); } }, C.PHONE_LABELS.map(l => h('option', { selected: it.label === l }, l)))
          : h('input', { value: it.label || '', placeholder: '用途', 'aria-label': '用途', oninput: e => { it.label = e.target.value; mark(); } });
        const val = h('input', { value: it.value || '', type: isPhone ? 'tel' : 'email', inputmode: isPhone ? 'tel' : 'email', placeholder: isPhone ? '例如 02-2700-1234' : 'name@example.com', 'aria-label': isPhone ? '電話號碼' : 'Email', oninput: e => { it.value = e.target.value; mark(); } });
        const ext = isPhone ? h('input', { value: it.ext || '', placeholder: '分機', inputmode: 'numeric', 'aria-label': '分機', oninput: e => { it.ext = e.target.value; mark(); } }) : null;
        const del = h('button', { type: 'button', class: 'x', 'aria-label': '刪除這筆', onclick: () => { card[kind].splice(i, 1); mark(); draw(); } }, '×');
        box.append(h('div', { class: 'multi' + (isPhone ? '' : ' em') }, labSel, val, ext, del));
      });
      box.append(h('button', { type: 'button', class: 'linkbtn', onclick: () => { card[kind] = card[kind] || []; card[kind].push(isPhone ? { label: '手機', value: '', ext: '' } : { label: '', value: '' }); mark(); draw(); box.querySelectorAll('input[type=' + (isPhone ? 'tel' : 'email') + ']').forEach((x, j, a) => j === a.length - 1 && x.focus()); } }, isPhone ? '＋ 新增電話' : '＋ 新增 Email'));
    };
    draw();
    return box;
  }
  function drawForm() {
    if (isNew && !manualMode && !hasPhoto('front') && ocrSt.front.s === 'idle') {
      put(form, h('div', { class: 'cap-empty' },
        h('p', { class: 'muted' }, '拍下名片正面，系統會在手機上辨識文字（不會上傳照片）。背面、大頭照可以略過，儲存後也能補拍。'),
        h('button', { class: 'linkbtn', onclick: () => { manualMode = true; drawAll(); form.querySelector('input')?.focus(); } }, '沒有紙本名片？手動新增')));
      return;
    }
    const catSel = h('select', { onchange: () => { card.categoryId = catSel.value || null; dirty = true; } },
      h('option', { value: '' }, '未分類'), S.cats.map(c => h('option', { value: c.id, selected: card.categoryId === c.id }, c.name)));
    const tags = h('input', { value: (card.tags || []).join('、'), placeholder: '用「、」或逗號分隔，例如：外牆、台北', oninput: () => { card.tags = [...new Set(tags.value.split(/[、,，;；\s]+/).map(s => s.trim()).filter(Boolean))]; dirty = true; } });
    const raw = ['front', 'back'].filter(k => card.ocr?.[k]?.text);
    put(form, 
      h('div', { class: 'section' }, h('h2', {}, '基本資料'),
        fieldEl('name', { autocomplete: 'off', placeholder: '姓名' }), fieldEl('company', { placeholder: '公司' }),
        fieldEl('dept', { placeholder: '部門' }), fieldEl('title', { placeholder: '職稱' })),
      h('div', { class: 'section' }, h('h2', {}, '聯絡資料'), multiEl('phones'), multiEl('emails'),
        fieldEl('address', {}, true), fieldEl('website', { inputmode: 'url', autocapitalize: 'off' }), fieldEl('lineId', { autocapitalize: 'off' })),
      h('div', { class: 'section' }, h('h2', {}, '分類與認識資訊（皆可不填）'),
        h('label', { class: 'field' }, h('span', { class: 'lb' }, '分類'), catSel),
        h('label', { class: 'field' }, h('span', { class: 'lb' }, '標籤'), tags),
        h('label', { class: 'field' }, h('span', { class: 'lb' }, '認識日期（可回填實際日期）'), h('input', { type: 'date', value: card.metDate || '', oninput: e => { card.metDate = e.target.value; dirty = true; } })),
        fieldEl('metPlace', { placeholder: '例如：2026 台北建材展' }),
        fieldEl('note', { placeholder: '例如：聯絡前先傳 LINE' }, true)),
      raw.length ? h('div', { class: 'section raw' }, h('h2', {}, '辨識原文（點一行可填入欄位）'),
        raw.map(k => h('details', { open: true }, h('summary', {}, C.FIELD_LABELS[k]),
          card.ocr[k].text.split('\n').filter(s => s.trim()).map(line => h('button', { type: 'button', class: 'ln', onclick: () => assignLine(line) }, line))))) : null,
      !isNew ? h('div', { class: 'section' }, h('button', { class: 'btn danger', style: { width: '100%' }, onclick: delCard }, '刪除這張名片')) : null);
  }
  async function assignLine(line) {
    const opts2 = [...C.SCALAR_FIELDS, 'metPlace', 'note'].map(f => ({ label: `${C.FIELD_LABELS[f]}${card[f] ? '（目前：' + card[f].slice(0, 14) + '）' : ''}`, value: f }));
    opts2.push({ label: '新增為電話', value: 'phones' }, { label: '新增為 Email', value: 'emails' });
    const f = await menu(`「${line.slice(0, 24)}」填入…`, opts2);
    if (!f) return;
    const v = C.tidyOcrLine(line);
    if (f === 'phones') card.phones.push({ label: '公司', value: v, ext: '' });
    else if (f === 'emails') card.emails.push({ label: '', value: v });
    else card[f] = v;
    card.manual[f] = true; delete card.review[f]; dirty = true; drawForm();
  }
  function drawBottom() {
    const failed = ['front', 'back'].some(k => ocrSt[k].s === 'fail') || ['front', 'back'].some(k => ocrSt[k].s === 'run');
    if (isNew && !manualMode && !hasPhoto('front') && ocrSt.front.s === 'idle') {
      put(bottom, h('button', { class: 'btn', onclick: () => capture('front', 'album') }, '從相簿選'), h('button', { class: 'btn primary big', style: { flex: 2 }, onclick: () => capture('front', 'camera') }, '拍攝'));
      return;
    }
    put(bottom, 
      isNew && failed ? h('button', { class: 'btn', onclick: () => save(true) }, '存為待整理') : null,
      h('button', { class: 'btn primary big', style: { flex: 2 }, onclick: () => save(false) }, '儲存名片'));
  }
  function drawAll() { drawViewer(); drawFaces(); drawStatus(); drawForm(); drawBottom(); }

  // 拍攝／選圖（需在使用者點擊時同步呼叫，相機才會開啟）
  function capture(kind, how) {
    const p = pickFile({ accept: 'image/*', capture: how === 'camera' ? 'environment' : null });
    p.then(async file => {
      if (!file || !S.session || !entry.el.isConnected) return;
      try {
        const img = await compressImage(file, kind === 'avatar' ? 900 : 1800, 0.85);
        if (pend[kind]) URL.revokeObjectURL(pend[kind].url);
        pend[kind] = { bytes: img.bytes, mime: img.mime, blob: img.blob, url: URL.createObjectURL(img.blob) };
        removed.delete(kind); face = kind; dirty = true;
        drawAll();
        if (kind !== 'avatar') runOCR(kind);
      } catch (e) { toast('無法讀取照片：' + e.message); }
    });
  }

  async function runOCR(kind) {
    const blob = pend[kind]?.blob || (card.photos?.[kind] ? await S.session.getPhoto(card.photos[kind]).then(p => p && new Blob([p.bytes], { type: p.mime })) : null);
    if (!blob) return;
    ocrSt[kind] = { s: 'run', p: 0 }; drawFaces(); drawStatus(); drawBottom();
    const gen = S.gen;
    try {
      const res = await OCR.recognize(blob, m => {
        if (m.status === 'recognizing text') ocrSt[kind].p = m.progress;
        else ocrSt[kind].msg = m.status?.includes('load') ? '首次載入辨識模型' : '';
        if (face === kind || ocrSt[kind].s === 'run') drawStatus();
      });
      if (gen !== S.gen || !entry.el.isConnected) return;
      const pr = C.parseCardText(res.lines?.length ? res.lines : res.text);
      card.ocr[kind] = { text: res.text, at: C.nowISO() };
      parsed[kind] = pr;
      if (!res.text.trim() || (!Object.keys(pr.fields).length && !pr.phones.length && !pr.emails.length)) {
        ocrSt[kind] = { s: 'fail', err: '沒有辨識到可用的文字（可能是反光、模糊或角度太斜）' };
        dirty = true; drawAll(); return;
      }
      const anyManual = Object.values(card.manual || {}).some(Boolean);
      if (isNew && !anyManual) {
        const merged = C.mergeFaces(parsed.front, parsed.back);
        card = Object.assign(card, C.applyParsedToCard(card, merged));
        candidates = merged.candidates;
      } else {
        const sug = C.suggestChanges(card, pr);
        candidates = { ...candidates, ...pr.candidates };
        if (sug.length) {
          const chosen = await suggestSheet(kind, sug);
          if (chosen?.length) { card = Object.assign(card, C.applySuggestions(card, chosen)); for (const s of chosen) if (pr.review.has(s.field)) card.review[s.field] = true; }
        } else toast('辨識完成，沒有需要變更的欄位');
      }
      ocrSt[kind] = { s: 'done' }; dirty = true; drawAll();
    } catch (e) {
      if (gen !== S.gen) return;
      ocrSt[kind] = { s: 'fail', err: e.message || String(e) }; drawAll();
    }
  }
  function suggestSheet(kind, sug) {
    return sheet(close => {
      const boxes = sug.map(s => {
        const cb = h('input', { type: 'checkbox', checked: s.defaultOn });
        return { s, cb, el: h('label', { class: 'opt' }, cb, h('span', { class: 't' }, h('b', {}, C.FIELD_LABELS[s.field]), h('br'),
          s.kind === 'add' ? `新增：${s.to}` : s.kind === 'set' ? `填入：${s.to}` : h('span', {}, `「${s.from}」→「${s.to}」`))) };
      });
      return h('div', {}, h('h3', {}, `${C.FIELD_LABELS[kind]}辨識的建議變更`),
        h('p', { class: 'muted small' }, '你已手動修改的欄位不會被更動。勾選要套用的項目：'), boxes.map(b => b.el),
        h('div', { class: 'acts' }, h('button', { class: 'btn', onclick: () => close([]) }, '都不套用'), h('button', { class: 'btn primary', onclick: () => close(boxes.filter(b => b.cb.checked).map(b => b.s)) }, '套用所選')));
    }, { dismissable: false });
  }

  async function save(asPending) {
    if (!S.session) return;
    const c = structuredClone(card);
    for (const k of ['phones', 'emails']) c[k] = (c[k] || []).map(x => ({ ...x, value: (x.value || '').trim() })).filter(x => x.value);
    for (const f of [...C.SCALAR_FIELDS, 'metPlace', 'note']) c[f] = (c[f] || '').trim();
    const empty = !c.name && !c.company && !c.phones.length && !c.emails.length;
    c.status = asPending || (empty && hasPhoto('front')) ? 'pending' : 'ok';
    if (empty && !hasPhoto('front') && !hasPhoto('back')) { toast('請至少輸入姓名、公司、電話或 Email，或拍一張名片'); return; }
    const ops = []; const prevPhotos = existing?.photos || {};
    c.photos = { ...c.photos }; c.photoHashes = { ...(c.photoHashes || {}) };
    for (const k of ['front', 'back', 'avatar']) {
      if (pend[k]) {
        const p = await S.session.photoOp(pend[k].bytes, pend[k].mime);
        ops.push(p.op); c.photos[k] = p.id; c.photoHashes[k] = p.hash;
        if (prevPhotos[k]) ops.push(S.session.delPhotoOp(prevPhotos[k]));
      } else if (removed.has(k)) {
        if (prevPhotos[k]) ops.push(S.session.delPhotoOp(prevPhotos[k]));
        c.photos[k] = null; c.photoHashes[k] = null;
      }
    }
    c.updatedAt = C.nowISO(); if (isNew) c.createdAt = c.updatedAt;
    ops.push(await S.session.cardOp(c));
    try { await S.session.commit(ops); }
    catch (e) { toast('儲存失敗：' + e.message); return; }
    for (const k of ['front', 'back', 'avatar']) if (pend[k]) { S.urls.set(c.photos[k], pend[k].url); pend[k] = null; }
    for (const k of ['front', 'back', 'avatar']) if (prevPhotos[k] && prevPhotos[k] !== c.photos[k]) { const u = S.urls.get(prevPhotos[k]); if (u) URL.revokeObjectURL(u); S.urls.delete(prevPhotos[k]); }
    S.cards.set(c.id, c);
    dirty = false; entry.guard = null;
    toast(c.status === 'pending' ? '已存為「待整理」' : '名片已儲存');
    closePage();
    if (isNew) { mainTab = 'list'; setTimeout(() => { renderMain(); openDetail(c.id); }, 30); }
    else opts.onSaved?.();
  }
  async function delCard() {
    if (!await confirmBox('刪除這張名片？', '名片、照片與往來紀錄都會刪除，無法復原。', '刪除', true)) return;
    await S.session.deleteCard(existing);
    S.cards.delete(existing.id);
    dirty = false; entry.guard = null;
    toast('已刪除');
    // 關閉編輯頁與詳情頁
    closePage(); setTimeout(() => { if (S.pages.length) closePage(); }, 60);
  }

  drawAll();
  if (opts.auto === 'camera' && !hasPhoto(face)) capture(face, 'camera');
}

// ================= 匯出名片包 =================
async function openExport(cards) {
  if (!cards.length) return;
  const opts = C.defaultShareOptions();
  const res = await sheet(close => {
    const sum = h('div', { class: 'sumbox' });
    const drawSum = () => {
      const kinds = { front: cards.filter(c => c.photos?.front).length, back: cards.filter(c => c.photos?.back).length, avatar: opts.avatar ? cards.filter(c => c.photos?.avatar).length : 0 };
      const ph = [kinds.front && `正面 ${kinds.front} 張`, kinds.back && `背面 ${kinds.back} 張`, kinds.avatar && `大頭照 ${kinds.avatar} 張`].filter(Boolean).join('、') || '無照片';
      put(sum, h('div', {}, h('b', {}, `${cards.length} 張名片`), `　提供者：${S.session.user.name}`),
        h('div', { style: { marginTop: '6px' } }, '分享欄位：' + C.sharedFieldList(opts).join('、')),
        h('div', { style: { marginTop: '6px' } }, '照片：' + ph));
    };
    const optEls = Object.entries(C.SHARE_OPTIONS).map(([k, l]) => {
      const cb = h('input', { type: 'checkbox', checked: false, 'data-opt': k, onchange: () => { opts[k] = cb.checked; drawSum(); } });
      return h('label', { class: 'opt' }, cb, h('span', { class: 't' }, '一併分享' + l));
    });
    drawSum();
    return h('div', {}, h('h3', {}, '分享名片包'),
      h('p', { class: 'muted small' }, '預設只分享基本資料、聯絡資料及名片正反面。未勾選的資料完全不會放進檔案。'),
      optEls, sum,
      h('div', { class: 'acts' }, h('button', { class: 'btn', onclick: () => close('save') }, '儲存到檔案'), h('button', { class: 'btn primary', onclick: () => close('share') }, '分享…')),
      h('button', { class: 'btn ghost', style: { width: '100%', marginTop: '6px' }, onclick: () => close(null) }, '取消'));
  });
  if (!res) return;
  try {
    const { pack } = await C.buildPack(cards, { provider: S.session.user.name, options: opts, categoriesById: catsById(),
      photoLoader: async id => { const p = await S.session.getPhoto(id); return p && { mime: p.mime, b64: C.bytesToB64(p.bytes) }; } });
    const name = `名片包_${safeName(S.session.user.name)}_${stamp()}_${cards.length}張.json`;
    const file = new File([JSON.stringify(pack)], name, { type: 'application/json' });
    const r = await shareOrSave(file, res);
    if (r !== 'cancel') { toast(r === 'shared' ? '已送出名片包' : '名片包已儲存：' + name, 3200); S.selecting = false; S.selected.clear(); if (!S.pages.length) renderList(); }
  } catch (e) { toast('匯出失敗：' + e.message); }
}

// ================= 匯出選單、Excel、交給 Claude =================
async function exportMenu(cards) {
  const a = await menu(`匯出 ${cards.length} 張名片`, [
    { label: '名片包（分享給同事）', value: 'pack' },
    { label: 'Excel 表格（含名片照片）', value: 'excel' },
    { label: '交給 Claude 辨識（打包照片）', value: 'claude' },
  ]);
  if (a === 'pack') openExport(cards);
  else if (a === 'excel') exportExcel(cards);
  else if (a === 'claude') exportForClaude(cards);
}
let jszipP = null;
function loadJSZip() {
  if (window.JSZip) return Promise.resolve(window.JSZip);
  jszipP = jszipP || new Promise((res, rej) => {
    const s = h('script', { src: './js/vendor/jszip.min.js' });
    s.onload = () => res(window.JSZip); s.onerror = () => { jszipP = null; rej(new Error('無法載入壓縮元件')); };
    document.head.append(s);
  });
  return jszipP;
}
async function shrinkPhoto(id, maxW, maxH) {
  const p = await S.session.getPhoto(id); if (!p) return null;
  const bmp = await createImageBitmap(new Blob([p.bytes], { type: p.mime }));
  const s = Math.min(1, maxW / bmp.width, maxH / bmp.height);
  const cv = h('canvas', { width: Math.round(bmp.width * s), height: Math.round(bmp.height * s) });
  cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
  const blob = await new Promise(r => cv.toBlob(r, 'image/jpeg', 0.8));
  return { bytes: new Uint8Array(await blob.arrayBuffer()), w: cv.width, h: cv.height };
}
async function exportExcel(cards) {
  const how = await menu(`匯出 Excel（${cards.length} 張，含全部欄位與私人備註）`, [{ label: '儲存到檔案', value: 'save' }, { label: '透過分享選單傳送…', value: 'share' }]);
  if (!how) return;
  toast('正在產生 Excel…', 8000);
  try {
    const JSZip = await loadJSZip();
    const bytes = await X.buildXlsx(cards, { JSZip, catName: catName, loadImage: shrinkPhoto });
    const file = new File([bytes], `名片夾_${safeName(S.session.user.name)}_${stamp()}_${cards.length}張.xlsx`, { type: X.EXCEL_MIME });
    const r = await shareOrSave(file, how);
    if (r !== 'cancel') { toast('Excel 已' + (r === 'shared' ? '送出' : '儲存：' + file.name), 3500); S.selecting = false; S.selected.clear(); if (!S.pages.length && mainTab === 'list') renderList(); }
  } catch (e) { toast('Excel 匯出失敗：' + e.message, 4000); }
}
async function exportForClaude(cards) {
  const noPhoto = cards.filter(c => !c.photos?.front && !c.photos?.back).length;
  const ok = await confirmBox(`交給 Claude 辨識 ${cards.length - noPhoto} 張`,
    `會產生一個 zip，內含名片正反面照片、名片清單與給 Claude 的說明。${noPhoto ? `（${noPhoto} 張沒有名片照片，會略過）` : ''}\n\n接下來：\n1. 把 zip 傳到 Claude 對話，說「請照說明辨識」\n2. 下載 Claude 回給你的名片包 .json\n3. 我的 → 匯入名片包，核對差異後匯入\n\n注意：照片會上傳到 Claude（Anthropic）。`, '產生 zip');
  if (!ok) return;
  try {
    const JSZip = await loadJSZip();
    const list = cards.filter(c => c.photos?.front || c.photos?.back);
    const bytes = await X.buildClaudeZip(list, { JSZip, provider: S.session.user.name, dateStr: stamp(), loadPhoto: id => S.session.getPhoto(id) });
    const file = new File([bytes], `交給Claude辨識_${stamp()}_${list.length}張.zip`, { type: 'application/zip' });
    const how = await menu('zip 已產生', [{ label: '儲存到檔案', value: 'save' }, { label: '透過分享選單傳送…', value: 'share' }]);
    if (!how) return;
    const r = await shareOrSave(file, how);
    if (r !== 'cancel') { toast('已產生：' + file.name, 3500); S.selecting = false; S.selected.clear(); if (!S.pages.length && mainTab === 'list') renderList(); }
  } catch (e) { toast('產生失敗：' + e.message, 4000); }
}
function claudeHelp() {
  return confirmBox('交給 Claude 大量辨識', '1. 名片夾 → 右上「選取」→ 勾選名片（可先點「待整理」篩選）\n2. 下方「匯出…」→「交給 Claude 辨識」，存下 zip\n3. 把 zip 傳到 Claude 對話，說「請照說明辨識」\n4. 下載 Claude 回的名片包 .json\n5. 我的 → 匯入名片包 → 核對新舊差異 → 匯入\n\n你手動改過的欄位，預設保留你的版本。', '知道了');
}

// ================= 匯入名片包 =================
async function importFromFile(file) {
  let pack;
  try { pack = C.parsePack(await file.text()); }
  catch (e) { await confirmBox('無法匯入', e.message + '\n名片庫沒有任何變更。', '知道了'); return; }
  const hashes = {};
  for (const [ref, p] of Object.entries(pack.photos)) hashes[ref] = await K.sha256Hex(C.b64ToBytes(p.data));
  const an = C.analyzeImport(pack, [...S.cards.values()], catsById(), r => hashes[r]);
  openImportPreview(pack, an, hashes);
}
function openImportPreview(pack, an, hashes) {
  const choices = new Map(); // item -> {field: 'local'|'incoming'}
  for (const it of an.items) {
    const ch = {};
    const localHas = d => d.local && !String(d.local).startsWith('（無');
    for (const d of it.diffs) ch[d.field] = it.status === 'exists' ? (it.local.manual?.[d.field] && localHas(d) ? 'local' : 'incoming') : (localHas(d) ? 'local' : 'incoming');
    choices.set(it, ch);
  }
  const listEl = h('div');
  const go = h('button', { class: 'btn primary big', style: { flex: 2 }, onclick: apply });
  const bottom = h('div', { class: 'bottombar' }, h('button', { class: 'btn', onclick: closePage }, '取消'), go);
  const body = h('div', { style: { padding: '0 16px' } },
    h('div', { class: 'sumbox' }, h('div', {}, '提供者：', h('b', {}, pack.provider)),
      pack.exportedAt ? h('div', { class: 'small muted' }, '匯出時間：' + fmtDate(pack.exportedAt)) : null,
      h('div', { style: { marginTop: '6px' } }, `共 ${an.items.length} 張：新增 ${an.counts.new}／已存在 ${an.counts.exists}／可能重複 ${an.counts.dup}`),
      h('div', { class: 'small muted', style: { marginTop: '4px' } }, '對方分享的欄位：' + (C.sharedFieldList(Object.fromEntries((pack.included || []).map(k => [k, true]))).join('、')))),
    h('div', { class: 'row-btns', style: { margin: '4px 0 10px' } },
      h('button', { class: 'btn small', onclick: () => { an.items.forEach(i => { if (!isNoop(i)) i.selected = true; }); draw(); } }, '全選'),
      h('button', { class: 'btn small', onclick: () => { an.items.forEach(i => i.selected = false); draw(); } }, '全不選')),
    listEl);
  pushPage(pageShell('匯入名片包', { back: '取消', body, bottom }));
  function isNoop(it) { return it.status === 'exists' && !it.diffs.length && !(it.extra?.logs || it.extra?.tags); }
  function photoCell(it, d, side) {
    const box = h('span', { class: 'small muted' }, side === 'local' ? (d.localPhotoId ? '載入中…' : '（無）') : '');
    if (side === 'incoming') { const p = pack.photos[d.photoRef]; put(box, h('img', { src: `data:${p.mime || 'image/jpeg'};base64,${p.data}`, alt: '對方照片' })); }
    else if (d.localPhotoId) photoURL(d.localPhotoId).then(u => u && put(box, h('img', { src: u, alt: '本機照片' })));
    return box;
  }
  function diffTable(it) {
    const ch = choices.get(it);
    if (!it.diffs.length) return h('div', { class: 'small muted', style: { marginTop: '6px' } }, it.extra?.logs ? `會加入 ${it.extra.logs} 筆往來紀錄` : '內容沒有差異');
    const nm = 'r' + Math.random().toString(36).slice(2);
    return h('table', { class: 'diff' }, h('tbody', {},
      h('tr', {}, h('th', {}), h('th', { style: { width: 'auto' } }, '本機'), h('th', { style: { width: 'auto' } }, '匯入')),
      it.diffs.map(d => {
        const isPhoto = ['front', 'back', 'avatar'].includes(d.field);
        const cell = side => h('td', {}, h('label', {}, h('input', { type: 'radio', name: nm + d.field, checked: ch[d.field] === side, onchange: () => { ch[d.field] = side; } }),
          isPhoto ? photoCell(it, d, side) : h('span', {}, d[side] || '（空白）')));
        return h('tr', {}, h('th', {}, C.FIELD_LABELS[d.field], it.local?.manual?.[d.field] ? h('div', { class: 'small muted' }, '你改過') : null), cell('local'), cell('incoming'));
      })),
      it.extra?.logs ? h('caption', { style: { captionSide: 'bottom', textAlign: 'left', fontSize: '13px', paddingTop: '4px' } }, `另會加入 ${it.extra.logs} 筆往來紀錄`) : null);
  }
  function draw() {
    put(listEl, ...an.items.map(it => {
      const ic = it.incoming; const noop = isNoop(it);
      const cb = h('input', { type: 'checkbox', checked: it.selected && !noop, disabled: noop, 'aria-label': '匯入 ' + (ic.name || ic.company), onchange: () => { it.selected = cb.checked; draw(); } });
      const badge = it.status === 'new' ? h('span', { class: 'badge brand' }, '新增') : it.status === 'exists' ? h('span', { class: 'badge' }, noop ? '已存在・無變更' : '已存在・有更新') : h('span', { class: 'badge warn' }, '可能重複');
      const seg = (opts2) => h('div', { class: 'seg' }, opts2.map(([v, l]) => h('button', { class: it.action === v ? 'on' : '', onclick: () => { it.action = v; it.selected = v !== 'skip'; draw(); } }, l)));
      let extra = null;
      if (it.status === 'dup') {
        const m = it.matches[0];
        extra = h('div', {}, h('div', { class: 'small', style: { marginTop: '6px' } }, `與本機「${m.card.name || m.card.company}」的${m.by}相同${m.by === '電話' ? '（可能是公司總機）' : ''}。`),
          seg([['merge', '合併'], ['separate', '分開保留'], ['skip', '略過']]), it.action === 'merge' && it.selected ? diffTable(it) : null);
      } else if (it.status === 'exists' && !noop) {
        extra = h('div', {}, seg([['merge', '更新'], ['skip', '略過']]), it.action === 'merge' && it.selected ? diffTable(it) : null);
      }
      return h('div', { class: 'imp', 'data-status': it.status },
        h('label', { class: 'hd' }, cb, h('span', { style: { flex: 1 } }, h('b', {}, (it.status === 'exists' ? it.local.name || it.local.company : '') || ic.name || ic.company || '（未命名）'), badge,
          h('div', { class: 'small muted' }, [ic.name ? ic.company : '', ic.title].filter(Boolean).join('・')))), extra);
    }));
    const n = an.items.filter(i => i.selected && !isNoop(i) && i.action !== 'skip').length;
    go.textContent = `匯入所選（${n}）`; go.disabled = !n;
  }
  async function apply() {
    const sel = an.items.filter(i => i.selected && !isNoop(i) && i.action !== 'skip');
    if (!sel.length) return;
    go.disabled = true; go.textContent = '匯入中…';
    try {
      const importedAt = C.nowISO(); const provider = pack.provider;
      const cats = structuredClone(S.cats); let catsChanged = false;
      const categoryIdForName = n => { let c = cats.find(x => x.name === n); if (!c) { c = { id: C.uuid(), name: n }; cats.push(c); catsChanged = true; } return c.id; };
      const ops = []; const photoCache = new Map();
      const photoFor = async ref => {
        if (photoCache.has(ref)) return photoCache.get(ref);
        const p = pack.photos[ref]; const r = await S.session.photoOp(C.b64ToBytes(p.data), p.mime || 'image/jpeg');
        ops.push(r.op); photoCache.set(ref, r); return r;
      };
      const touched = [];
      for (const it of sel) {
        if (it.status === 'new' || (it.status === 'dup' && it.action === 'separate')) {
          const c = C.cardFromIncoming(it.incoming, { provider, importedAt, categoryIdForName });
          for (const [k, ref] of Object.entries(it.incoming.photos || {})) { const p = await photoFor(ref); c.photos[k] = p.id; c.photoHashes[k] = p.hash; }
          touched.push(c);
        } else {
          const local = touched.find(t => t.id === it.local.id) || it.local;
          const { card, photoTasks } = C.mergeIncoming(local, it.incoming, it.diffs, choices.get(it), { provider, importedAt, categoryIdForName });
          for (const t of photoTasks) {
            const p = await photoFor(t.ref);
            if (card.photos[t.kind]) ops.push(S.session.delPhotoOp(card.photos[t.kind]));
            card.photos[t.kind] = p.id; card.photoHashes[t.kind] = p.hash;
          }
          const ix = touched.findIndex(t => t.id === card.id); if (ix >= 0) touched[ix] = card; else touched.push(card);
        }
      }
      for (const c of touched) ops.push(await S.session.cardOp(c));
      if (catsChanged) ops.push(await S.session.categoriesOp(cats));
      await S.session.commit(ops); // 單一交易：失敗時整批不生效
      await reloadCards();
      toast(`已匯入 ${sel.length} 張名片`);
      closePage(); mainTab = 'list'; setTimeout(renderMain, 40);
    } catch (e) {
      go.disabled = false; draw();
      await confirmBox('匯入失敗', (e.message || e) + '\n名片庫維持匯入前的狀態。', '知道了');
    }
  }
  draw();
}

// ================= 我的 =================
function renderMe() {
  const top = $('#main-top'); const content = $('#main-content');
  put(top, h('div', { class: 'topbar' }, h('h1', {}, '我的')));
  const n = S.cards.size;
  const persistEl = h('span', { class: 'r' }, '檢查中…');
  navigator.storage?.persisted?.().then(p => { persistEl.textContent = p ? '已設為持續保存' : '可能被系統清除'; }).catch(() => { persistEl.textContent = '不支援'; });
  const ocrEl = h('span', { class: 'r' }, OCR.ocrSource());
  const item = (label, right, onclick, cls = '') => h('button', { class: cls, onclick }, h('span', {}, label), right ? (right instanceof Node ? right : h('span', { class: 'r' }, right)) : h('span', { class: 'r' }, '›'));
  put(content, 
    h('div', { class: 'section me-head' }, h('span', { class: 'avatar lg' }, [...S.session.user.name][0]),
      h('div', {}, h('div', { style: { fontSize: '20px', fontWeight: 800 } }, S.session.user.name), h('div', { class: 'muted' }, `目前登入・名片 ${n} 張`))),
    h('div', { class: 'section me-list' },
      item('鎖定', null, () => lock()),
      item('切換使用者', null, () => { clearSession(); showLogin('__list__'); })),
    h('div', { class: 'section me-list' }, h('h2', {}, '名片'),
      item('分類管理', `${S.cats.length} 個`, openCategories),
      item('匯入名片包', '含 Claude 辨識結果', async () => { const f = await pickFile({ accept: '.json,application/json,text/plain,*/*' }); if (f) importFromFile(f); }),
      item('匯出 Excel（全部名片）', `${n} 張`, () => n ? exportExcel(C.filterCards([...S.cards.values()], { sort: S.sort }, catsById())) : toast('還沒有名片')),
      item('交給 Claude 辨識', '選取名片後使用', () => claudeHelp())),
    h('div', { class: 'section me-list' }, h('h2', {}, '完整備份（換手機用）'),
      item('建立完整備份', null, makeBackup),
      item('從備份還原', null, restoreBackup)),
    h('div', { class: 'section me-list' }, h('h2', {}, '安全與裝置'),
      item('變更 PIN', null, changePinSheet),
      item('離線辨識元件', ocrEl, async () => {
        ocrEl.textContent = '下載中…';
        try { await OCR.warmUp(m => { if (m.progress != null) ocrEl.textContent = `下載中 ${Math.round(m.progress * 100)}%`; }); ocrEl.textContent = '已就緒（' + OCR.ocrSource() + '）'; toast('辨識元件已就緒，之後可離線辨識'); }
        catch (e) { ocrEl.textContent = '失敗'; toast(e.message, 4000); }
      }),
      item('儲存空間', persistEl, async () => { const ok = await navigator.storage?.persist?.(); persistEl.textContent = ok ? '已設為持續保存' : '可能被系統清除'; if (!ok) toast('iPhone 請用 Safari「加入主畫面」後從主畫面開啟，資料較不會被清除', 4500); }),
      item('刪除這位使用者', null, deleteUserFlow, 'danger')),
    h('p', { class: 'muted small', style: { textAlign: 'center', padding: '0 20px' } }, `名片夾 網頁版 v${APP_VERSION}・資料只存在這支手機的瀏覽器`));
}

async function openCategories() {
  const body = h('div');
  pushPage(pageShell('分類管理', { back: '我的', body }), { onClose: renderMainKeepScroll });
  const draw = () => {
    const count = id => [...S.cards.values()].filter(c => c.categoryId === id).length;
    put(body, h('div', { class: 'section me-list' }, S.cats.map(cat => h('button', { onclick: async () => {
      const a = await menu(cat.name, [{ label: '改名', value: 'rename' }, { label: '刪除分類', value: 'del' }]);
      if (a === 'rename') {
        const v = (await promptBox('分類改名', { value: cat.name }))?.trim();
        if (!v || v === cat.name) return;
        if (S.cats.some(c => c.name === v)) { toast('已有同名分類'); return; }
        const list = S.cats.map(c => c.id === cat.id ? { ...c, name: v } : c);
        await S.session.setCategories(list); S.cats = list; draw();
      } else if (a === 'del') {
        const k = count(cat.id);
        if (!await confirmBox(`刪除分類「${cat.name}」？`, k ? `${k} 張名片會保留，並改為「未分類」。` : '這個分類沒有名片。', '刪除', true)) return;
        const ops = [];
        const updated = [];
        for (const c of S.cards.values()) if (c.categoryId === cat.id) { const n = { ...c, categoryId: null, updatedAt: C.nowISO() }; updated.push(n); ops.push(await S.session.cardOp(n)); }
        const list = S.cats.filter(c => c.id !== cat.id);
        ops.push(await S.session.categoriesOp(list));
        await S.session.commit(ops);
        S.cats = list; for (const n of updated) S.cards.set(n.id, n);
        if (S.cat === cat.id) S.cat = 'all';
        draw();
      }
    } }, h('span', {}, cat.name), h('span', { class: 'r' }, `${count(cat.id)} 張 ›`)))),
    h('div', { style: { padding: '0 16px' } }, h('button', { class: 'btn primary', style: { width: '100%' }, onclick: async () => {
      const v = (await promptBox('新增分類', { placeholder: '分類名稱' }))?.trim();
      if (!v) return; if (S.cats.some(c => c.name === v)) { toast('已有同名分類'); return; }
      const list = [...S.cats, { id: C.uuid(), name: v }]; await S.session.setCategories(list); S.cats = list; draw();
    } }, '＋ 新增分類')));
  };
  draw();
}

async function makeBackup() {
  const pw = await sheet(close => {
    const a = h('input', { class: 'inp', type: 'password', placeholder: '至少 6 個字元', autocomplete: 'new-password' });
    const b = h('input', { class: 'inp', type: 'password', placeholder: '再輸入一次', autocomplete: 'new-password' });
    const err = h('div', { class: 'err-msg' });
    return h('div', {}, h('h3', {}, '建立完整備份'),
      h('p', { class: 'muted small' }, `包含「${S.session.user.name}」的全部 ${S.cards.size} 張名片、三種照片、分類、標籤、私人備註及往來紀錄。檔案以備份密碼加密，忘記密碼就無法還原。`),
      h('label', { class: 'field' }, h('span', { class: 'lb' }, '備份密碼'), a), h('label', { class: 'field' }, h('span', { class: 'lb' }, '確認密碼'), b), err,
      h('div', { class: 'acts' }, h('button', { class: 'btn', onclick: () => close(null) }, '取消'), h('button', { class: 'btn primary', onclick: () => {
        if (a.value.length < 6) { err.textContent = '密碼至少 6 個字元'; return; }
        if (a.value !== b.value) { err.textContent = '兩次輸入不一致'; return; }
        close(a.value);
      } }, '建立')));
  });
  if (!pw) return;
  toast('正在建立備份…', 6000);
  try {
    const photos = {};
    for (const id of await S.session.allPhotoIds()) { const p = await S.session.getPhoto(id); if (p) photos[id] = { mime: p.mime, data: C.bytesToB64(p.bytes) }; }
    const payload = { createdAt: C.nowISO(), userName: S.session.user.name, appVersion: APP_VERSION, cards: [...S.cards.values()], photos, categories: S.cats };
    const text = await K.sealBackup(payload, pw);
    const file = new File([text], `名片夾完整備份_${safeName(S.session.user.name)}_${stamp()}.json`, { type: 'application/json' });
    const how = await menu('備份已建立，要存到哪裡？', [{ label: '儲存到檔案', value: 'save' }, { label: '透過分享選單傳送…', value: 'share' }]);
    if (!how) return;
    const r = await shareOrSave(file, how);
    if (r !== 'cancel') toast('完整備份已' + (r === 'shared' ? '送出' : '儲存'));
  } catch (e) { toast('備份失敗：' + e.message); }
}

async function restoreBackup() {
  const f = await pickFile({ accept: '.json,application/json,text/plain,*/*' });
  if (!f) return;
  const text = await f.text();
  let payload; let pw;
  while (!payload) {
    pw = await promptBox('輸入備份密碼', { type: 'password', okText: '解開備份' });
    if (pw == null) return;
    try { payload = await K.openBackup(text, pw); }
    catch (e) { await confirmBox('無法還原', e.message, '知道了'); if (e.code !== 'password') return; }
  }
  const local = [...S.cards.values()];
  const sm = C.backupSummary(payload, local);
  const mode = await sheet(close => {
    let m = local.length ? 'merge' : 'replace';
    const r1 = h('input', { type: 'radio', name: 'rm', checked: m === 'merge', onchange: () => m = 'merge' });
    const r2 = h('input', { type: 'radio', name: 'rm', checked: m === 'replace', onchange: () => m = 'replace' });
    return h('div', {}, h('h3', {}, '還原前確認'),
      h('div', { class: 'sumbox' },
        h('div', {}, '備份日期：', h('b', {}, fmtDate(sm.createdAt))), h('div', {}, `備份使用者：${sm.userName || '—'}`),
        h('div', {}, `名片 ${sm.cardCount} 張・照片 ${sm.photoCount} 張・分類 ${sm.categoryCount} 個・往來紀錄 ${sm.logCount} 筆`)),
      h('p', { class: 'small' }, `目前「${S.session.user.name}」有 ${local.length} 張名片。對目前名片庫的影響：`),
      h('label', { class: 'opt' }, r1, h('span', { class: 't' }, h('b', {}, '合併'), h('br'), `新增 ${sm.newCount} 張；同一張名片 ${sm.overlapCount} 張以備份內容覆蓋；保留本機其他 ${sm.localOnly} 張。`)),
      h('label', { class: 'opt' }, r2, h('span', { class: 't' }, h('b', {}, '以備份取代'), h('br'), `刪除目前 ${local.length} 張名片，換成備份的 ${sm.cardCount} 張。`)),
      h('div', { class: 'acts' }, h('button', { class: 'btn', onclick: () => close(null) }, '取消'), h('button', { class: 'btn primary', onclick: () => close(m) }, '開始還原')));
  });
  if (!mode) return;
  try {
    const ops = [];
    const bIds = new Set(payload.cards.map(c => c.id));
    if (mode === 'replace') { ops.push({ store: 'cards', del: 'ALL' }, { store: 'photos', del: 'ALL' }); }
    else {
      const keep = new Set(Object.keys(payload.photos || {}));
      for (const c of local) if (bIds.has(c.id)) for (const k of ['front', 'back', 'avatar']) if (c.photos?.[k] && !keep.has(c.photos[k])) ops.push(S.session.delPhotoOp(c.photos[k]));
    }
    for (const [id, p] of Object.entries(payload.photos || {})) ops.push((await S.session.photoOp(C.b64ToBytes(p.data), p.mime, id)).op);
    let cats = payload.categories || [];
    const remap = {};
    if (mode === 'merge') {
      cats = [...S.cats];
      for (const bc of payload.categories || []) {
        const same = cats.find(c => c.id === bc.id) || cats.find(c => c.name === bc.name);
        if (same) remap[bc.id] = same.id; else cats.push(bc);
      }
    }
    for (const c of payload.cards) {
      const cc = c.categoryId && remap[c.categoryId] ? { ...c, categoryId: remap[c.categoryId] } : c;
      ops.push(await S.session.cardOp(cc));
    }
    ops.push(await S.session.categoriesOp(cats));
    await S.session.commit(ops);
    for (const u of S.urls.values()) URL.revokeObjectURL(u); S.urls.clear();
    await reloadCards(); renderMain();
    toast(`還原完成：目前共 ${S.cards.size} 張名片`, 3500);
  } catch (e) { await confirmBox('還原失敗', (e.message || e) + '\n原有資料沒有變更。', '知道了'); }
}

async function changePinSheet() {
  const r = await sheet(close => {
    const a = h('input', { class: 'inp', type: 'password', inputmode: 'numeric', placeholder: '目前 PIN' });
    const b = h('input', { class: 'inp', type: 'password', inputmode: 'numeric', placeholder: '新 PIN（4–8 位數字）' });
    const c = h('input', { class: 'inp', type: 'password', inputmode: 'numeric', placeholder: '再輸入一次新 PIN' });
    const err = h('div', { class: 'err-msg' });
    return h('div', {}, h('h3', {}, '變更 PIN'), h('div', { class: 'field' }, a), h('div', { class: 'field' }, b), h('div', { class: 'field' }, c), err,
      h('div', { class: 'acts' }, h('button', { class: 'btn', onclick: () => close(null) }, '取消'), h('button', { class: 'btn primary', onclick: async () => {
        if (b.value !== c.value) { err.textContent = '兩次新 PIN 不一致'; return; }
        try { await DB.changePin(S.session.user.id, a.value, b.value); close(true); } catch (e) { err.textContent = e.message; }
      } }, '變更')));
  });
  if (r) toast('PIN 已變更');
}
async function deleteUserFlow() {
  const pin = await promptBox(`刪除使用者「${S.session.user.name}」`, { type: 'password', okText: '永久刪除', hint: '這位使用者的所有名片、照片與紀錄都會從這支手機刪除，無法復原。請輸入 PIN 確認。' });
  if (pin == null) return;
  try { const s = await DB.unlock(S.session.user.id, pin); await DB.deleteUser(s); clearSession(); toast('已刪除使用者'); showLogin(); }
  catch (e) { toast(e.message); }
}

boot();
