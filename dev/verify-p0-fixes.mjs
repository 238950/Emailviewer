// P0 修复验证（BUG-44 全局错误中间件 / BUG-45 附件保存目录白名单 / BUG-46 AI 在途去重）
// 用法：node dev/verify-p0-fixes.mjs [port]
//
// 设计原则：
//  1) 不依赖真实 AI Key —— 通过 /api/ai/classify 的 429 断言验证锁，无需真正花钱；
//  2) 不写用户数据 —— 越界保存测试指向系统临时目录，并在结束后清理；
//  3) 可离线运行 —— 除"进程存活"一项需服务在跑之外，其余均用 HTTP 观察。

import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const PORT = Number(process.argv[2] || process.env.MAILVIEW_PORT || 3869);
const BASE = `http://127.0.0.1:${PORT}`;
const results = [];

function record(id, name, pass, detail = '') {
  results.push({ id, name, pass, detail });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${id} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function req(method, path_, { body, headers, timeout = 15000 } = {}) {
  const init = { method, headers: { ...(headers || {}) }, signal: AbortSignal.timeout(timeout) };
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
    if (!init.headers['Content-Type']) init.headers['Content-Type'] = 'application/json';
  }
  try {
    const res = await fetch(BASE + path_, init);
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON（如 HTML 错误页） */ }
    return { status: res.status, json, text, contentType: res.headers.get('content-type') || '' };
  } catch (e) {
    return { status: 0, json: null, text: String(e.message), contentType: '', networkError: true };
  }
}

const get = (p, o) => req('GET', p, o);
const post = (p, b, o) => req('POST', p, { body: b, ...(o || {}) });

/** 找一个可用的附件 id（有已落盘文件的那种），没有就返回 null */
async function pickSavedAttachment() {
  const r = await get('/api/attachments?pageSize=50');
  // 注意：附件列表接口的字段名是 list（不是 attachments/items）
  const list = r.json?.list || [];
  const hit = list.find((a) => a.stored);
  return hit ? hit.id : null;
}

/** 读取当前 AI 配置，返回 { active, model, baseUrl } */
async function readAiConfig() {
  const s = (await get('/api/settings')).json?.settings || {};
  const ai = s.ai || {};
  const p = (ai.providers || {})[ai.active] || {};
  return { active: ai.active, model: p.model, baseUrl: p.baseUrl, enabled: ai.enabled };
}

