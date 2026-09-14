// 快速探针：查看当前账户 / 首页 / 列表状态
const b = `http://127.0.0.1:${process.argv[2] || 3869}`;
const get = async (p) => (await fetch(b + p)).json();

const st = await get('/api/status');
console.log('accounts:', st.accounts.map((a) => ({ id: a.id, name: a.name, enabled: a.enabled, kind: a.kind, folders: (a.folders || []).length, unread: a.unreadTotal })));
const ids = st.accounts.map((a) => a.id).join(',');
const h = await get('/api/home');
console.log('home:', h.sections.map((s) => `${s.key}:${s.items.length}`).join(' '), 'noAccounts=', h.noAccounts);
const m = await get('/api/messages?pageSize=3');
console.log('all messages total:', m.total, m.list.map((x) => x.subject));
const u = await get(`/api/messages?unified=1&folder=INBOX&pageSize=5&accountIds=${ids}`);
console.log('unified total:', u.total, u.list.map((x) => x.folder));
const d = await get('/api/home/done');
console.log('home/done total:', d.total);
