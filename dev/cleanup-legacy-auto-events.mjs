// 一次性清理：删除由旧版日期识别生成的“噪声日历事件”
// 判定原则：只有 source=auto 且来源邮件当前已不存在对应的高置信/AI 时间点时才删除。
// 用法：node dev/cleanup-legacy-auto-events.mjs [port] [--apply]
const b = `http://127.0.0.1:${process.argv[2] || 3869}`;
const APPLY = process.argv.includes('--apply');
const get = async (p) => (await fetch(b + p)).json();

const ev = await get('/api/events?start=0&end=' + (Date.now() + 400 * 86400000));
const auto = ev.events.filter((e) => e.source === 'auto');

const msgCache = new Map();
const trusted = async (id) => {
  if (msgCache.has(id)) return msgCache.get(id);
  const r = await get(`/api/messages/${id}`).catch(() => null);
  const list = (r?.message?.dates || []).filter((d) => d && d.ms && (d.source === 'ai' || d.confidence === 'high'));
  msgCache.set(id, list);
  return list;
};

const doomed = [];
const kept = [];        // { ev, fix } —— fix 为更准确的标题（旧版把噪声片段当成了标题）
for (const e of auto) {
  if (!e.messageId) { doomed.push(e); continue; }
  const list = await trusted(e.messageId);
  const bucket = Math.round(e.startMs / 3600000);
  const hit = list.find((d) => Math.abs(Math.round(d.ms / 3600000) - bucket) <= 1);
  if (hit) kept.push({ ev: e, fix: String(hit.title || '').slice(0, 40) });
  else doomed.push(e);
}

console.log(`auto 事件 ${auto.length} 个：保留 ${kept.length}，待清理 ${doomed.length}${APPLY ? '' : '（预演，未删除）'}`);
for (const e of doomed) console.log('  删除：', new Date(e.startMs).toLocaleString('zh-CN'), JSON.stringify(String(e.title).slice(0, 40)));
for (const k of kept) {
  const same = !k.fix || k.fix === k.ev.title;
  console.log(`  ${same ? '保留' : '修正标题'}：`, new Date(k.ev.startMs).toLocaleString('zh-CN'), JSON.stringify(String(k.ev.title).slice(0, 40)), same ? '' : `→ ${JSON.stringify(k.fix)}`);
}

if (APPLY) {
  let del = 0; let fix = 0;
  for (const e of doomed) {
    const r = await fetch(`${b}/api/events/${e.id}`, { method: 'DELETE' });
    if (r.ok) del++;
  }
  // 时间点对得上、但标题是旧版噪声片段的，按识别到的真实语境改写标题
  for (const k of kept) {
    if (!k.fix || k.fix === k.ev.title) continue;
    const r = await fetch(`${b}/api/events/${k.ev.id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: k.fix }),
    });
    if (r.ok) fix++;
  }
  console.log(`已删除 ${del} 个噪声事件，修正 ${fix} 个事件标题`);
}
