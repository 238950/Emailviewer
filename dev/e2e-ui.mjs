// 开发用 E2E：通过 Chrome DevTools Protocol 真实点击界面并断言
// 运行前提：本机服务已在 http://127.0.0.1:3869 启动、本机装有 Chrome。
// 用法：node dev/e2e-ui.mjs [chromePath]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const chrome = process.argv[2] || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const APP = 'http://127.0.0.1:3869';
const DBG = 9333;
const PROF = path.join(here, '.e2eprofile');

fs.rmSync(PROF, { recursive: true, force: true });
fs.mkdirSync(PROF, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[e2e]', ...a);

const pageEval = (() => {
  let ws;
  let msgId = 0;
  const pending = new Map();
  async function connect() {
    // 连接“页面”目标而不是浏览器目标（页面目标才有 Runtime/Page 域）
    let list = await (await fetch(`http://127.0.0.1:${DBG}/json/list`)).json();
    let target = list.find((t) => t.type === 'page');
    if (!target) {
      await fetch(`http://127.0.0.1:${DBG}/json/new?about:blank`, { method: 'PUT' });
      list = await (await fetch(`http://127.0.0.1:${DBG}/json/list`)).json();
      target = list.find((t) => t.type === 'page');
    }
    const wsUrl = target.webSocketDebuggerUrl;
    ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        log('页面异常:', (d.exception && d.exception.description || d.text || '').slice(0, 400));
      }
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        log('控制台错误:', (msg.params.args || []).map((a) => a.value || a.description || '').join(' ').slice(0, 300));
      }
    };
    await send('Runtime.enable', {});
    await send('Page.enable', {});
  }
  function send(method, params = {}) {
    return new Promise((res, rej) => {
      const id = ++msgId;
      pending.set(id, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result)));
      ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async function ev(expression, timeout = 15000) {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('页面异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
    return r.result?.value;
  }
  return { connect, ev, send };
})();

async function goUrl(url) {
  await pageEval.send('Page.navigate', { url });
  await sleep(1600);
}
async function textInPage() {
  return pageEval.ev('document.body ? document.body.innerText.slice(0, 20000) : ""');
}

function checkFound(text, mark) { return text.includes(mark); }

