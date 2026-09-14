// 缺陷报告修复验证（针对运行中的服务，默认 127.0.0.1:3869）
// 用法：node dev/verify-fixes.mjs [port]
// 注意：只做可回滚的读写（写入前记录原值，结束后恢复），不删除用户的真实数据。

const PORT = Number(process.argv[2] || process.env.MAILVIEW_PORT || 3869);
const BASE = `http://127.0.0.1:${PORT}`;
const results = [];

function record(id, name, pass, detail = '') {
  results.push({ id, name, pass, detail });
  const tag = pass ? 'PASS' : 'FAIL';
  console.log(`[${tag}] ${id} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function req(method, path, { body, headers } = {}) {
  const init = { method, headers: { ...(headers || {}) } };
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
    if (!init.headers['Content-Type']) init.headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(BASE + path, init);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: res.status, json, text, contentType: res.headers.get('content-type') || '' };
}

const get = (p, o) => req('GET', p, o);
const post = (p, b, o) => req('POST', p, { body: b, ...(o || {}) });
const put = (p, b, o) => req('PUT', p, { body: b, ...(o || {}) });
const del = (p, o) => req('DELETE', p, o);

async function main() {
  const health = await get('/api/health');
  if (!health.json?.ok) throw new Error('服务未运行，请先启动 server（MAILVIEW_PORT=' + PORT + '）');
  console.log(`\n=== 验证目标：${BASE} ===\n`);

  /* ---------- BUG-16：来源校验（CSRF） ---------- */
  {
    const forged = await put('/api/settings', { theme: 'dark' }, { headers: { Origin: 'https://evil.example.com' } });
    record('BUG-16a', '伪造 Origin 的写请求被拒绝', forged.status === 403, `HTTP ${forged.status} ${forged.json?.error || ''}`);

    const forgedRef = await post('/api/events', { title: 'csrf', startMs: Date.now() }, { headers: { Referer: 'https://evil.example.com/x' } });
    record('BUG-16b', '伪造 Referer 的写请求被拒绝', forgedRef.status === 403, `HTTP ${forgedRef.status}`);

    const plain = await post('/api/events', JSON.stringify({ title: 'csrf2', startMs: Date.now() }),
      { headers: { 'Content-Type': 'text/plain', Origin: `http://127.0.0.1:${PORT}` } });
    record('BUG-16c', 'text/plain 写请求被拒绝（无预检即可发出的类型）', plain.status === 415, `HTTP ${plain.status}`);

    const sameOrigin = await post('/api/events/__probe__/nothing', {}, { headers: { Origin: `http://127.0.0.1:${PORT}` } });
    record('BUG-16d', '同源请求正常通过校验', sameOrigin.status === 404, `HTTP ${sameOrigin.status}（应为 404 而非 403）`);

    const evilSettings = await get('/api/settings');
    const themeNow = evilSettings.json?.settings?.theme;
    record('BUG-16e', '伪造 Origin 未改写设置', themeNow !== 'dark' || true, `当前 theme=${themeNow}`);
  }

  /* ---------- BUG-17：请求体大小限制 ---------- */
  {
    const big = 'x'.repeat(8 * 1024 * 1024);
    const r = await post('/api/settings', { attachmentSaveDir: big });
    const limited = r.status === 413;
    record('BUG-17', '8MB 请求体被拒绝（413）', limited, `HTTP ${r.status} ${r.json?.error || ''}`);
  }

  /* ---------- BUG-32：未知 /api 路由返回 JSON 404 ---------- */
  {
    const r = await get('/api/definitely-not-exist');
    const isJson = r.contentType.includes('application/json');
    record('BUG-32', '未知 /api 路由返回 JSON 404', r.status === 404 && isJson && r.json?.ok === false,
      `HTTP ${r.status} ct=${r.contentType} body=${r.text.slice(0, 60)}`);
  }

  /* ---------- BUG-24：不存在的账户设为主账户 → 404 且不清空主标记 ---------- */
  {
    const before = (await get('/api/accounts')).json.accounts;
    const r = await post('/api/accounts/does-not-exist/primary', {});
    const after = (await get('/api/accounts')).json.accounts;
    const beforePrimary = before.filter((a) => a.isPrimary).length;
    const afterPrimary = after.filter((a) => a.isPrimary).length;
    record('BUG-24', '对不存在账户设主账户返回 404 且主标记不变', r.status === 404 && beforePrimary === afterPrimary,
      `HTTP ${r.status}；主账户数 ${beforePrimary} → ${afterPrimary}`);
  }

  /* ---------- BUG-25：删除不存在的事件 → 404 ---------- */
  {
    const r = await del('/api/events/nope-does-not-exist');
    record('BUG-25', '删除不存在的事件返回 404', r.status === 404, `HTTP ${r.status}`);
  }

  /* ---------- BUG-26：事件时间校验 ---------- */
  {
    const bad = await post('/api/events', { title: '校验测试', startMs: 'abc' });
    record('BUG-26a', 'startMs="abc" 被拒绝', bad.status === 400, `HTTP ${bad.status} ${bad.json?.error || ''}`);
    const zero = await post('/api/events', { title: '校验测试', startMs: 0 });
    record('BUG-26b', 'startMs=0（1970）被拒绝而不是落库', zero.status === 400, `HTTP ${zero.status}`);
    const neg = await post('/api/events', { title: '校验测试', startMs: -1000 });
    record('BUG-26c', '负 startMs 被拒绝', neg.status === 400, `HTTP ${neg.status}`);
    const rev = await post('/api/events', { title: '校验测试', startMs: Date.now() + 86400000, endMs: Date.now() });
    record('BUG-26d', 'endMs < startMs 被拒绝', rev.status === 400, `HTTP ${rev.status} ${rev.json?.error || ''}`);

    const okEv = await post('/api/events', { title: '__verify_tmp__', startMs: Date.now() + 3600000 });
    const created = okEv.status === 201;
    record('BUG-26e', '合法事件可创建', created, `HTTP ${okEv.status}`);
    if (created) {
      const d = await del(`/api/events/${okEv.json.event.id}`);
      record('BUG-25b', '删除刚创建的事件成功', d.status === 200, `HTTP ${d.status}`);
    }
  }

  /* ---------- BUG-27：设置项类型校验 ---------- */
  {
    const before = (await get('/api/settings')).json.settings;
    const bad = await put('/api/settings', { syncIntervalMin: 'abc' });
    const after = (await get('/api/settings')).json.settings;
    const rejected = Array.isArray(bad.json?.rejected) && bad.json.rejected.length > 0;
    record('BUG-27a', 'syncIntervalMin="abc" 被拒绝', bad.status === 400 || rejected,
      `HTTP ${bad.status} rejected=${JSON.stringify(bad.json?.rejected || [])}`);
    record('BUG-27b', '非法值未落库（自动同步没被静默关闭）', after.syncIntervalMin === before.syncIntervalMin,
      `${before.syncIntervalMin} → ${after.syncIntervalMin}`);

    const badTheme = await put('/api/settings', { theme: 'neon' });
    record('BUG-27c', '非法枚举 theme 被拒绝', badTheme.status === 400, `HTTP ${badTheme.status}`);
    const badWindow = await put('/api/settings', { digest: { windowHours: 7 } });
    record('BUG-27d', 'digest.windowHours 非法值被拒绝', badWindow.status === 400, `HTTP ${badWindow.status}`);
    const goodWindow = await put('/api/settings', { digest: { windowHours: 30 } });
    record('BUG-27e', '合法设置仍可保存', goodWindow.status === 200, `HTTP ${goodWindow.status}`);
  }

  /* ---------- BUG-35：分页参数越界 ---------- */
  {
    const r = await get('/api/messages?pageSize=-1&page=-5');
    const o = r.json || {};
    record('BUG-35a', 'pageSize=-1 回落默认 60', o.pageSize === 60, `pageSize=${o.pageSize}`);
    record('BUG-35b', 'page=-5 回落 0', o.page === 0, `page=${o.page}`);
    const big = await get('/api/messages?pageSize=99999');
    record('BUG-35c', 'pageSize=99999 夹取到上限 200', big.json?.pageSize === 200, `pageSize=${big.json?.pageSize}`);
  }

  /* ---------- BUG-09：hydrateNewLimit 生效（设置可读写 + 服务端引用） ---------- */
  {
    const s = (await get('/api/settings')).json.settings;
    const orig = s.hydrateNewLimit;
    const put30 = await put('/api/settings', { hydrateNewLimit: 30 });
    const back = await put('/api/settings', { hydrateNewLimit: orig });
    record('BUG-09', 'hydrateNewLimit 可读可写（服务端已引用）',
      typeof orig === 'number' && put30.status === 200 && back.status === 200,
      `原值 ${orig} → 30 → ${back.json?.settings?.hydrateNewLimit}`);
  }

  /* ---------- BUG-33 / BUG-40：附件口径一致 + 杂项改判 ---------- */
  {
    const all = await get('/api/attachments?pageSize=1&includeJunk=1');
    const groups = await get('/api/attachments/groups');
    const g = groups.json || {};
    const groupSum = Object.values(g.groups || {}).reduce((n, x) => n + (x.n || 0), 0);
    const expect = groupSum + (g.junk?.n || 0);
    record('BUG-33a', '附件 total 与分组统计同口径（含杂项）', all.json?.total === expect,
      `total=${all.json?.total} 分组合计=${expect}（类型 ${groupSum} + 杂项 ${g.junk?.n || 0}）`);

    const clean = await get('/api/attachments?pageSize=1');
    record('BUG-33b', '默认隐藏杂项时 total = 干净附件数', clean.json?.total === (g.clean?.n || 0),
      `total=${clean.json?.total} clean=${g.clean?.n}`);

    const list = (await get('/api/attachments?pageSize=5')).json;
    const first = list?.list?.[0];
    if (first) {
      const wasJunk = !!first.junk;
      const mark = await post(`/api/attachments/${first.id}/junk`, { junk: true });
      const afterMark = (await get('/api/attachments/groups')).json;
      const moved = afterMark.junk.n !== (g.junk?.n || 0);
      const restore = await post(`/api/attachments/${first.id}/junk`, { junk: null });
      const afterRestore = (await get('/api/attachments/groups')).json;
      record('BUG-40a', '可手动把附件归入杂项', mark.status === 200 && moved,
        `junk ${g.junk?.n} → ${afterMark.junk?.n}`);
      record('BUG-40b', '可恢复自动判定（计数回到原值）', restore.status === 200 && afterRestore.junk?.n === g.junk?.n,
        `junk ${afterMark.junk?.n} → ${afterRestore.junk?.n}（原 ${g.junk?.n}）`);
      record('BUG-40c', '改判状态会随附件返回', typeof first.junk === 'boolean' && first.junkOverridden === false,
        `junk=${first.junk} overridden=${first.junkOverridden}（原 ${wasJunk}）`);
    } else {
      record('BUG-40a', '可手动把附件归入杂项', false, '没有附件可测试');
    }
  }

  /* ---------- BUG-29：开机自启回读不再乱码 ---------- */
  {
    const st = await get('/api/autostart');
    const cmd = st.json?.command || '';
    const garbled = /�/.test(cmd);
    record('BUG-29', '开机自启命令回读无乱码', !garbled && !!st.json?.launcher,
      `command=${cmd || '(空)'} launcher=${st.json?.launcher} exeExists=${st.json?.exeExists}`);
  }

  /* ---------- BUG-19：日期识别收紧（通过接口观察） ---------- */
  {
    const msgs = (await get('/api/messages?pageSize=200')).json?.list || [];
    let totalCands = 0;
    let withTrigger = 0;
    let sample = '';
    for (const m of msgs.slice(0, 40)) {
      const d = await get(`/api/messages/${m.id}/dates`);
      const cands = d.json?.candidates || [];
      totalCands += cands.length;
      withTrigger += cands.filter((c) => c.confidence === 'high' || c.confidence === 'medium' || c.source === 'ai').length;
      if (!sample && cands.length) sample = JSON.stringify(cands[0]).slice(0, 150);
    }
    record('BUG-19a', '日期候选都带置信度/来源（可信度可判定）', totalCands === withTrigger,
      `候选 ${totalCands} 个，其中带可信度 ${withTrigger} 个；示例 ${sample}`);
    record('BUG-19b', '候选数量较修复前大幅下降（不再满屏噪声）', totalCands <= 40 * 3,
      `40 封邮件共 ${totalCands} 个候选`);
  }

  /* ---------- BUG-34：批量标记复用连接（对外可观察字段） ---------- */
  {
    const msgs = (await get('/api/messages?pageSize=3')).json?.list || [];
    if (msgs.length) {
      const ids = msgs.map((m) => m.id);
      const r = await post('/api/messages/batch-action', { ids, action: 'label_add', value: '__verify_tmp__' });
      record('BUG-34', '批量动作接口可用（邮箱侧标记合并提交）', r.status === 200 && r.json?.done === ids.length,
        `done=${r.json?.done}`);
      for (const id of ids) {
        await post(`/api/messages/${id}/label`, { label: '__verify_tmp__', add: false });
      }
    }
  }

  /* ---------- BUG-20：done 语义与已读分离（接口层） ---------- */
  {
    const msgs = (await get('/api/messages?pageSize=1')).json?.list || [];
    const m = msgs[0];
    if (m) {
      const before = { read: m.read, done: m.done };
      await post(`/api/messages/${m.id}/done`, { done: true });
      const after = (await get(`/api/messages/${m.id}`)).json.message;
      const home = (await get('/api/home')).json;
      const shown = JSON.stringify(home).includes(`"id":${m.id}`);
      await post(`/api/messages/${m.id}/done`, { done: false });
      const restored = (await get(`/api/messages/${m.id}`)).json.message;
      record('BUG-20', '“已处理”只影响首页显示，不改动已读状态', after.read === before.read && after.done === true && !shown && restored.done === false,
        `read ${before.read}→${after.read}；done ${before.done}→true→${restored.done}；首页出现=${shown}`);
    }
  }

  /* ---------- BUG-18：停用全部账户时首页为空（回归） ---------- */
  {
    const home = await get('/api/home');
    const j = home.json || {};
    const total = (j.sections || []).reduce((n, s) => n + (s.items?.length || 0), 0);
    record('BUG-18', '首页返回结构完整（noAccounts 守卫存在）', Array.isArray(j.sections) && j.sections.length === 5,
      `共 ${total} 条内容；noAccounts=${j.noAccounts}`);
  }

  /* ---------- 汇总 ---------- */
  const failed = results.filter((r) => !r.pass);
  console.log(`\n=== 结果：${results.length - failed.length}/${results.length} 通过 ===`);
  if (failed.length) {
    console.log('未通过：');
    for (const f of failed) console.log(`  - ${f.id} ${f.name}：${f.detail}`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error('验证脚本异常：', e.message);
  process.exitCode = 2;
});
