// BUG-42 回归验证：附件库「MIME 大类筛选」下推 SQL 后，结果必须与旧的 JS 过滤完全等价。
// 做法：对真实数据库，用 SQL 下推路径 vs 全量取回内存过滤，逐分组对比 total 与 id 集合。
// 用法：node dev/verify-attach-pushdown.mjs
import { AttachmentStore } from '../server/src/store.js';

const GROUPS = ['document', 'table', 'slide', 'pdf', 'image', 'archive', 'calendar', 'text', 'other'];

function idsOf(opts) {
  // 用足够大的 pageSize 拿全量，便于比对集合（上限 200 是接口层约束，store 内部同规则）
  const all = [];
  let page = 0;
  for (;;) {
    const r = AttachmentStore.list({ ...opts, page, pageSize: 200 });
    all.push(...r.list.map((a) => a.id));
    if (all.length >= r.total || r.list.length === 0) break;
    page++;
  }
  return all.sort((a, b) => a - b);
}

/** 参考实现：不加分组条件全量取回，在内存里按 rowToAtt 的 group 过滤 */
function refIdsFor(groups, opts) {
  const rows = [];
  let page = 0;
  for (;;) {
    const r = AttachmentStore.list({ ...opts, mimeGroups: [], page, pageSize: 200 });
    rows.push(...r.list);
    if (rows.length >= r.total || r.list.length === 0) break;
    page++;
  }
  // 注意：mimeGroups:[] 会走「默认排除杂项」分支，与带分组的查询保持同样基准
  return rows.filter((a) => groups.includes(a.group)).map((a) => a.id).sort((a, b) => a - b);
}

let pass = 0; let fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`[PASS] ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`[FAIL] ${name}${detail ? ` — ${detail}` : ''}`); }
};

const total = AttachmentStore.list({ pageSize: 1 }).total;
console.log(`附件总数（默认口径）：${total}\n`);

for (const g of GROUPS) {
  const got = idsOf({ mimeGroups: [g] });
  const want = refIdsFor([g]);
  const same = got.length === want.length && got.every((v, i) => v === want[i]);
  check(`单组筛选等价：${g}`, same, `下推=${got.length} 内存=${want.length}`);
}

// 多组并列
{
  const sel = ['document', 'pdf', 'image'];
  const got = idsOf({ mimeGroups: sel });
  const want = refIdsFor(sel);
  const same = got.length === want.length && got.every((v, i) => v === want[i]);
  check('多组并列等价：document+pdf+image', same, `下推=${got.length} 内存=${want.length}`);
}

// 与搜索/大小/账户等其它条件组合
{
  const opts = { mimeGroups: ['image'], minSize: 1000 };
  const got = idsOf(opts);
  const want = refIdsFor(['image'], { minSize: 1000 });
  const same = got.length === want.length && got.every((v, i) => v === want[i]);
  check('组合条件等价：image + minSize>=1000', same, `下推=${got.length} 内存=${want.length}`);
}

// 分组统计口径 vs 下推筛选口径（BUG-33 的一致性同样适用于下推后）
{
  const stats = AttachmentStore.stats({});
  let allOk = true; const detail = [];
  for (const g of Object.keys(stats.groups)) {
    const pushed = AttachmentStore.list({ mimeGroups: [g], pageSize: 1 }).total;
    const statN = stats.groups[g].n;
    if (pushed !== statN) { allOk = false; detail.push(`${g}: 筛选${pushed}≠统计${statN}`); }
  }
  check('下推筛选与分组统计同口径', allOk, allOk ? `校验 ${Object.keys(stats.groups).length} 个分组` : detail.join('; '));
}

// 排序下推正确性：按大小升/降序应与内存排序一致
{
  const asc = AttachmentStore.list({ sort: 'size', dir: 'asc', pageSize: 200 }).list.map((a) => a.size || 0);
  const sortOk = asc.every((v, i) => i === 0 || asc[i - 1] <= v);
  check('排序下推：size 升序单调不减', sortOk, `共 ${asc.length} 条`);

  const desc = AttachmentStore.list({ sort: 'size', dir: 'desc', pageSize: 200 }).list.map((a) => a.size || 0);
  const sortOk2 = desc.every((v, i) => i === 0 || desc[i - 1] >= v);
  check('排序下推：size 降序单调不增', sortOk2, `共 ${desc.length} 条`);
}

// 分页不重不漏
{
  const limit = 20;
  const p0 = AttachmentStore.list({ page: 0, pageSize: limit });
  const p1 = AttachmentStore.list({ page: 1, pageSize: limit });
  const overlap = new Set(p0.list.map((a) => a.id));
  const dup = p1.list.filter((a) => overlap.has(a.id)).length;
  check('分页无重叠', dup === 0, `第0页 ${p0.list.length} 条 / 第1页 ${p1.list.length} 条，重叠 ${dup}`);
  check('分页 total 稳定', p0.total === p1.total, `p0.total=${p0.total} p1.total=${p1.total}`);
}

console.log(`\n=== 结果：${pass}/${pass + fail} 通过 ===`);
process.exit(fail === 0 ? 0 : 1);
