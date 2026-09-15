// 回归验证：启动回填的「批量取正文」必须与旧「逐封 detail()」结果完全一致。
// 用法：node dev/verify-backfill-batch.mjs
import { MessageStore } from '../server/src/store.js';

let pass = 0; let fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`[PASS] ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`[FAIL] ${name}${detail ? ` — ${detail}` : ''}`); }
};

const rows = MessageStore.query({ bodyFetched: true, pageSize: 200 }).list;
console.log(`已抓正文邮件：${rows.length} 封\n`);

// 1) 批量取正文 == 逐封 detail 取正文
const ids = rows.map((m) => m.id);
const t0 = Date.now();
const batch = MessageStore.bodiesByIds(ids);
const batchMs = Date.now() - t0;

const t1 = Date.now();
const single = new Map();
for (const id of ids) {
  const d = MessageStore.detail(id);
  if (d) single.set(d.id, { bodyText: d.bodyText || '', bodyHtml: d.bodyHtml || '' });
}
const singleMs = Date.now() - t1;

let same = true; const diffs = [];
for (const [id, v] of single) {
  const b = batch.get(id);
  if (!b) { same = false; diffs.push(`id=${id} 批量缺失`); continue; }
  if (b.bodyText !== v.bodyText || b.bodyHtml !== v.bodyHtml) { same = false; diffs.push(`id=${id} 正文不一致`); }
}
check('批量取正文与逐封结果一致', same, same ? `比对 ${single.size} 封` : diffs.slice(0, 3).join('; '));

console.log(`  逐封 detail：${singleMs}ms（${ids.length} 次查询）`);
console.log(`  批量取正文：${batchMs}ms（${Math.ceil(ids.length / 500)} 次查询）`);

// 2) 边界：空数组、不存在的 id、null
check('空数组返回空 Map', MessageStore.bodiesByIds([]).size === 0);
check('null 安全返回空 Map', MessageStore.bodiesByIds(null).size === 0);
check('不存在的 id 不报错', MessageStore.bodiesByIds([999999999]).size === 0);
check('混合有效/无效 id 只返回有效的', MessageStore.bodiesByIds([ids[0], 999999999]).size === 1);

// 3) 超大列表分片（>500）不报错
const big = [];
for (let i = 0; i < 1200; i++) big.push(ids[i % ids.length]);
const bigRes = MessageStore.bodiesByIds(big);
check('超过 500 条时分片查询正常', bigRes.size > 0, `返回 ${bigRes.size} 条`);

console.log(`\n=== 结果：${pass}/${pass + fail} 通过 ===`);
process.exit(fail === 0 ? 0 : 1);