let chromeProc;
let chromeErr = '';
try {
  chromeProc = spawn(chrome, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=' + DBG, '--user-data-dir=' + PROF, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  chromeProc.stderr.on('data', (d) => { chromeErr += d.toString(); });
  chromeProc.on('exit', (code) => log('chrome exited code=', code));

  // 等待 CDP 就绪后再建立连接
  let ready = false;
  for (let i = 0; i < 40; i++) {
    try { await fetch(`http://127.0.0.1:${DBG}/json/version`); ready = true; break; } catch { await sleep(500); }
  }
  if (!ready) throw new Error('Chrome CDP 未就绪');
  await pageEval.connect();

  // 0) 先给两封 CUHK 邮件打标签（供智能收件箱标签测试）
  const accs = (await (await fetch(`${APP}/api/accounts`)).json()).accounts;
  const cuhk = accs.find((a) => a.email.includes('cuhk'));
  const folders = (await (await fetch(`${APP}/api/accounts/${cuhk.id}/folders`)).json()).folders;
  const inbox = folders.find((f) => /Inbox$/i.test(f.name));
  const ms = (await (await fetch(`${APP}/api/messages?accountId=${cuhk.id}&folder=${encodeURIComponent(inbox.name)}&pageSize=4`)).json()).list;
  for (const m of ms.slice(0, 2)) {
    await fetch(`${APP}/api/messages/${m.id}/label`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: '招聘', add: true }),
    });
  }
  log('已给', ms.slice(0, 2).map((m) => m.id).join(','), '打标签「招聘」');

  // ===== A) 副账号收件箱：空态时长 + 点击邮件预览 =====
  await goUrl(APP + '/#view=mail');
  const t0 = Date.now();

  // 点击副账号（CUHK）头部
  const accClick = await pageEval.ev(`(() => {
    const heads = [...document.querySelectorAll('.acc-name')];
    const el = heads.find(h => (h.textContent||'').includes('1155'));
    if (el) { const block = el.closest('.acc-block'); block && block.click(); return true; }
    return false;
  })()`);
  log('A1 点击副账号:', accClick);
  await sleep(1800);

  const t1 = Date.now();
  const rowCount1 = await pageEval.ev(`document.querySelectorAll('.mail-row').length`);
  const empty1 = (await textInPage()).includes('这里没有邮件');
  const activeFolder = await pageEval.ev(`(() => { const a=document.querySelector('.folder-row.active'); return a ? a.textContent.trim().slice(0,40) : ''; })()`);
  log(`A2 副账号文件夹已自动选中「${activeFolder}」 rows=${rowCount1} empty=${empty1} 用时=${t1 - t0}ms`);

  // 若无行则手工点 Inbox 文件夹兜底
  let rows = rowCount1;
  if (rows === 0) {
    await pageEval.ev(`(() => { const f=[...document.querySelectorAll('.folder-row')]; const el=f.find(x=>/Inbox/i.test(x.textContent)); if(el){el.click();return true;} return false; })()`);
    await sleep(1200);
    rows = await pageEval.ev(`document.querySelectorAll('.mail-row').length`);
    log('A2b 手工点 Inbox 后 rows=', rows);
  }

  const previewOk = await (async () => {
    if (rows === 0) return '无邮件可点';
    await pageEval.ev(`(() => { const r=document.querySelector('.mail-row'); if(r){ r.click(); return true; } return false; })()`);
    // COM 冷启动可能需 10~60 秒，轮询等待阅读窗格出现标题
    let subj = ''; let body = null; let note = '';
    for (let i = 0; i < 40; i++) {
      await sleep(1000);
      const probe = await pageEval.ev(`(() => {
        const s=document.querySelector('.reader .r-subject');
        const h=document.querySelector('.reader .r-html');
        const t=document.querySelector('.reader .r-text');
        const sum=document.querySelector('.ai-summary-box');
        const layout=document.querySelector('.mail-layout');
        const reader=document.querySelector('.reader');
        const activeNav=[...document.querySelectorAll('.nav-btn.active')].map(e=>e.textContent.trim()).join(',');
        return { subj: s?s.textContent.slice(0,60):'', html:!!h, text:!!t, sum:!!sum, hasLayout:!!layout,
                 layoutCls: layout?layout.className:'', hasReader:!!reader,
                 readerTxt: reader?reader.innerText.slice(0,100):'', nav:activeNav };
      })()`);
      subj = probe.subj; body = probe;
      if (probe.subj || probe.html || probe.text) { break; }
      if (i === 4) note = '…（仍在等待正文，可能 Outlook COM 冷启动）';
    }
    log('A3 预览 subject=', subj, 'body=', JSON.stringify(body), note);
    return { subj, body };
  })();

  // ===== B) 智能收件箱：勾选副账号 → 标签筛选 → 预览 =====
  await goUrl(APP + '/#view=smart');
  await sleep(1800);
  // BUG-22 之后“统一收件箱”默认勾选全部账户，因此这里只在未勾选时才点击（点击会取消勾选）
  const accChip = await pageEval.ev(`(() => {
    const c=[...document.querySelectorAll('.acc-chip')].find(e=>(e.textContent||'').includes('1155'));
    if (!c) return false;
    if (!c.classList.contains('on')) { c.click(); return 'clicked'; }
    return 'already-on';
  })()`);
  log('B0 勾选CUHK账户chip:', accChip);
  await sleep(1600);
  const labelChips = await pageEval.ev(`[...document.querySelectorAll('.label-chip')].map(e=>e.textContent.trim())`);
  log('B1 标签chips=', JSON.stringify(labelChips));
  let smartRows = 0; let smartPreview = '未测';
  if (labelChips.some((x) => x.includes('招聘'))) {
    await pageEval.ev(`(() => { const c=[...document.querySelectorAll('.label-chip')].find(e=>e.textContent.includes('招聘')); if(c){c.click();return true;} return false; })()`);
    await sleep(1600);
    smartRows = await pageEval.ev(`document.querySelectorAll('.mail-row').length`);
    log('B2 标签筛选后 rows=', smartRows);
    if (smartRows > 0) {
      await pageEval.ev(`(() => { const r=document.querySelector('.mail-row'); if(r){r.click();return true;} return false; })()`);
      let smartPreviewSub = '';
      for (let i = 0; i < 40; i++) {
        await sleep(1000);
        smartPreviewSub = await pageEval.ev(`(() => { const s=document.querySelector('.reader .r-subject'); return s ? s.textContent.slice(0,50) : ''; })()`);
        if (smartPreviewSub) break;
      }
      smartPreview = smartPreviewSub;
      log('B3 智能收件箱预览 subject=', smartPreview);
    }
  } else {
    log('B1b 无招聘标签（检查数据是否落在该账户收件箱）');
  }

  // ===== C) 设置 → AI 智能：掩码格式 / 密钥输入为空 / 模型列表按钮 =====
  await goUrl(APP + '/#view=settings');
  await sleep(1600);
  const clickedAiTab = await pageEval.ev(`(() => { const b=[...document.querySelectorAll('.settings-tab')].find(e=>e.textContent.includes('AI')); if(b){b.click();return true;} return false; })()`);
  await sleep(1500);
  const aiProbe = await pageEval.ev(`(() => {
    const body = document.body.innerText;
    const keyInputs=[...document.querySelectorAll('.ai-prov-fields input[type=password]')];
    const masks=[...document.querySelectorAll('.key-mask')].map(e=>e.textContent.trim());
    const hasModelsBtn=[...document.querySelectorAll('button')].some(b=>b.textContent.includes('获取模型列表'));
    return {
      providers: document.querySelectorAll('.ai-prov').length,
      hasOldHint: body.includes('想更换请直接输入'),
      keyValues: keyInputs.map(i=>i.value),
      keyPlaceholders: keyInputs.map(i=>i.placeholder),
      masks: masks.slice(0,4),
      hasModelsBtn,
    };
  })()`);
  log('C 设置-AI:', JSON.stringify(aiProbe));
  const cMaskOk = aiProbe.masks.every((m) => /^(.{4}\*+.{4}|\*{4})$/.test(m));
  const cKeyEmptyOk = aiProbe.keyValues.every((v) => v === '');
  const cOk = clickedAiTab && !aiProbe.hasOldHint && aiProbe.hasModelsBtn && cMaskOk && cKeyEmptyOk;
  // 真实点击“获取模型列表”，校验下拉里出现可用模型
  const clickedModels = await pageEval.ev(`(() => {
    const card = document.querySelector('.ai-prov.active') || document.querySelector('.ai-prov');
    const btn = card ? [...card.querySelectorAll('button')].find(b => b.textContent.includes('获取模型列表')) : null;
    if (btn) { btn.click(); return true; }
    return false;
  })()`);
  let modelOpts = 0;
  for (let i = 0; i < 15; i++) {
    await sleep(1000);
    modelOpts = await pageEval.ev(`(() => {
      const card = document.querySelector('.ai-prov.active') || document.querySelector('.ai-prov');
      const sel = card ? card.querySelector('.model-picker-actions select') : null;
      return sel ? sel.options.length : 0;
    })()`);
    if (modelOpts > 5) break;
  }
  log(`C2 获取模型列表: clicked=${clickedModels} 下拉选项=${modelOpts}`);
  const c2Ok = clickedModels && modelOpts > 5;
  const cOkFinal = cOk && c2Ok;
  if (!c2Ok) log('C2 警告：模型列表为空（可能与当前默认服务商网络/额度有关）');
  log(`C 判定: 掩码格式=${cMaskOk} 输入框为空=${cKeyEmptyOk} 旧提示已移除=${!aiProbe.hasOldHint} 模型按钮=${aiProbe.hasModelsBtn} 模型列表=${c2Ok}`);

  // ===== D) AI 助手（Chatbox）：渲染 → 点预设提问 → 收到回复；铃铛通知存在 =====
  await goUrl(APP + '/#view=chat');
  await sleep(1800);
  const chatBtn = await pageEval.ev(`(() => { const b=[...document.querySelectorAll('.nav-btn')].find(x=>x.textContent.includes('AI 助手')); if(b) b.click(); return !!b; })()`);
  await sleep(1200);
  const presetClicked = await pageEval.ev(`(() => { const p=document.querySelector('.chat-presets .qchip'); if(p){p.click();return true;} return false; })()`);
  let botText = '';
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    botText = await pageEval.ev(`(() => { const b=document.querySelector('.chat-msg.bot .chat-text'); return b ? b.textContent.slice(0,80) : ''; })()`);
    if (botText) break;
  }
  log(`D Chatbox: nav=${chatBtn} presetClicked=${presetClicked} 回复="${botText}"`);
  const dOk = chatBtn && presetClicked && botText.length > 4;

  // 铃铛里的新邮件通知
  const bellOk = await pageEval.ev(`(() => {
    const bell=[...document.querySelectorAll('.icon-btn')].find(b=>b.querySelector('svg.lucide-bell')||b.title.includes('提醒'));
    if(bell) bell.click();
    return true;
  })()`);
  await sleep(800);
  const noticeText = await pageEval.ev(`(() => { const n=document.querySelector('.bell-item'); return n ? n.textContent.slice(0,70) : ''; })()`);
  log(`D 通知气泡: opened=${bellOk} 首条="${noticeText}"`);

  // ===== E) 首页 → 卡片预览 → 一键“发给 AI 助手” =====
  await goUrl(APP + '/#view=home');
  await sleep(2600);
  const homeInfo = await pageEval.ev(`(() => {
    const titles = [...document.querySelectorAll('.home-col-head b')].map(e => e.textContent.trim());
    return { titles, cards: document.querySelectorAll('.home-card').length };
  })()`);
  log('E1 首页:', JSON.stringify(homeInfo));
  const cardClicked = await pageEval.ev(`(() => { const c = document.querySelector('.home-card'); if (c) { c.click(); return true; } return false; })()`);
  let homeSubj = '';
  for (let i = 0; i < 40; i++) {
    await sleep(1000);
    homeSubj = await pageEval.ev(`(() => { const s = document.querySelector('.home-layout .reader .r-subject'); return s ? s.textContent.slice(0,50) : ''; })()`);
    if (homeSubj) break;
  }
  log(`E2 首页卡片预览: clicked=${cardClicked} subject="${homeSubj}"`);
  const aiBtnClicked = await pageEval.ev(`(() => {
    const b = document.querySelector('.ai-cta') ||
              [...document.querySelectorAll('.reader .icon-btn')].find(x => (x.title||'').includes('发给 AI'));
    if (b) { b.click(); return true; }
    return false;
  })()`);
  let eBot = ''; let eSources = 0;
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    eBot = await pageEval.ev(`(() => { const b=document.querySelector('.chat-msg.bot .chat-text'); return b ? b.textContent.slice(0,60) : ''; })()`);
    eSources = await pageEval.ev(`document.querySelectorAll('.chat-sources .ctx-chip').length`);
    if (eBot) break;
  }
  log(`E3 单封邮件送 AI: clicked=${aiBtnClicked} 回复="${eBot}" 来源chips=${eSources}`);
  const eOk = homeInfo.cards > 0 && !!homeSubj && aiBtnClicked && eBot.length > 4;

  // ===== F) 首页唯一归属 / 低相关列 / 标记已处理 / 左下角重要已处理入口 =====
  await pageEval.ev(`(() => { const b=[...document.querySelectorAll('.nav-btn')].find(x=>x.textContent.includes('首页')); if(b){b.click();return true;} return false; })()`);
  for (let i = 0; i < 25; i++) {
    await sleep(1000);
    const n = await pageEval.ev(`document.querySelectorAll('.home-card').length`);
    if (n > 0) break;
  }
  const fInfo = await pageEval.ev(`(() => {
    const titles = [...document.querySelectorAll('.home-col-head b')].map(e => e.textContent.trim());
    const seen = {}; let dup = 0;
    document.querySelectorAll('.home-card').forEach(card => {
      const k = card.getAttribute('data-id');
      if (k) { if (seen[k]) dup++; seen[k] = 1; }
    });
    return { titles, cards: document.querySelectorAll('.home-card').length, dup,
             hasDoneEntry: [...document.querySelectorAll('.home-foot button')].some(b => b.textContent.includes('重要已处理')) };
  })()`);
  log('F1 首页列/重复/入口:', JSON.stringify(fInfo));
  const firstSubject = await pageEval.ev(`(() => { const s=document.querySelector('.home-card .home-card-subject'); return s ? s.textContent.trim() : ''; })()`);
  const doneClicked = await pageEval.ev(`(() => { const b=document.querySelector('.home-card .card-done-btn'); if(b){b.click();return true;} return false; })()`);
  let hidden = false; let doneBadge = '';
  for (let i = 0; i < 20; i++) {
    await sleep(700);
    const st = await pageEval.ev(`(() => {
      const subs = [...document.querySelectorAll('.home-card-subject')].map(e => e.textContent.trim());
      const badge = document.querySelector('.home-foot .done-count');
      return { absent: subs.indexOf(${JSON.stringify(firstSubject)}) < 0, badge: badge ? badge.textContent : '' };
    })()`);
    hidden = st.absent; doneBadge = st.badge;
    if (hidden) break;
  }
  log(`F2 标记已处理: clicked=${doneClicked} 从首页消失=${hidden} 入口计数=${doneBadge}`);
  const archiveOk = await pageEval.ev(`(() => {
    const b = [...document.querySelectorAll('.home-foot button')].find(x => x.textContent.includes('重要已处理'));
    if (b) { b.click(); return true; } return false;
  })()`);
  await sleep(1300);
  const archiveItems = await pageEval.ev(`document.querySelectorAll('.done-item').length`);
  await pageEval.ev(`(() => { const b=[...document.querySelectorAll('.done-item .mini-btn')].find(x=>x.textContent.includes('取消已处理')); if(b){b.click();return true;} return false; })()`);
  await sleep(800);
  await pageEval.ev(`(() => { const b=[...document.querySelectorAll('.modal .btn')].find(x=>x.textContent.trim()==='关闭'); if(b){b.click();return true;} return false; })()`);
  const fOk = fInfo.titles.includes('低相关邮件') && fInfo.dup === 0 && fInfo.hasDoneEntry && doneClicked && hidden && archiveItems > 0;
  log(`F3 重要已处理入口: opened=${archiveOk} 条目=${archiveItems}`);

  // 汇总
  log('==RESULT==');
  log('A preview:', JSON.stringify(previewOk));
  log('B rows:', smartRows, 'preview:', smartPreview);
  log('C settings-AI ok:', cOkFinal);
  log('D chat ok:', dOk);
  log('E home/send-to-AI ok:', eOk);
  log('F home-unique/done ok:', fOk);

  // 清理：测试标签 + 兜底取消所有“已处理”标记
  for (const m of ms.slice(0, 2)) {
    await fetch(`${APP}/api/messages/${m.id}/label`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: '招聘', add: false }),
    });
  }
  try {
    const dn = await (await fetch(`${APP}/api/home/done`)).json();
    for (const it of (dn.items || [])) {
      await fetch(`${APP}/api/messages/${it.id}/done`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ done: false }),
      });
    }
    log(`测试清理：标签已移除；已处理标记复位 ${(dn.items || []).length} 封`);
  } catch { log('测试清理：已处理复位跳过'); }

  process.exitCode = (previewOk && previewOk.subj) && (smartPreview && smartPreview.length) && cOkFinal && dOk && eOk && fOk ? 0 : 2;
} catch (e) {
  log('E2E FAILED:', e.message);
  if (chromeErr) log('chrome stderr:', chromeErr.slice(-800));
  process.exitCode = 1;
} finally {
  try { if (chromeProc) chromeProc.kill(); } catch { /* */ }
  await sleep(600);
  fs.rmSync(PROF, { recursive: true, force: true });
}
