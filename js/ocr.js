// 名片夾 手機端 OCR（Tesseract.js，繁體中文＋英文，模型隨網站提供於 ./tessdata）
// 照片只在本機瀏覽器內處理，不會上傳。
const TESS_VER = '5'; // 使用 Tesseract.js 5.x（回傳逐行結果）
const abs = p => new URL(p, location.href).href; // worker 由 blob 建立，路徑須為絕對網址
const LOCAL = {
  script: abs('./vendor/tesseract/tesseract.min.js'),
  worker: abs('./vendor/tesseract/worker.min.js'),
  core: abs('./vendor/tesseract-core'),
};
const CDN = {
  script: `https://cdn.jsdelivr.net/npm/tesseract.js@${TESS_VER}/dist/tesseract.min.js`,
  worker: `https://cdn.jsdelivr.net/npm/tesseract.js@${TESS_VER}/dist/worker.min.js`,
  core: `https://cdn.jsdelivr.net/npm/tesseract.js-core@${TESS_VER}`,
};
let workerP = null;
let srcInUse = null;

function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src; s.onload = () => res(); s.onerror = () => { s.remove(); rej(new Error('load ' + src)); };
    document.head.appendChild(s);
  });
}
async function ensureLib() {
  if (window.Tesseract) return srcInUse;
  try { await loadScript(LOCAL.script); srcInUse = LOCAL; }
  catch {
    try { await loadScript(CDN.script); srcInUse = CDN; }
    catch { throw new Error('無法載入辨識元件。第一次使用請在有網路時開啟一次，之後即可離線辨識。'); }
  }
  return srcInUse;
}

export async function getWorker(onProgress) {
  if (window.__MPJ_OCR_ENGINE__) return null; // 自動化測試用替身（正式使用不會設定）
  if (!workerP) {
    workerP = (async () => {
      const src = await ensureLib();
      const w = await window.Tesseract.createWorker(['chi_tra', 'eng'], 1, {
        workerPath: src.worker, corePath: src.core,
        langPath: new URL('./tessdata', location.href).href, gzip: true,
        logger: m => onProgress?.(m),
      });
      await w.setParameters({ preserve_interword_spaces: '1', tessedit_pageseg_mode: '3' });
      return w;
    })();
    workerP.catch(() => { workerP = null; });
  }
  return workerP;
}

/** 前處理：縮放到合適大小、灰階、拉高對比 */
async function preprocess(blob) {
  const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' }).catch(async () => {
    const img = new Image(); img.src = URL.createObjectURL(blob); await img.decode(); return img;
  });
  const W = bmp.width, H = bmp.height;
  const scale = Math.min(1, 2200 / Math.max(W, H)) * (Math.max(W, H) < 1200 ? 1.8 : 1);
  const cv = document.createElement('canvas');
  cv.width = Math.round(W * scale); cv.height = Math.round(H * scale);
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0, cv.width, cv.height);
  const d = ctx.getImageData(0, 0, cv.width, cv.height); const a = d.data;
  let min = 255, max = 0;
  for (let i = 0; i < a.length; i += 4) { const g = 0.299 * a[i] + 0.587 * a[i + 1] + 0.114 * a[i + 2]; a[i] = g; if (g < min) min = g; if (g > max) max = g; }
  const span = Math.max(1, max - min);
  for (let i = 0; i < a.length; i += 4) { const g = (a[i] - min) * 255 / span; a[i] = a[i + 1] = a[i + 2] = g; }
  ctx.putImageData(d, 0, 0);
  return cv;
}

/** 依字距把一行切成多段（雙欄排版時避免左右欄黏在一起） */
function lineToText(line) {
  const words = (line.words || []).slice().sort((a, b) => a.bbox.x0 - b.bbox.x0);
  if (!words.length) return line.text || '';
  const h = Math.max(1, (line.bbox?.y1 || 0) - (line.bbox?.y0 || 0));
  let out = words[0].text;
  for (let i = 1; i < words.length; i++) {
    const gap = words[i].bbox.x0 - words[i - 1].bbox.x1;
    out += (gap > h * 1.6 ? '    ' : ' ') + words[i].text;
  }
  return out;
}

/**
 * 辨識單張影像。回傳 {text, lines:[{text, confidence}]}
 */
export async function recognize(blob, onProgress) {
  if (window.__MPJ_OCR_ENGINE__) return window.__MPJ_OCR_ENGINE__(blob);
  const w = await getWorker(onProgress);
  const cv = await preprocess(blob);
  const { data } = await w.recognize(cv);
  const lines = (data.lines || []).map(l => ({ text: lineToText(l), confidence: l.confidence }));
  return { text: lines.map(l => l.text).join('\n') || data.text || '', lines };
}

/** 預先下載辨識元件與模型（供之後飛航模式使用） */
export async function warmUp(onProgress) {
  if (window.__MPJ_OCR_ENGINE__) return true;
  await getWorker(onProgress);
  return true;
}
export function ocrSource() { return srcInUse === LOCAL ? '本站' : srcInUse === CDN ? 'CDN' : '尚未載入'; }
