// 名片夾 介面小工具
export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}
export const $ = (s, r = document) => r.querySelector(s);

const ICONS = {
  cards: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2.5"/><circle cx="8.5" cy="11" r="2"/><path d="M5.8 16c.6-1.5 1.6-2.2 2.7-2.2s2.1.7 2.7 2.2M14 10h4M14 13.5h3"/></svg>',
  camera: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h3l1.6-2.4h6.8L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13" r="3.6"/></svg>',
  me: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="8.5" r="3.8"/><path d="M4.5 20c1.3-3.8 4.2-5.6 7.5-5.6s6.2 1.8 7.5 5.6"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg>',
};
export function icon(n) { const s = document.createElement('span'); s.innerHTML = ICONS[n]; return s.firstChild; }

let toastT;
export function toast(msg, ms = 2400) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('on');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), ms);
}

/** 底部對話框。build(close) 回傳內容節點；回傳 Promise，close(value) 結束 */
export function sheet(build, { dismissable = true } = {}) {
  return new Promise(resolve => {
    const layer = document.getElementById('layer');
    let done = false;
    const close = v => { if (done) return; done = true; bd.remove(); resolve(v); };
    const box = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true' });
    const bd = h('div', { class: 'backdrop', onclick: e => { if (e.target === bd && dismissable) close(undefined); } }, box);
    box.append(build(close));
    layer.append(bd);
    const f = box.querySelector('input:not([type=checkbox]):not([type=radio]),textarea');
    if (f) setTimeout(() => f.focus(), 60);
  });
}
export function closeAllSheets() { document.getElementById('layer').innerHTML = ''; }

export function confirmBox(title, msg, okText = '確定', danger = false) {
  return sheet(close => h('div', {}, h('h3', {}, title), msg ? h('p', { class: 'muted' }, msg) : null,
    h('div', { class: 'acts' }, h('button', { class: 'btn', onclick: () => close(false) }, '取消'),
      h('button', { class: 'btn ' + (danger ? 'danger' : 'primary'), onclick: () => close(true) }, okText))));
}
export function menu(title, items) {
  return sheet(close => h('div', {}, title ? h('h3', {}, title) : null,
    h('div', { class: 'menu' }, items.map(it => h('button', { onclick: () => close(it.value) }, it.label))),
    h('div', { class: 'acts' }, h('button', { class: 'btn', onclick: () => close(undefined) }, '取消'))));
}
export function promptBox(title, { value = '', placeholder = '', type = 'text', okText = '確定', hint = '' } = {}) {
  return sheet(close => {
    const inp = h('input', { class: 'inp', type, value, placeholder, onkeydown: e => { if (e.key === 'Enter') close(inp.value); } });
    return h('div', {}, h('h3', {}, title), hint ? h('p', { class: 'muted small' }, hint) : null, inp,
      h('div', { class: 'acts' }, h('button', { class: 'btn', onclick: () => close(null) }, '取消'), h('button', { class: 'btn primary', onclick: () => close(inp.value) }, okText)));
  });
}

/** 讀取使用者選的檔案（相機或相簿） */
export function pickFile({ accept = 'image/*', capture = null } = {}) {
  return new Promise(resolve => {
    const inp = h('input', { type: 'file', accept, style: { position: 'fixed', left: '-9999px' } });
    if (capture) inp.setAttribute('capture', capture);
    let settled = false;
    const finish = f => { if (settled) return; settled = true; inp.remove(); resolve(f); };
    inp.addEventListener('change', () => finish(inp.files?.[0] || null));
    inp.addEventListener('cancel', () => finish(null));
    document.body.append(inp);
    inp.click();
  });
}

/** 照片壓縮成 JPEG（保留方向） */
export async function compressImage(file, maxSide = 1800, quality = 0.85) {
  let src;
  try { src = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch {
    const url = URL.createObjectURL(file);
    try { src = new Image(); src.src = url; await src.decode(); } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
  }
  const W = src.width, H = src.height;
  if (!W || !H) throw new Error('無法讀取這張照片');
  const s = Math.min(1, maxSide / Math.max(W, H));
  const cv = document.createElement('canvas'); cv.width = Math.round(W * s); cv.height = Math.round(H * s);
  cv.getContext('2d').drawImage(src, 0, 0, cv.width, cv.height);
  const blob = await new Promise(r => cv.toBlob(r, 'image/jpeg', quality));
  return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: 'image/jpeg', blob };
}

/** 全螢幕看圖：雙指縮放、拖曳、點兩下放大 */
export function zoomImage(url, caption = '') {
  const img = h('img', { src: url, alt: caption });
  const z = h('div', { class: 'zoomer', role: 'dialog', 'aria-label': caption || '照片' },
    h('button', { class: 'close', onclick: () => z.remove() }, '關閉'), img,
    h('div', { class: 'hint' }, (caption ? caption + '・' : '') + '雙指縮放，點兩下放大'));
  let sc = 1, tx = 0, ty = 0; const pts = new Map(); let start = null; let lastTap = 0;
  const apply = () => { img.style.transform = `translate(calc(-50% + ${tx}px), calc(-50% + ${ty}px)) scale(${sc})`; };
  apply();
  z.addEventListener('pointerdown', e => {
    if (e.target.classList.contains('close')) return;
    z.setPointerCapture(e.pointerId); pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const now = Date.now();
    if (pts.size === 1 && now - lastTap < 300) { sc = sc > 1.2 ? 1 : 2.5; tx = ty = 0; apply(); }
    lastTap = now;
    start = { sc, tx, ty, pts: new Map(pts) };
  });
  z.addEventListener('pointermove', e => {
    if (!pts.has(e.pointerId) || !start) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const a = [...pts.values()], b = [...start.pts.values()];
    if (a.length >= 2 && b.length >= 2) {
      const d = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);
      sc = Math.min(6, Math.max(1, start.sc * d(a[0], a[1]) / Math.max(1, d(b[0], b[1]))));
    } else if (a.length === 1 && b.length >= 1) { tx = start.tx + a[0].x - b[0].x; ty = start.ty + a[0].y - b[0].y; }
    apply();
  });
  const up = e => { pts.delete(e.pointerId); start = { sc, tx, ty, pts: new Map(pts) }; if (sc === 1) { tx = ty = 0; apply(); } };
  z.addEventListener('pointerup', up); z.addEventListener('pointercancel', up);
  z.addEventListener('wheel', e => { e.preventDefault(); sc = Math.min(6, Math.max(1, sc * (e.deltaY < 0 ? 1.15 : 0.87))); apply(); }, { passive: false });
  document.body.append(z);
  return z;
}

export function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso); if (isNaN(d)) return iso;
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
export function today() { const d = new Date(); const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; }
export function stamp() { return today().replace(/-/g, ''); }
export function safeName(s) { return (s || '').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 30); }

/** 分享或下載檔案 */
export async function shareOrSave(file, mode = 'share') {
  if (mode === 'share' && navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: file.name }); return 'shared'; }
    catch (e) { if (e.name === 'AbortError') return 'cancel'; }
  }
  const url = URL.createObjectURL(file);
  const a = h('a', { href: url, download: file.name, style: { display: 'none' } });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  return 'saved';
}
export async function readFileText(file) { return await file.text(); }

/** 取代子節點（略過 null／false，避免畫面出現 "null"） */
export function put(el, ...kids) {
  el.replaceChildren(...kids.flat(Infinity).filter(k => k != null && k !== false));
  return el;
}
