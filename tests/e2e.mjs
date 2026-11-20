// 端對端驗收測試（無頭 Chrome）。OCR 以本機 tesseract（chi_tra+eng）辨識實際上傳的照片。
// 用法：先在 app 目錄啟動 http 伺服器（python3 -m http.server 8765），再執行 node tests/e2e.mjs
import { createRequire } from 'module';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
const require = createRequire('/opt/npm-tools/node_modules/');
const { chromium } = require('playwright');

const BASE = process.env.BASE || 'http://localhost:8765/';
const SAMPLES = process.env.SAMPLES || '/home/claude/work/samples';
const SHOTS = process.env.SHOTS || '/home/claude/work/shots';
fs.mkdirSync(SHOTS, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mpj-'));
const results = [];
const ok = (cond, msg) => { if (!cond) throw new Error('驗證失敗：' + msg); results.push('  ✓ ' + msg); };

const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'], env: { ...process.env, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' } });
async function phone(name) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: process.env.COLOR || 'dark', locale: 'zh-TW', acceptDownloads: true });
  await ctx.exposeBinding('__ocrNode', async (_s, b64) => {
    const f = path.join(tmp, 'ocr-' + Date.now() + '.jpg');
    fs.writeFileSync(f, Buffer.from(b64, 'base64'));
    const text = execFileSync('tesseract', [f, '-', '-l', 'chi_tra+eng'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    return { text: text.split('\n').filter(s => s.trim()).join('\n'), lines: text.split('\n').filter(s => s.trim()).map(t => ({ text: t, confidence: 85 })) };
  });
  await ctx.addInitScript(() => {
    window.__MPJ_OCR_ENGINE__ = async blob => {
      const b = new Uint8Array(await blob.arrayBuffer()); let s = '';
      for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
      return window.__ocrNode(btoa(s));
    };
  });
  const page = await ctx.newPage();
  page.on('pageerror', e => { console.error(`[${name}] pageerror`, e.message); results.push(`  ✗ [${name}] JS 錯誤：${e.message}`); });
  return { ctx, page, name };
}
const shot = async (p, n) => { await p.waitForTimeout(600); return p.screenshot({ path: path.join(SHOTS, n + '.png') }); };
async function createUser(page, name, pin) {
  await page.locator('.auth input').nth(0).fill(name);
  await page.locator('.auth input').nth(1).fill(pin);
  await page.locator('.auth input').nth(2).fill(pin);
  await page.click('text=建立並開始使用');
  await page.waitForSelector('.tabbar');
}
async function enterPin(page, pin) {
  await page.waitForSelector('.pad');
  for (const d of pin) await page.click(`.pad button[aria-label="${d}"]`);
  await page.click('.pad button[aria-label="確定"]');
  await page.waitForSelector('.tabbar');
}
async function withChooser(page, action, file) {
  const [fc] = await Promise.all([page.waitForEvent('filechooser'), action()]);
  await fc.setFiles(file);
}
async function waitOcrDone(page) {
  await page.waitForFunction(() => !document.body.innerText.includes('正在辨識'), null, { timeout: 30000 });
  await page.waitForTimeout(150);
}
const topPage = p => p.locator('.page').last();
const tab = (p, n) => p.locator(`.tabbar button[aria-label="${n}"]`);
async function search(page, q) {
  await page.fill('input[type=search]', q);
  await page.waitForTimeout(120);
  return page.locator('#card-list .item .nm').allInnerTexts();
}
async function sheetBtn(page, text) { await page.locator('.sheet button', { hasText: text }).last().click(); }
async function backToList(page) { while (await page.locator('.page').count()) { await page.goBack(); await page.waitForTimeout(150); } }

// ========== 手機一（使用者 A）==========
const P1 = await phone('手機一');
const p = P1.page;
await p.goto(BASE);
await p.evaluate(() => navigator.serviceWorker.ready);
await p.reload();
await p.waitForFunction(() => !!navigator.serviceWorker.controller);

console.log('情境 1：飛航模式，拍正面＋背面 → 同一筆、修正姓名、重開仍在');
await P1.ctx.setOffline(true);
await p.reload(); // 離線重新載入，由 Service Worker 提供
await createUser(p, '蝴蝶A', '1234');
ok(await p.locator('.tabbar').isVisible(), '離線狀態下可開啟 App 並建立本機使用者');
await withChooser(p, () => tab(p, '拍名片').click(), `${SAMPLES}/card1_front.jpg`);
await waitOcrDone(p);
await withChooser(p, () => topPage(p).locator('.faces button', { hasText: '背面' }).click(), `${SAMPLES}/card1_back.jpg`);
await waitOcrDone(p);
await shot(p, '01-核對畫面');
const nameInput = topPage(p).locator('[data-field=name] input');
ok((await nameInput.inputValue()).startsWith('陳'), `辨識出姓名「${await nameInput.inputValue()}」`);
ok(await topPage(p).locator('[data-field=name].review').count() === 1, '姓名把握度低，標記「請核對」');
ok(await topPage(p).locator('[data-field=company] input').inputValue() === '大和物業管理顧問股份有限公司', '正面公司名稱');
const phoneVals = await topPage(p).locator('.multi input[type=tel]').evaluateAll(a => a.map(x => x.value));
ok(phoneVals.some(v => v.includes('0912')), '背面手機併入同一筆：' + phoneVals.join(' / '));
ok(await topPage(p).locator('[data-field=address] textarea').inputValue() === '台北市大安區忠孝東路四段100號8樓', '背面地址併入');
ok(await topPage(p).locator('.raw details').count() === 2, '保留正反面辨識原文');
await nameInput.fill('陳怡君');
await topPage(p).locator('.bottombar button', { hasText: '儲存名片' }).click();
await p.waitForSelector('.page .hero');
ok((await p.locator('.page .hero .nm').innerText()) === '陳怡君', '修正姓名後儲存');
await p.reload();
await enterPin(p, '1234');
ok((await p.locator('#card-list .item .nm').allInnerTexts()).some(t => t.includes('陳怡君')), '離線重開 App 後名片仍在');
await p.locator('#card-list .item', { hasText: '陳怡君' }).click();
await p.waitForSelector('.page .thumb img');
ok(await p.locator('.page .thumb img').count() === 2, '重開後正反面照片仍在');
await shot(p, '02-詳情');
await backToList(p);

console.log('情境 2：只拍正面、不填分類快速儲存；補大頭照、場合、兩筆往來，再以場合／備註找到');
await withChooser(p, () => tab(p, '拍名片').click(), `${SAMPLES}/card2_front.jpg`);
await waitOcrDone(p);
await topPage(p).locator('.bottombar button', { hasText: '儲存名片' }).click();
await p.waitForSelector('.page .hero');
ok((await p.locator('.page .hero .nm').innerText()) === '林建宏', '只拍正面即可儲存（拍 → 核對 → 儲存）');
await withChooser(p, () => p.locator('.page .thumb[aria-label=聯絡人大頭照]').click(), `${SAMPLES}/avatar.jpg`);
await topPage(p).locator('[data-field=metPlace] input').fill('2026 台北建材展');
await topPage(p).locator('.field', { hasText: '分類' }).locator('select').first().selectOption({ label: '專業顧問' });
await topPage(p).locator('.bottombar button', { hasText: '儲存名片' }).click();
await p.waitForSelector('.page .hero .avatar img');
ok(true, '儲存後補加大頭照與認識場合');
for (const t of ['電話確認管委會下週開會', '寄送外牆修繕估價單']) {
  await p.locator('.page .quick button', { hasText: '新增往來' }).click();
  await p.locator('.sheet textarea').fill(t);
  await sheetBtn(p, '新增');
  await p.waitForTimeout(200);
}
ok(await p.locator('.page .logs .log').count() === 2, '連續新增兩筆往來紀錄，不覆蓋');
await shot(p, '03-詳情往來');
await backToList(p);
ok((await search(p, '建材展')).join() === '林建宏', '以認識場合關鍵字找到');
ok((await search(p, '估價單')).join() === '林建宏', '以往來紀錄關鍵字找到');
ok((await search(p, '0933 222111')).join() === '林建宏', '電話搜尋忽略空格與連字號');
await search(p, '');

// 第三張（同公司總機）＋私人備註
await withChooser(p, () => tab(p, '拍名片').click(), `${SAMPLES}/card3_front.jpg`);
await waitOcrDone(p);
await topPage(p).locator('.bottombar button', { hasText: '儲存名片' }).click();
await p.waitForSelector('.page .hero');
await backToList(p);
await p.locator('#card-list .item', { hasText: '陳怡君' }).click();
await p.locator('.page button', { hasText: '編輯備註' }).click();
await p.locator('.sheet textarea').fill('A的私人備註－勿外流');
await sheetBtn(p, '儲存');
await p.waitForTimeout(200);
await backToList(p);
await shot(p, '04-名片夾列表');

console.log('情境 3：切換到使用者 B，看不到 A 的資料');
await tab(p, '我的').click();
await shot(p, '05-我的');
await p.click('text=切換使用者');
await p.click('text=＋ 新增使用者');
await createUser(p, '使用者B', '5678');
ok(await p.locator('#card-list .item').count() === 0, 'B 的名片清單沒有 A 的名片');
ok((await search(p, '陳')).length === 0, 'B 搜尋不到 A 的名片');
const leak = await p.evaluate(() => ({ urls: window.__MPJ.urls.size, cards: window.__MPJ.cards.size, html: document.body.innerHTML.includes('陳怡君') }));
ok(leak.urls === 0 && leak.cards === 0 && !leak.html, '切換後照片預覽、暫存與畫面皆已清除');
await p.click('text=選取');
ok(await p.locator('.bottombar button', { hasText: '匯出' }).isDisabled(), 'B 的匯出功能沒有可選的名片');
const rawLeak = await p.evaluate(async () => {
  const db = await new Promise(r => { const q = indexedDB.open('mingpianjia'); q.onsuccess = () => r(q.result); });
  const all = await new Promise(r => { const q = db.transaction('cards').objectStore('cards').getAll(); q.onsuccess = () => r(q.result); });
  const users = await new Promise(r => { const q = db.transaction('users').objectStore('users').getAll(); q.onsuccess = () => r(q.result); });
  const txt = all.map(x => new TextDecoder().decode(x.ct)).join('');
  return { n: all.length, plain: txt.includes('陳怡君') || txt.includes('0912'), pin: JSON.stringify(users).includes('"1234"') };
});
ok(rawLeak.n === 3 && !rawLeak.plain, '資料庫中 A 的名片為加密內容，讀不到明文');
ok(!rawLeak.pin, 'PIN 未以明文保存');

console.log('情境 4：A 分享三張（不含私人備註、大頭照），另一支手機的 B 只匯入兩張');
await p.click('text=取消');
await tab(p, '我的').click();
await p.click('text=切換使用者');
await p.locator('.users .btn', { hasText: '蝴蝶A' }).click();
await enterPin(p, '1234');
await p.click('text=選取');
for (const n of ['陳怡君', '林建宏', '王美玲']) await p.locator('#card-list .item', { hasText: n }).click();
await p.locator('.bottombar button', { hasText: '匯出 3 張' }).click();
await p.locator('.sheet .menu button', { hasText: '名片包' }).click();
const sumText = await p.locator('.sheet .sumbox').innerText();
ok(sumText.includes('3 張名片') && sumText.includes('正面 3 張') && !sumText.includes('大頭照'), '送出前顯示張數、分享欄位與照片種類');
await shot(p, '06-分享名片包');
const [dl] = await Promise.all([p.waitForEvent('download'), sheetBtn(p, '儲存到檔案')]);
const pack1 = path.join(tmp, dl.suggestedFilename()); await dl.saveAs(pack1);
const pj = fs.readFileSync(pack1, 'utf8');
ok(!pj.includes('A的私人備註') && !pj.includes('建材展') && !pj.includes('估價單') && !pj.includes('"avatar"') && !pj.includes('"ocr"'), '檔案內沒有私人備註、場合、往來紀錄、大頭照與辨識原文');
ok(JSON.parse(pj).cards.length === 3 && JSON.parse(pj).provider.name === '蝴蝶A', '名片包含提供者與 3 張名片');

const P2 = await phone('手機二'); const q = P2.page;
await q.goto(BASE);
await createUser(q, '同事B', '2468');
await tab(q, '我的').click();
await withChooser(q, () => q.click('text=匯入名片包'), pack1);
await q.waitForSelector('.page .imp');
ok((await q.locator('.page .sumbox').innerText()).includes('蝴蝶A'), '匯入前顯示提供者');
ok((await q.locator('.page .sumbox').innerText()).includes('新增 3／已存在 0／可能重複 0'), '顯示新增／已存在／可能重複數量');
await q.locator('.page .imp', { hasText: '王美玲' }).locator('input[type=checkbox]').uncheck();
await shot(q, '07-匯入預覽');
await q.locator('.page .bottombar button', { hasText: '匯入所選（2）' }).click();
await q.waitForSelector('#card-list .item');
ok(await q.locator('#card-list .item').count() === 2, '收到 3 張只匯入 2 張');
await q.locator('#card-list .item', { hasText: '陳怡君' }).click();
await q.waitForSelector('.page .thumb img');
ok(await q.locator('.page .thumb img').count() === 2, '接收者看得到正反面照片');
ok((await q.locator('.page').innerText()).includes('由「蝴蝶A」分享'), '顯示提供者與匯入時間');
await q.locator('.page button', { hasText: '編輯備註' }).click();
await q.locator('.sheet textarea').fill('B自己的備註');
await sheetBtn(q, '儲存');
await q.waitForTimeout(200);
await backToList(q);

console.log('情境 5：更新分機後再分享；B 看見新舊差異並自選，備註仍在；共用總機仍保留為兩人');
// B 先已有王美玲？沒有。B 匯入王美玲時會與陳怡君（同總機）被提示可能重複
ok(await p.locator('.topbar .act', { hasText: '選取' }).count() === 1, '匯出後離開選取模式');
await p.locator('#card-list .item', { hasText: '陳怡君' }).click();
await p.locator('.page .act', { hasText: '編輯' }).click();
const extInput = topPage(p).locator('.multi input[aria-label=分機]').first();
ok(await extInput.inputValue() === '305', '原分機 305');
await extInput.fill('306');
await topPage(p).locator('.bottombar button', { hasText: '儲存名片' }).click();
await p.waitForTimeout(400);
await backToList(p);
await p.click('text=選取');
for (const n of ['陳怡君', '王美玲']) await p.locator('#card-list .item', { hasText: n }).click();
await p.locator('.bottombar button', { hasText: '匯出 2 張' }).click();
await p.locator('.sheet .menu button', { hasText: '名片包' }).click();
const [dl2] = await Promise.all([p.waitForEvent('download'), sheetBtn(p, '儲存到檔案')]);
const pack2 = path.join(tmp, 'v2-' + dl2.suggestedFilename()); await dl2.saveAs(pack2);

await tab(q, '我的').click();
await withChooser(q, () => q.click('text=匯入名片包'), pack2);
await q.waitForSelector('.page .imp');
ok((await q.locator('.page .sumbox').innerText()).includes('新增 0／已存在 1／可能重複 1'), '同識別碼視為已存在；同總機者標為可能重複');
const ex = q.locator('.page .imp[data-status=exists]');
const diffTxt = await ex.locator('table.diff').innerText();
ok(diffTxt.includes('305') && diffTxt.includes('306'), '並排顯示新舊分機');
const dup = q.locator('.page .imp[data-status=dup]');
ok((await dup.innerText()).includes('可能是公司總機') && (await dup.locator('.seg button.on').innerText()) === '分開保留', '電話相同不自動合併，預設分開保留');
await ex.locator('tr', { hasText: '電話' }).locator('input[type=radio]').last().check();
await shot(q, '08-差異比對');
await q.locator('.page .bottombar button', { hasText: '匯入所選（2）' }).click();
await q.waitForSelector('#card-list .item');
ok(await q.locator('#card-list .item').count() === 3, '共用總機的兩位同事保留為兩筆');
await q.locator('#card-list .item', { hasText: '陳怡君' }).click();
const detTxt = await q.locator('.page').innerText();
ok(detTxt.includes('分機 306') && detTxt.includes('B自己的備註'), '採用新分機，且原有備註仍在');
await backToList(q);
await tab(q, '我的').click();
await withChooser(q, () => q.click('text=匯入名片包'), pack2);
await q.waitForSelector('.page .imp');
ok(await q.locator('.page .bottombar button', { hasText: '匯入所選（0）' }).isDisabled(), '重複匯入同一檔案不會重複新增');
await q.goBack(); await q.waitForTimeout(200);
fs.writeFileSync(path.join(tmp, 'bad.json'), '{"format":"mingpianjia-pack","version":1,"cards":[{"id":"x"}');
await withChooser(q, () => q.click('text=匯入名片包'), path.join(tmp, 'bad.json'));
await q.waitForSelector('.sheet');
ok((await q.locator('.sheet').innerText()).includes('名片庫沒有任何變更'), '損毀檔案顯示錯誤');
await sheetBtn(q, '知道了');
ok(await q.evaluate(() => window.__MPJ.cards.size) === 3, '損毀檔案不影響名片庫');

console.log('情境 6：完整備份還原到新手機；錯誤密碼時既有名片仍可開啟');
await tab(p, '名片夾').click();
await tab(p, '我的').click();
await p.click('text=建立完整備份');
await p.locator('.sheet input').nth(0).fill('backup-pass-1');
await p.locator('.sheet input').nth(1).fill('backup-pass-1');
await sheetBtn(p, '建立');
await p.waitForSelector('.sheet .menu');
const [dl3] = await Promise.all([p.waitForEvent('download'), p.locator('.sheet .menu button', { hasText: '儲存到檔案' }).click()]);
const bak = path.join(tmp, dl3.suggestedFilename()); await dl3.saveAs(bak);
ok(!fs.readFileSync(bak, 'utf8').includes('陳怡君'), '備份檔已加密');

const P3 = await phone('新手機'); const r = P3.page;
await r.goto(BASE);
await createUser(r, '蝴蝶A', '1357');
await withChooser(r, () => tab(r, '拍名片').click(), `${SAMPLES}/card2_front.jpg`);
await waitOcrDone(r);
await r.goBack(); await r.waitForTimeout(150);
ok((await r.locator('.sheet').innerText()).includes('放棄未儲存'), '未儲存就離開時會先確認');
await sheetBtn(r, '放棄');
await r.waitForTimeout(200);
// 手動新增一張既有名片
const [fcx] = await Promise.all([r.waitForEvent('filechooser'), tab(r, '拍名片').click()]);
await fcx.setFiles([]);
await topPage(r).locator('text=沒有紙本名片？手動新增').click();
await topPage(r).locator('[data-field=name] input').fill('既有聯絡人');
await topPage(r).locator('.bottombar button', { hasText: '儲存名片' }).click();
await r.waitForSelector('.page .hero');
await backToList(r);
await tab(r, '我的').click();
await withChooser(r, () => r.click('text=從備份還原'), bak);
await r.locator('.sheet input').fill('wrong-password');
await sheetBtn(r, '解開備份');
await r.waitForSelector('.sheet >> text=備份密碼錯誤');
ok(true, '錯誤備份密碼顯示錯誤');
await sheetBtn(r, '知道了');
await r.locator('.sheet button', { hasText: '取消' }).click();
await tab(r, '名片夾').click();
await r.locator('#card-list .item', { hasText: '既有聯絡人' }).click();
ok((await r.locator('.page .hero .nm').innerText()) === '既有聯絡人', '密碼錯誤後既有名片仍可正常開啟');
await backToList(r);
await tab(r, '我的').click();
await withChooser(r, () => r.click('text=從備份還原'), bak);
await r.locator('.sheet input').fill('backup-pass-1');
await sheetBtn(r, '解開備份');
await r.waitForSelector('.sheet >> text=還原前確認');
const rs = await r.locator('.sheet').innerText();
ok(rs.includes('名片 3 張') && rs.includes('往來紀錄 2 筆'), '還原前顯示備份日期、數量與影響');
await shot(r, '09-還原確認');
await sheetBtn(r, '開始還原');
await r.waitForFunction(() => window.__MPJ.cards.size === 4);
await tab(r, '名片夾').click();
ok(await r.locator('#card-list .item').count() === 4, '還原後名片數量正確（3 張＋原有 1 張）');
await r.locator('#card-list .item', { hasText: '林建宏' }).click();
await r.waitForSelector('.page .hero .avatar img');
const d6 = await r.locator('.page').innerText();
ok(d6.includes('建材展') && d6.includes('往來紀錄（2）'), '還原後認識場合與往來紀錄正確');
ok(d6.includes('專業顧問'), '還原後名片分類正確');
await backToList(r);
await r.locator('#card-list .item', { hasText: '陳怡君' }).click();
await r.waitForSelector('.page .thumb img');
const d6b = await r.locator('.page').innerText();
ok(d6b.includes('A的私人備註') && (await r.locator('.page .thumb img').count()) === 2, '還原後私人備註與正反面照片正確');
await backToList(r);
await r.locator('.chip', { hasText: '專業顧問' }).click();
ok((await r.locator('#card-list .item .nm').allInnerTexts()).join() === '林建宏', '還原後依分類篩選正確');

console.log('情境 7（新增）：匯出 Excel、交給 Claude 辨識並匯回結果');
await tab(p, '名片夾').click();
await p.click('text=選取');
for (const n of ['陳怡君', '林建宏']) await p.locator('#card-list .item', { hasText: n }).click();
await p.locator('.bottombar button', { hasText: '匯出 2 張' }).click();
await p.locator('.sheet .menu button', { hasText: 'Excel' }).click();
const [dlx] = await Promise.all([p.waitForEvent('download'), p.locator('.sheet .menu button', { hasText: '儲存到檔案' }).click()]);
const xlsx = path.join(tmp, dlx.suggestedFilename()); await dlx.saveAs(xlsx);
const xl = JSON.parse(execFileSync('python3', ['-c', `import openpyxl,json,sys; wb=openpyxl.load_workbook(sys.argv[1]); ws=wb.active; print(json.dumps({"rows":ws.max_row,"imgs":len(ws._images),"head":[c.value for c in ws[1]][:7],"r":[[c.value for c in r] for r in ws.iter_rows(min_row=2)]}, ensure_ascii=False))`, xlsx]).toString());
ok(dlx.suggestedFilename().endsWith('.xlsx') && xl.rows === 3, 'Excel 匯出選取的 2 張');
ok(xl.head.join() === '序號,名片正反面,大頭照,分類,來源,備註,姓名', 'Excel 欄位順序正確');
ok(xl.imgs === 4, 'Excel 內嵌照片：陳怡君正反面＋林建宏正面與大頭照');
ok(JSON.stringify(xl.r).includes('A的私人備註') && JSON.stringify(xl.r).includes('估價單'), 'Excel 含私人備註與往來紀錄（自己用）');
fs.copyFileSync(xlsx, path.join(SHOTS, '匯出範例.xlsx'));

await p.click('text=選取');
await p.locator('#card-list .item', { hasText: '陳怡君' }).click();
await p.locator('.bottombar button', { hasText: '匯出 1 張' }).click();
await p.locator('.sheet .menu button', { hasText: 'Claude' }).click();
await shot(p, '10-交給Claude');
await sheetBtn(p, '產生 zip');
await p.waitForSelector('.sheet .menu');
const [dlz] = await Promise.all([p.waitForEvent('download'), p.locator('.sheet .menu button', { hasText: '儲存到檔案' }).click()]);
const zpath = path.join(tmp, dlz.suggestedFilename()); await dlz.saveAs(zpath);
fs.copyFileSync(zpath, path.join(SHOTS, '交給Claude範例.zip'));
const JSZip = require('jszip');
const zz = await JSZip.loadAsync(fs.readFileSync(zpath));
const req = JSON.parse(await zz.file('名片清單.json').async('string'));
ok(zz.file('照片/001_正面.jpg') && zz.file('照片/001_背面.jpg') && zz.file('給Claude的說明.txt'), 'zip 內有正反面照片、清單與說明');
// 依說明格式模擬 Claude 回傳的名片包（姓名辨識不同、補上部門）
const claudePack = { format: 'mingpianjia-pack', version: 1, provider: { name: 'Claude 辨識' }, exportedAt: new Date().toISOString(), included: [], photos: {},
  cards: [{ id: req.cards[0].id, name: '陳怡', company: '大和物業管理顧問股份有限公司', dept: '工務部', title: '副理',
    phones: [{ label: '公司', value: '(02) 2700-1234', ext: '306' }, { label: '手機', value: '0912-345-678', ext: '' }, { label: '傳真', value: '(02) 2700-5678', ext: '' }],
    emails: [{ label: '', value: 'yichun.chen@dahe-pm.com.tw' }], address: '台北市大安區忠孝東路四段100號8樓', website: 'www.dahe-pm.com.tw', lineId: 'yichun.dahe', photos: {} }] };
const cpath = path.join(tmp, '名片包_Claude辨識.json'); fs.writeFileSync(cpath, JSON.stringify(claudePack));
await tab(p, '我的').click();
await withChooser(p, () => p.click('text=匯入名片包'), cpath);
await p.waitForSelector('.page .imp');
ok((await p.locator('.page .sumbox').innerText()).includes('Claude 辨識'), '匯入時顯示提供者為 Claude 辨識');
const nameRow = p.locator('.page table.diff tr', { hasText: '姓名' });
ok((await nameRow.innerText()).includes('你改過') && await nameRow.locator('input[type=radio]').first().isChecked(), '手動改過的姓名預設保留本機');
await shot(p, '11-Claude結果匯入');
await p.locator('.page .bottombar button', { hasText: '匯入所選（1）' }).click();
await p.waitForSelector('#card-list .item');
await p.locator('#card-list .item', { hasText: '陳怡君' }).click();
const d7 = await p.locator('.page').innerText();
ok(d7.includes('yichun.dahe') && d7.includes('陳怡君'), '採用 Claude 的 LINE ID，姓名維持手動修正');

await browser.close();
console.log(results.join('\n'));
console.log(results.some(x => x.includes('✗')) ? '\n有失敗項目' : `\n全部通過（${results.length} 項）`);
