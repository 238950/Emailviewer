// 开发校验：附件去重缓存（同一内容只落盘一份）
// 用法（需先停止服务）：node dev/verify-dedupe.mjs
import fs from 'node:fs';
import path from 'node:path';
import { q, run, MessageStore, AttachmentStore } from '../server/src/store.js';
import { hydrateByUid } from '../server/src/hydrate.js';
import { sweepOrphanFiles } from '../server/src/services.js';
import { ATTACH_DIR } from '../server/src/logger.js';

const dirStats = () => {
  let files = 0; let bytes = 0;
  for (const fn of fs.readdirSync(ATTACH_DIR)) {
    const p = path.join(ATTACH_DIR, fn);
    try { const st = fs.statSync(p); if (st.isFile()) { files++; bytes += st.size; } } catch { /* */ }
  }
  return { files, bytes };
};

const row = q("SELECT message_id, COUNT(*) c, SUM(size) s FROM attachment WHERE stored != '' GROUP BY message_id ORDER BY c DESC LIMIT 1")[0];
if (!row) { console.log('没有已落盘附件的邮件，跳过'); process.exit(0); }
const msg = MessageStore.get(row.message_id);
console.log(`样本邮件 id=${msg.id} 附件数=${row.c} 账号=${msg.accountId.slice(0, 8)}…`);

const before = dirStats();
const beforeRows = AttachmentStore.byMessage(msg.id).length;

// 模拟“重复同步”：清空该邮件的正文与附件记录，再次抓取两轮
for (let i = 1; i <= 2; i++) {
  run('UPDATE message SET body_fetched=0, body_text=NULL, body_html=NULL WHERE id=?', [msg.id]);
  AttachmentStore.deleteByMessage(msg.id);
  await hydrateByUid(msg.accountId, msg.folder, msg.uid);
  const mid = dirStats();
  const rows = AttachmentStore.byMessage(msg.id);
  console.log(`第 ${i} 轮抓取后：文件数=${mid.files} 占用=${(mid.bytes / 1048576).toFixed(2)}MB 附件行=${rows.length} 引用文件=${new Set(rows.map(r => r.stored).filter(Boolean)).size}`);
}

const afterHydrate = dirStats();
const orphansRemoved = sweepOrphanFiles();
const afterSweep = dirStats();
const rowsNow = AttachmentStore.byMessage(msg.id);

console.log('--- 结果 ---');
console.log(`初始：文件=${before.files} 占用=${(before.bytes / 1048576).toFixed(2)}MB 附件行=${beforeRows}`);
console.log(`两次重抓后：文件=${afterHydrate.files} 占用=${(afterHydrate.bytes / 1048576).toFixed(2)}MB`);
console.log(`孤儿清理：删除 ${orphansRemoved} 个 → 文件=${afterSweep.files} 占用=${(afterSweep.bytes / 1048576).toFixed(2)}MB`);
console.log(`当前该邮件附件行=${rowsNow.length}`);
const ok = afterSweep.files <= before.files + 1 && afterSweep.bytes <= before.bytes * 1.05;
console.log(ok ? '✅ 去重生效：重复抓取未造成缓存膨胀' : '❌ 去重异常：文件数/占用增长过多');
process.exit(ok ? 0 : 2);
