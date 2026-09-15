// 检查日历事件 / 提醒 / 通知中心的遗留噪声（来自旧版日期识别）
const b = `http://127.0.0.1:${process.argv[2] || 3869}`;
const get = async (p) => (await fetch(b + p)).json();

const ev = await get('/api/events?start=0&end=' + (Date.now() + 400 * 86400000));
console.log(`事件总数 ${ev.events.length}`);
for (const e of ev.events) {
  console.log(`- [${e.source}] ${new Date(e.startMs).toLocaleString('zh-CN')} | ${JSON.stringify(String(e.title).slice(0, 40))} | msg=${e.messageId}`);
}
const st = await get('/api/status');
console.log('通知条数:', (st.notifications || []).length);
for (const n of (st.notifications || []).slice(0, 10)) console.log('  *', JSON.stringify(String(n.text || n.title || '').slice(0, 80)), 'at', new Date(n.at || 0).toLocaleString('zh-CN'));
const rem = await get('/api/reminders');
console.log('提醒条数:', (rem.reminders || []).length, JSON.stringify((rem.reminders || []).slice(0, 5)));
