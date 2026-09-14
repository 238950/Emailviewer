// BUG-28 验证：导出真实 .ics 文件，检查是否满足 RFC 5545（DTSTAMP / 转义 / 折行 / 全天事件）
// 用法：node dev/verify-ics.mjs [chromePath]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const chrome = process.argv[2] || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const APP = 'http://127.0.0.1:3869';
const DBG = 9335;
const PROF = path.join(here, '.e2eprofile3');
const DLDIR = path.join(here, '.icsdl');
for (const d of [PROF, DLDIR]) { fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true }); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (id, name, pass, detail = '') => { results.push({ id, name, pass }); console.log(`[${pass ? 'PASS' : 'FAIL'}] ${id} ${name}${detail ? ` — ${detail}` : ''}`); };

let chromeProc = null;
try {
  chromeProc = spawn(chrome, [
    `--remote-debugging-port=${DBG}`, `--user-data-dir=${PROF}`, '--headless=new',
    '--disable-gpu', '--no-first-run', '--no-default-browser-check', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'ignore'] });
  let ready = false;
  for (let i = 0; i < 40; i++) { await sleep(400); try { await fetch(`http://127.0.0.1:${DBG}/json/version`); ready = true; break; } catch { /* 等待 */ } }
  if (!ready) throw new Error('Chrome CDP 未就绪');

  let list = await (await fetch(`http://127.0.0.1:${DBG}/json/list`)).json();
  let target = list.find((t) => t.type === 'page');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let msgId = 0;
  const pending = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
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
  await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DLDIR }).catch(async () => {
    await send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: DLDIR });
  });

  // 造一个含逗号/分号的定时事件 + 一个全天事件
  const start = Date.now() + 3 * 86400000;
  const mk = async (body) => (await (await fetch(`${APP}/api/events`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })).json()).event;
  const e1 = await mk({ title: '验证; 逗号,测试（RFC5545 转义）'.padEnd(80, '长'), startMs: start, endMs: start + 3600000, note: '第一行\n第二行, 含逗号; 分号' });
  const e2 = await mk({ title: '验证全天事件', startMs: start + 86400000, allDay: true });

  await send('Page.navigate', { url: `${APP}/#view=calendar` });
  await sleep(3000);

  const exportOne = async (id, ev_) => {
    // 通过事件详情弹窗导出（点日历格子里的“+N”或事件块）
    const opened = await ev(`(() => {
      const blocks=[...document.querySelectorAll('.cal-evt')];
      const b=blocks.find(x=>x.textContent.includes(${JSON.stringify(String(ev_.title).slice(0, 8))}));
      if (b) { b.click(); return true; }
      return false;
    })()`);
    if (!opened) return false;
    await sleep(1200);
    const clicked = await ev(`(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('导出 .ics')); if(b){b.click();return true;} return false; })()`);
    await sleep(1500);
    void id;
    return clicked;
  };

  await exportOne(e1.id, e1);
  await exportOne(e2.id, e2);
  await sleep(1500);

  const files = fs.readdirSync(DLDIR).filter((f) => f.endsWith('.ics'));
  check('BUG-28a', '能导出 .ics 文件', files.length >= 1, `文件：${JSON.stringify(files)}`);
  const ics = files.map((f) => fs.readFileSync(path.join(DLDIR, f), 'utf8')).join('\n---\n');
  check('BUG-28b', '包含必需的 DTSTAMP', /DTSTAMP:\d{8}T\d{6}Z/.test(ics), (ics.match(/DTSTAMP:[^\r\n]*/) || [''])[0]);
  check('BUG-28c', 'SUMMARY 中的 , ; 已转义', /SUMMARY:[^\r\n]*\\,/.test(ics) && /SUMMARY:[^\r\n]*\\;/.test(ics),
    (ics.match(/SUMMARY:[^\r\n]*/) || [''])[0].slice(0, 90));
  check('BUG-28d', 'DESCRIPTION 中的换行转成 \\n', /DESCRIPTION:[^\r\n]*\\n/.test(ics),
    (ics.match(/DESCRIPTION:[^\r\n]*/) || [''])[0].slice(0, 80));
  const longLine = ics.split(/\r?\n/).filter((l) => Buffer.byteLength(l, 'utf8') > 75);
  check('BUG-28e', '所有行不超过 75 字节（已折行）', longLine.length === 0, `超长行 ${longLine.length} 行`);
  check('BUG-28f', '全天事件用 VALUE=DATE', /DTSTART;VALUE=DATE:\d{8}/.test(ics), (ics.match(/DTSTART[^\r\n]*/) || [''])[0]);

  // 清理测试事件
  for (const id of [e1.id, e2.id]) await fetch(`${APP}/api/events/${id}`, { method: 'DELETE' });

  const fail = results.filter((r) => !r.pass);
  console.log(`\n=== ICS 验证：${results.length - fail.length}/${results.length} 通过 ===`);
  if (fail.length) process.exitCode = 1;
} catch (e) {
  console.error('ICS 验证异常：', e.message);
  process.exitCode = 2;
} finally {
  try { if (chromeProc) chromeProc.kill(); } catch { /* */ }
  await sleep(400);
  fs.rmSync(PROF, { recursive: true, force: true });
  fs.rmSync(DLDIR, { recursive: true, force: true });
}
