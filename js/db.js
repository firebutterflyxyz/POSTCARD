// 名片夾 本機儲存（IndexedDB；每位使用者的名片、照片、分類皆以該使用者的資料金鑰 AES-GCM 加密）
import * as K from './crypto.js';
import { uuid, nowISO, DEFAULT_CATEGORIES } from './core.js';

const DB_NAME = 'mingpianjia';
const DB_VER = 1;
let dbp = null;

function req(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
function txDone(tx) { return new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error || new Error('交易中止')); }); }

export function openDB() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, DB_VER);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('users')) db.createObjectStore('users', { keyPath: 'id' });
      for (const s of ['cards', 'photos', 'meta']) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: ['uid', 'id'] });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
const range = uid => IDBKeyRange.bound([uid, ''], [uid, '￿']);

// ---------- 使用者 ----------
export async function listUsers() {
  const db = await openDB();
  const all = await req(db.transaction('users').objectStore('users').getAll());
  return all.map(u => ({ id: u.id, name: u.name, createdAt: u.createdAt })).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
export async function createUser(name, pin) {
  name = (name || '').trim();
  if (!name) throw new Error('請輸入使用者名稱');
  if (!/^\d{4,8}$/.test(pin)) throw new Error('PIN 需為 4–8 位數字');
  const users = await listUsers();
  if (users.some(u => u.name === name)) throw new Error('這個使用者名稱已存在');
  const { record, dataKey } = await K.createUserKeys(pin);
  const user = { id: uuid(), name, createdAt: nowISO(), keyRec: record, fails: 0, lockUntil: 0 };
  const db = await openDB();
  const tx = db.transaction('users', 'readwrite'); tx.objectStore('users').put(user); await txDone(tx);
  const s = new Session(user, dataKey);
  await s.setCategories(DEFAULT_CATEGORIES.map(n => ({ id: uuid(), name: n })));
  return s;
}
async function getUserRec(uid) { const db = await openDB(); return req(db.transaction('users').objectStore('users').get(uid)); }
async function putUserRec(u) { const db = await openDB(); const tx = db.transaction('users', 'readwrite'); tx.objectStore('users').put(u); await txDone(tx); }

/** 以 PIN 解鎖；連續錯誤 5 次鎖 30 秒，之後每次加倍 */
export async function unlock(uid, pin) {
  const u = await getUserRec(uid);
  if (!u) throw new Error('找不到使用者');
  const now = Date.now();
  if (u.lockUntil > now) throw new Error(`PIN 錯誤次數過多，請 ${Math.ceil((u.lockUntil - now) / 1000)} 秒後再試`);
  const key = await K.unlockUserKey(pin, u.keyRec);
  if (!key) {
    u.fails = (u.fails || 0) + 1;
    if (u.fails >= 5) u.lockUntil = now + 30000 * 2 ** Math.min(u.fails - 5, 6);
    await putUserRec(u);
    throw new Error(u.fails >= 5 ? 'PIN 錯誤，已暫時鎖定' : `PIN 錯誤（剩 ${5 - u.fails} 次）`);
  }
  if (u.fails) { u.fails = 0; u.lockUntil = 0; await putUserRec(u); }
  return new Session(u, key);
}
export async function changePin(uid, oldPin, newPin) {
  if (!/^\d{4,8}$/.test(newPin)) throw new Error('PIN 需為 4–8 位數字');
  const u = await getUserRec(uid);
  const rec = await K.rewrapUserKey(oldPin, newPin, u.keyRec);
  if (!rec) throw new Error('目前 PIN 不正確');
  u.keyRec = rec; await putUserRec(u);
}
/** 刪除使用者及其全部資料（需先以 PIN 解鎖取得 Session） */
export async function deleteUser(session) {
  const db = await openDB();
  const tx = db.transaction(['users', 'cards', 'photos', 'meta'], 'readwrite');
  tx.objectStore('users').delete(session.user.id);
  for (const s of ['cards', 'photos', 'meta']) tx.objectStore(s).delete(range(session.user.id));
  await txDone(tx);
  session.close();
}

// ---------- 已解鎖的使用者工作階段 ----------
export class Session {
  constructor(user, key) { this.user = { id: user.id, name: user.name }; this._key = key; }
  get uid() { if (!this._key) throw new Error('已鎖定'); return this.user.id; }
  close() { this._key = null; }
  get open() { return !!this._key; }

  async _enc(store, id, obj, extra = {}) {
    const { iv, ct } = await K.encryptJSON(this._key, obj);
    return { store, rec: { uid: this.uid, id, iv, ct, ...extra } };
  }
  async _encBytes(store, id, bytes, extra = {}) {
    const { iv, ct } = await K.encryptBytes(this._key, bytes);
    return { store, rec: { uid: this.uid, id, iv, ct, ...extra } };
  }
  /** 先完成全部加密，再於單一交易寫入：任何一筆失敗都整批不生效 */
  async commit(ops) {
    const db = await openDB();
    const stores = [...new Set(ops.map(o => o.store))];
    if (!stores.length) return;
    const tx = db.transaction(stores, 'readwrite');
    for (const o of ops) {
      const st = tx.objectStore(o.store);
      if (o.del) st.delete(o.del === 'ALL' ? range(this.uid) : [this.uid, o.del]); else st.put(o.rec);
    }
    await txDone(tx);
  }

  // 名片
  async loadCards() {
    const db = await openDB();
    const recs = await req(db.transaction('cards').objectStore('cards').getAll(range(this.uid)));
    const out = [];
    for (const r of recs) out.push(await K.decryptJSON(this._key, r.iv, r.ct));
    return out;
  }
  cardOp(card) { return this._enc('cards', card.id, card); }
  async saveCard(card) { await this.commit([await this.cardOp(card)]); }
  async deleteCard(card) {
    const ops = [{ store: 'cards', del: card.id }];
    for (const k of ['front', 'back', 'avatar']) if (card.photos?.[k]) ops.push({ store: 'photos', del: card.photos[k] });
    await this.commit(ops);
  }

  // 照片
  async photoOp(bytes, mime = 'image/jpeg', id = uuid()) {
    const hash = await K.sha256Hex(bytes);
    const op = await this._encBytes('photos', id, bytes, { mime });
    return { id, hash, op };
  }
  async putPhoto(bytes, mime) { const p = await this.photoOp(bytes, mime); await this.commit([p.op]); return p; }
  async getPhoto(id) {
    if (!id) return null;
    const db = await openDB();
    const r = await req(db.transaction('photos').objectStore('photos').get([this.uid, id]));
    if (!r) return null;
    return { bytes: await K.decryptBytes(this._key, r.iv, r.ct), mime: r.mime || 'image/jpeg' };
  }
  delPhotoOp(id) { return { store: 'photos', del: id }; }
  async allPhotoIds() {
    const db = await openDB();
    return (await req(db.transaction('photos').objectStore('photos').getAllKeys(range(this.uid)))).map(k => k[1]);
  }

  // 分類
  async getCategories() {
    const db = await openDB();
    const r = await req(db.transaction('meta').objectStore('meta').get([this.uid, 'categories']));
    return r ? K.decryptJSON(this._key, r.iv, r.ct) : [];
  }
  categoriesOp(list) { return this._enc('meta', 'categories', list); }
  async setCategories(list) { await this.commit([await this.categoriesOp(list)]); }
  async getMeta(k, def = null) {
    const db = await openDB();
    const r = await req(db.transaction('meta').objectStore('meta').get([this.uid, k]));
    return r ? K.decryptJSON(this._key, r.iv, r.ct) : def;
  }
  async setMeta(k, v) { await this.commit([await this._enc('meta', k, v)]); }
}
