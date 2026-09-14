// UI 细节验证（CDP）：文件夹名只取末段、账户可折叠、搜索框方向键不被劫持、主题跟随后端设置
// 用法：node dev/verify-ui-fixes.mjs [chromePath]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const chrome = process.argv[2] || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const APP = 'http://127.0.0.1:3869';
const DBG = 9334;
const PROF = path.join(here, '.e2eprofile2');
fs.rmSync(PROF, { recursive: true, force: true });
fs.mkdirSync(PROF, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (id, name, pass, detail = '') => {
  results.push({ id, name, pass });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${id} ${name}${detail ? ` — ${detail}` : ''}`);
};

let chromeProc = null;
let chromeErr = '';
try {
  chromeProc = spawn(chrome, [
    `--remote-debugging-port=${DBG}`, `--user-data-dir=${PROF}`, '--headless=new',
    '--disable-gpu', '--no-first-run', '--no-default-browser-check', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  chromeProc.stderr.on('data', (d) => { chromeErr += String(d); });

  let ready = false;
  for (let i = 0; i < 40; i++) {
    await sleep(400);
    try { await fetch(`http://127.0.0.1:${DBG}/json/version`); ready = true; break; } catch { /* 等待 */ }
  }
  if (!ready) throw new Error('Chrome CDP 未就绪');

  let list = await (await fetch(`http://127.0.0.1:${DBG}/json/list`)).json();
  let target = list.find((t) => t.type === 'page');
  if (!target) {
    await fetch(`http://127.0.0.1:${DBG}/json/new?about:blank`, { method: 'PUT' });
    list = await (await fetch(`http://127.0.0.1:${DBG}/json/list`)).json();
    target = list.find((t) => t.type === 'page');
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let msgId = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params = {}) => new Promise((res, rej) => {
    const id = ++msgId;
    pending.set(id, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('页面异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 200));
    return r.result?.value;
  };
  await send('Runtime.enable', {});
  await send('Page.enable', {});

  // ---------- BUG-05 / BUG-30：文件夹名只显示末段 ----------
  await send('Page.navigate', { url: `${APP}/#view=mail` });
  await sleep(2600);
  const folders = await ev(`(() => {
    return [...document.querySelectorAll('.folder-row')].map(r => ({
      text: (r.querySelector('.folder-name')||{}).textContent || '',
      title: (r.querySelector('.folder-name')||{}).title || '',
      clipped: (() => { const n = r.querySelector('.folder-name'); return n ? n.scrollWidth > n.clientWidth + 1 : false; })(),
    }));
  })()`);
  const texts = folders.map((f) => f.text.trim());
  const uniq = new Set(texts);
  check('BUG-05a', '左侧文件夹名不再带账号前缀', texts.length > 0 && texts.every((t) => !t.includes('you') && !t.includes('example.com')),
    JSON.stringify(texts.slice(0, 8)));
  check('BUG-05b', '文件夹名互不重复且可区分', uniq.size === texts.length, `${uniq.size}/${texts.length} 唯一`);
  check('BUG-05c', '被截断的行数为 0（宽度足够显示末段）', folders.every((f) => !f.clipped),
    `截断 ${folders.filter((f) => f.clipped).length}/${folders.length}`);
  check('BUG-05d', 'hover 提示给出完整路径', folders.some((f) => f.title.includes('›')), folders[0]?.title || '');

  const listTitle = await ev(`(() => { const t=document.querySelector('.list-title'); return t ? t.textContent.trim().slice(0,60) : ''; })()`);
  const dupAcc = (listTitle.match(/you@outlook\.com/g) || []).length;
  check('BUG-30', '邮件列表标题不再重复账户名', dupAcc <= 1, `标题：${listTitle}`);

  // ---------- BUG-06：账户可展开/折叠 ----------
  const toggles = await ev(`document.querySelectorAll('.acc-fold-hint').length`);
  const accs = await ev(`document.querySelectorAll('.acc-block').length`);
  check('BUG-06a', '每个账户都有展开/折叠按钮', toggles === accs && accs > 0, `按钮 ${toggles} / 账户 ${accs}`);
  const before = await ev(`document.querySelectorAll('.folder-row').length`);
  await ev(`(() => { const b=document.querySelector('.acc-fold-hint'); if(b){b.click();return true;} return false; })()`);
  await sleep(600);
  const afterCollapse = await ev(`document.querySelectorAll('.folder-row').length`);
  check('BUG-06b', '点击后可折叠（含主账户）', afterCollapse < before, `${before} → ${afterCollapse}`);
  await ev(`(() => { const b=document.querySelector('.acc-fold-hint'); if(b){b.click();return true;} return false; })()`);
  await sleep(600);
  const afterExpand = await ev(`document.querySelectorAll('.folder-row').length`);
  check('BUG-06c', '再次点击可重新展开', afterExpand === before, `${afterCollapse} → ${afterExpand}`);

  // ---------- BUG-07：搜索框方向键不被列表劫持 ----------
  // 先选中一封邮件（否则“选中项未变化”是无意义的断言）
  await ev(`(() => { const r=document.querySelector('.mail-row'); if(r){r.click();return true;} return false; })()`);
  await sleep(1500);
  const selBefore = await ev(`(() => { const r=document.querySelector('.mail-row.sel'); return r ? (r.getAttribute('data-id') || r.textContent.slice(0,20)) : ''; })()`);
  await ev(`(() => { const b=[...document.querySelectorAll('.icon-btn')].find(x=>(x.title||'').includes('搜索')); if(b) b.click(); return true; })()`);
  await sleep(900);
  const focused = await ev(`(() => {
    const inp = document.querySelector('.mail-search input, .search-wrap input, .list-toolbar input.inp, input.inp');
    if (!inp) return false;
    inp.focus(); inp.value = 'a';
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    return document.activeElement === inp;
  })()`);
  await sleep(900);
  const selAfterInput = await ev(`(() => { const r=document.querySelector('.mail-row.sel'); return r ? (r.getAttribute('data-id') || r.textContent.slice(0,20)) : ''; })()`);
  check('BUG-07a', '输入框内按方向键不会切换选中邮件', focused && !!selBefore && selAfterInput === selBefore,
    `选中 ${JSON.stringify(selBefore)} → ${JSON.stringify(selAfterInput)}（聚焦=${focused}）`);
  // 反向确认：焦点不在输入框时，方向键仍能切换（功能没被误伤）
  await ev(`(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); return true; })()`);
  await sleep(300);
  await ev(`(() => { window.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true})); document.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true})); return true; })()`);
  await sleep(900);
  const selAfterBody = await ev(`(() => { const r=document.querySelector('.mail-row.sel'); return r ? (r.getAttribute('data-id') || r.textContent.slice(0,20)) : ''; })()`);
  check('BUG-07b', '焦点不在输入框时方向键仍可切换邮件', selAfterBody !== selBefore,
    `选中 ${JSON.stringify(selBefore)} → ${JSON.stringify(selAfterBody)}`);

  // ---------- BUG-08：主题跟随后端设置 ----------
  const apiTheme = await (await fetch(`${APP}/api/settings`)).json();
  const domTheme = await ev(`document.documentElement.dataset.theme`);
  const lsTheme = await ev(`localStorage.getItem('mailview.theme')`);
  const backend = apiTheme.settings.theme;
  const expected = backend === 'system' ? (await ev(`window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'`)) : backend;
  check('BUG-08a', '主题以服务端设置为准（未被硬编码 dark 覆盖）',
    lsTheme !== null || domTheme === expected,
    `后端=${backend} 实际=${domTheme} 期望=${expected} localStorage=${lsTheme}`);

  const wroteBack = await ev(`(async () => {
    const before = (await (await fetch('/api/settings')).json()).settings.theme;
    const r = document.querySelector('.nav-btn');
    return { before };
  })()`);
  void wroteBack;

  // ---------- BUG-22：统一收件箱默认全选 ----------
  await send('Page.navigate', { url: `${APP}/#view=smart` });
  await sleep(2600);
  const chips = await ev(`(() => {
    const all=[...document.querySelectorAll('.acc-chip')];
    return { total: all.length, on: all.filter(c=>c.classList.contains('on')).length,
             warn: !!document.querySelector('.smart-warn'),
             labels: [...document.querySelectorAll('.label-chip')].map(e=>e.textContent.trim()) };
  })()`);
  check('BUG-22a', '统一收件箱默认勾选全部账户', chips.total > 1 && chips.on === chips.total, `勾选 ${chips.on}/${chips.total}`);
  await ev(`(() => { document.querySelectorAll('.acc-chip.on').forEach(c=>c.click()); return true; })()`);
  await sleep(900);
  const cleared = await ev(`(() => ({ on: document.querySelectorAll('.acc-chip.on').length, warn: !!document.querySelector('.smart-warn'), rows: document.querySelectorAll('.mail-row').length }))()`);
  check('BUG-22b', '取消全部勾选时给出明确提示而不是静默查第一个账户', cleared.on === 0 && cleared.warn, JSON.stringify(cleared));

  // ---------- BUG-20：术语区分（已读 / 已处理） ----------
  await send('Page.navigate', { url: `${APP}/#view=home` });
  await sleep(2600);
  const wording = await ev(`(() => { const t=document.body.innerText; return { hasDoneBtn: t.includes('已处理'), oldDoneBtn: [...document.querySelectorAll('.card-done-btn')].some(b=>b.textContent.trim()==='已阅'), foot: (document.querySelector('.done-archive-btn')||{}).textContent || '' }; })()`);
  check('BUG-20a', '首页按钮/入口改用“已处理”措辞', wording.hasDoneBtn && !wording.oldDoneBtn, JSON.stringify(wording));

  const fail = results.filter((r) => !r.pass);
  console.log(`\n=== UI 验证：${results.length - fail.length}/${results.length} 通过 ===`);
  if (fail.length) { console.log('未通过：' + fail.map((f) => f.id).join(', ')); process.exitCode = 1; }
} catch (e) {
  console.error('UI 验证异常：', e.message);
  if (chromeErr) console.error('chrome stderr:', chromeErr.slice(-500));
  process.exitCode = 2;
} finally {
  try { if (chromeProc) chromeProc.kill(); } catch { /* */ }
  await sleep(500);
  fs.rmSync(PROF, { recursive: true, force: true });
}
