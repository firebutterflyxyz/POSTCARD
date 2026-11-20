// 名片夾 加密工具（Web Crypto；瀏覽器與 Node 18+ 皆可用）
import { bytesToB64, b64ToBytes, FORMAT_BACKUP, BACKUP_VERSION } from './core.js';
const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder(); const dec = new TextDecoder();
export const PIN_ITER = 310000;
export const BACKUP_ITER = 310000;

export function randomBytes(n) { const b = new Uint8Array(n); globalThis.crypto.getRandomValues(b); return b; }

export async function deriveKey(secret, salt, iterations, usages = ['encrypt', 'decrypt']) {
  const base = await subtle.importKey('raw', enc.encode(secret.normalize('NFKC')), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, { name: 'AES-GCM', length: 256 }, false, usages);
}
export async function encryptBytes(key, bytes) {
  const iv = randomBytes(12);
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes));
  return { iv, ct };
}
export async function decryptBytes(key, iv, ct) {
  return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv }, key, ct));
}
export async function encryptJSON(key, obj) { return encryptBytes(key, enc.encode(JSON.stringify(obj))); }
export async function decryptJSON(key, iv, ct) { return JSON.parse(dec.decode(await decryptBytes(key, iv, ct))); }

export async function sha256Hex(bytes) {
  const h = new Uint8Array(await subtle.digest('SHA-256', bytes));
  return [...h].map(x => x.toString(16).padStart(2, '0')).join('');
}

/** 建立使用者金鑰：隨機資料金鑰，以 PIN 推導之金鑰加密保存（PIN 本身不保存） */
export async function createUserKeys(pin) {
  const salt = randomBytes(16);
  const raw = randomBytes(32);
  const kek = await deriveKey(pin, salt, PIN_ITER);
  const { iv, ct } = await encryptBytes(kek, raw);
  const dataKey = await subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
  raw.fill(0);
  return { record: { salt, iter: PIN_ITER, wrapIv: iv, wrapped: ct }, dataKey };
}
/** 以 PIN 解開資料金鑰；PIN 錯誤時 AES-GCM 驗證失敗而回傳 null */
export async function unlockUserKey(pin, rec) {
  try {
    const kek = await deriveKey(pin, rec.salt, rec.iter);
    const raw = await decryptBytes(kek, rec.wrapIv, rec.wrapped);
    const k = await subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
    raw.fill(0);
    return k;
  } catch { return null; }
}
/** 變更 PIN：先以舊 PIN 解開原始金鑰，再以新 PIN 重新包裝 */
export async function rewrapUserKey(oldPin, newPin, rec) {
  const kek = await deriveKey(oldPin, rec.salt, rec.iter);
  let raw;
  try { raw = await decryptBytes(kek, rec.wrapIv, rec.wrapped); } catch { return null; }
  const salt = randomBytes(16);
  const kek2 = await deriveKey(newPin, salt, PIN_ITER);
  const { iv, ct } = await encryptBytes(kek2, raw);
  raw.fill(0);
  return { salt, iter: PIN_ITER, wrapIv: iv, wrapped: ct };
}

/** 完整備份：以備份密碼加密整個內容 */
export async function sealBackup(payload, password) {
  const salt = randomBytes(16);
  const key = await deriveKey(password, salt, BACKUP_ITER);
  const { iv, ct } = await encryptBytes(key, enc.encode(JSON.stringify(payload)));
  return JSON.stringify({
    format: FORMAT_BACKUP, version: BACKUP_VERSION, kdf: 'PBKDF2-SHA256', iter: BACKUP_ITER, cipher: 'AES-256-GCM',
    salt: bytesToB64(salt), iv: bytesToB64(iv), data: bytesToB64(ct),
  });
}
export class BackupError extends Error { constructor(m, code) { super(m); this.code = code; } }
export async function openBackup(text, password) {
  let j;
  try { j = JSON.parse(text); } catch { throw new BackupError('檔案損毀，無法讀取。', 'corrupt'); }
  if (j?.format !== FORMAT_BACKUP) throw new BackupError(j?.format === 'mingpianjia-pack' ? '這是名片包，請改用「匯入名片包」。' : '這不是名片夾的完整備份檔。', 'format');
  if (j.version > BACKUP_VERSION) throw new BackupError('備份格式版本較新，請更新 App。', 'version');
  let key;
  try { key = await deriveKey(password, b64ToBytes(j.salt), j.iter); } catch { throw new BackupError('備份檔內容不完整。', 'corrupt'); }
  let bytes;
  try { bytes = await decryptBytes(key, b64ToBytes(j.iv), b64ToBytes(j.data)); }
  catch { throw new BackupError('備份密碼錯誤，或檔案已損毀。目前名片庫未做任何變更。', 'password'); }
  try { return JSON.parse(dec.decode(bytes)); } catch { throw new BackupError('備份內容損毀。', 'corrupt'); }
}