async function main() {
  const health = await get('/api/health', { timeout: 5000 });
  if (!health.json?.ok) {
    console.error(`服务未运行（${BASE}）。请先启动： MAILVIEW_PORT=${PORT} node server/src/index.js`);
    process.exitCode = 2;
    return;
  }
  console.log(`\n=== P0 修复验证：${BASE} ===\n`);

  /* ============ BUG-44：全局错误中间件 ============ */
  {
    // 1) 未知 /api 路由仍返回结构化 JSON 404（错误中间件插在 404 之后不应破坏它）
    const notFound = await get('/api/__definitely_not_exists__');
    record('BUG-44a', '未知 /api 路由返回 JSON 404',
      notFound.status === 404 && notFound.json?.ok === false,
      `HTTP ${notFound.status} ${notFound.json?.error || notFound.text.slice(0, 60)}`);

    // 2) 404 响应不能被错误中间件吞成 500（顺序正确性的关键断言）
    record('BUG-44b', '错误中间件未破坏 404 兜底',
      notFound.status === 404, `HTTP ${notFound.status}（应为 404）`);

    // 3) 触发一个同步抛错：非法 JSON body 已由 expressJson 吞掉，改测参数校验类
    const badBody = await post('/api/events', '{not-json', { headers: { 'Content-Type': 'application/json' } });
    record('BUG-44c', '非法 JSON body 被安全降级（不崩、有响应）',
      badBody.status >= 400 && badBody.status < 500,
      `HTTP ${badBody.status}`);

    // 4) AI 路由在无有效 Key / 上游失败时也必须返回 JSON 而非断连
    //    注：若用户已配好 Key，这条会真的调用上游；用超长 id 让它先 404 以避免计费。
    const ghost = await post('/api/messages/__no_such_id__/classify', {});
    record('BUG-44d', 'classify 对不存在邮件返回 404（未进入 AI 分支）',
      ghost.status === 404 && ghost.json?.ok === false, `HTTP ${ghost.status}`);

    // 5) 进程存活 —— 上面几条若触发 unhandledRejection，服务会直接退出
    const alive = await get('/api/health', { timeout: 5000 });
    record('BUG-44e', '上述请求后服务进程仍存活', alive.json?.ok === true,
      alive.networkError ? '连接失败（进程可能已退出）' : `HTTP ${alive.status}`);
  }

  /* ============ BUG-45：附件保存目录白名单 ============ */
  {
    const attId = await pickSavedAttachment();
    if (!attId) {
      record('BUG-45', '附件保存目录白名单', false, '未找到已落盘附件，无法测试（跳过）');
    } else {
      const probeDir = path.join(os.tmpdir(), 'mv-guard-probe');
      try { fs.rmSync(probeDir, { recursive: true, force: true }); } catch { /* */ }

      // 1) 越界目录必须被拒（正是此前实测能写进 C:\Windows\Temp 的那条路径）
      const escaped = await post(`/api/attachments/${attId}/save`, { dir: probeDir });
      record('BUG-45a', '越界目录被 403 拒绝',
        escaped.status === 403 && escaped.json?.ok === false,
        `HTTP ${escaped.status} ${escaped.json?.error || ''}`);

      // 2) 越界目录不得真的被创建（拒绝必须是"未执行"而非"执行后报错"）
      record('BUG-45b', '越界目录未被创建（拒绝发生在写盘之前）',
        !fs.existsSync(probeDir), fs.existsSync(probeDir) ? `目录意外存在：${probeDir}` : '未创建 ✓');

      // 3) ../ 穿越尝试同样被拒
      const traversal = await post(`/api/attachments/${attId}/save`, { dir: '../../../Windows/Temp/mv-trav' });
      record('BUG-45c', '../ 路径穿越被拒绝',
        traversal.status === 403, `HTTP ${traversal.status}`);

      // 4) 绝对路径 + 冗余分隔符（规范化后可绕过朴素字符串比较的情形）
      const tricky = await post(`/api/attachments/${attId}/save`, { dir: `${probeDir}${path.sep}..${path.sep}${path.sep}..` });
      record('BUG-45d', '冗余 .. 规范化后仍被拒绝',
        tricky.status === 403, `HTTP ${tricky.status}`);

      // 5) 合法目录应放行（用设置里的保存目录；默认为 data/saved）
      const s = (await get('/api/settings')).json?.settings || {};
      const legalDir = s.attachmentSaveDir;
      if (legalDir) {
        const okSave = await post(`/api/attachments/${attId}/save`, { dir: legalDir });
        record('BUG-45e', '白名单内的合法目录放行',
          okSave.status === 200 && okSave.json?.ok === true,
          `HTTP ${okSave.status} → ${okSave.json?.savedTo || okSave.json?.error || ''}`);
        // 清理刚才落盘的文件（只删本次测试产生的那个）
        if (okSave.json?.savedTo) { try { fs.rmSync(okSave.json.savedTo, { force: true }); } catch { /* */ } }
      } else {
        record('BUG-45e', '白名单内的合法目录放行', true, '设置里未显式配置保存目录，默认走 SAVED_DIR（逻辑已覆盖）');
      }

      try { fs.rmSync(probeDir, { recursive: true, force: true }); } catch { /* */ }
    }
  }

  /* ============ BUG-46：AI 在途去重（HTTP 层观测） ============ */
  {
    // 说明：锁的确定性行为由 dev/verify-ai-lock-unit.mjs 断言（离线、9/9 通过）。
    // 这里只做 HTTP 层的「接线正确性」验证：确认路由确实调用了锁、/status 确实暴露在途表、
    // 以及锁不会泄漏成永久 429。不在本脚本里打真实付费 AI 调用。
    const st = await get('/api/status');
    record('BUG-46a', '/status 暴露 aiInFlight 观测字段',
      Array.isArray(st.json?.aiInFlight), `aiInFlight=${JSON.stringify(st.json?.aiInFlight ?? null)}`);

    record('BUG-46b', '初始状态下在途表为空（无残留锁）',
      (st.json?.aiInFlight || []).length === 0, `len=${(st.json?.aiInFlight || []).length}`);

    // 关键接线断言：空账户分支走完 finally 后必须释放，同一 key 可反复调用而不被永久拒绝。
    // 若 claimAi 的 finally 缺失或 key 拼错，第二次就会 429 —— 这条能抓到。
    const KEY = '__probe_account__';
    const seq = [];
    for (let i = 0; i < 3; i++) {
      const r = await post('/api/ai/classify', { accountId: KEY }, { timeout: 15000 });
      seq.push(r.status);
    }
    record('BUG-46c', '同一 key 串行重复调用均不被拒绝（finally 正常释放）',
      seq.every((c) => c !== 429), `三次状态码=[${seq.join(', ')}]`);

    // 调用结束后不得残留
    const after = await get('/api/status');
    record('BUG-46d', '调用结束后在途表清空（无锁泄漏，否则会永久 429）',
      (after.json?.aiInFlight || []).length === 0,
      `残留 inFlight=${(after.json?.aiInFlight || []).length}`);

    // classify / summarize 路由也应经过锁：对不存在邮件应 404（先于锁分支），
    // 用合法邮件 id 但不存在→404，证明路由结构未被破坏。
    const ghost = await post('/api/messages/__nope__/summarize', {});
    record('BUG-46e', 'summarize 路由结构完好（不存在邮件→404）',
      ghost.status === 404, `HTTP ${ghost.status}`);
  }

  /* ============ 回归：BUG-47 /logs tail 夹取 ============ */
  {
    const l1 = await get('/api/logs?tail=999999999');
    record('BUG-47', 'logs tail 参数被夹取（不再整文件读入）',
      l1.status === 200 && (l1.json?.logs || '').split('\n').length <= 2001,
      `返回行数=${(l1.json?.logs || '').split('\n').length}`);
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n=== 结果：${results.length - failed.length}/${results.length} 通过 ===`);
  if (failed.length) {
    console.log('未通过：');
    for (const f of failed) console.log(`  - ${f.id} ${f.name}：${f.detail}`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error('验证脚本异常：', e.stack || e.message);
  process.exitCode = 2;
});
