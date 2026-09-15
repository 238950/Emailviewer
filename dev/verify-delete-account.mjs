// 隔离验证：删除账户是否清理派生日历事件与落盘附件文件
// 用法：node dev/verify-delete-account.mjs <被测端口> <被测数据目录>
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const PORT = Number(process.argv[2] || 4387);
const DATA_DIR = process.argv[3];
if (!DATA_DIR) { console.error('缺少数据目录参数'); process.exit(2); }
const BASE = `http://127.0.0.1:${PORT}`;
const ACCOUNT_ID = 'verify-account-1';
const MSG_ID = 900001;

const dbPath = path.join(DATA_DIR, 'mailview.db');
const attachDir = path.join(DATA_DIR, 'attachments');

const db = new DatabaseSync(dbPath);
const run = (sql, ...p) => db.prepare(sql).run(...p);
const q1 = (sql, ...p) => db.prepare(sql).get(...p);

// 造数据：账户 + 邮件 + 附件 + 事件，并真实落一个附件文件
run('DELETE FROM event WHERE message_id = ?', MSG_ID);
run('DELETE FROM attachment WHERE message_id = ?', MSG_ID);
run('DELETE FROM message WHERE id = ?', MSG_ID);
run('DELETE FROM account WHERE id = ?', ACCOUNT_ID);
run(`INSERT INTO account (id, kind, name, email, username, host, port, ssl, auth, password_enc, is_primary, color, sort, enabled, created_at, extra)
     VALUES (?, 'imap', '验证账户', 'verify@example.com', 'verify@example.com', 'imap.example.com', 993, 1, 'password', '', 0, '#123456', 0, 1, ?, '{}')`,
  ACCOUNT_ID, Date.now());
run(`INSERT INTO message (account_id, folder, uid, msg_id, subject, from_addr, from_name, to_list, cc_list, date_ms, received_ms, size, flags, read, important, has_attachments, att_json, snippet, body_fetched, category, created_at)
     VALUES (?, 'INBOX', 4242, '<verify@example.com>', '验证用邮件', 'a@b.c', 'A', '[]', '[]', ?, ?, 100, '[]', 0, 0, 1, '[]', '', 1, 'other', ?)`,
  ACCOUNT_ID, Date.now(), Date.now(), Date.now());
const msgRow = q1('SELECT id FROM message WHERE account_id = ? ORDER BY id DESC LIMIT 1', ACCOUNT_ID);
const mid = msgRow.id;
const storedName = 'verify_attach.bin';
fs.mkdirSync(attachDir, { recursive: true });
fs.writeFileSync(path.join(attachDir, storedName), Buffer.alloc(2048, 7));
run(`INSERT INTO attachment (message_id, account_id, filename, mime, size, content_id, disposition, part, stored, hash, created_at, junk)
     VALUES (?, ?, 'verify.bin', 'application/octet-stream', 2048, '', 'attachment', '', ?, 'verifyhash', ?, 0)`,
  mid, ACCOUNT_ID, storedName, Date.now());
run(`INSERT INTO event (id, title, start_ms, end_ms, all_day, source, message_id, note, color, remind_offsets, created_at)
     VALUES ('verify-event-1', '验证事件', ?, ?, 0, 'auto', ?, '', '#10b981', '[]', ?)`,
  Date.now() + 3600000, Date.now() + 7200000, mid, Date.now());

const before = {
  messages: q1('SELECT COUNT(*) AS c FROM message WHERE account_id = ?', ACCOUNT_ID).c,
  attachments: q1('SELECT COUNT(*) AS c FROM attachment WHERE account_id = ?', ACCOUNT_ID).c,
  events: q1('SELECT COUNT(*) AS c FROM event WHERE message_id = ?', mid).c,
  fileExists: fs.existsSync(path.join(attachDir, storedName)),
};
console.log('删除前：', before);

const res = await fetch(`${BASE}/api/accounts/${ACCOUNT_ID}`, { method: 'DELETE' });
const body = await res.json().catch(() => null);

const after = {
  messages: q1('SELECT COUNT(*) AS c FROM message WHERE account_id = ?', ACCOUNT_ID).c,
  attachments: q1('SELECT COUNT(*) AS c FROM attachment WHERE account_id = ?', ACCOUNT_ID).c,
  events: q1('SELECT COUNT(*) AS c FROM event WHERE message_id = ?', mid).c,
  fileExists: fs.existsSync(path.join(attachDir, storedName)),
  account: q1('SELECT COUNT(*) AS c FROM account WHERE id = ?', ACCOUNT_ID).c,
};
console.log('删除后：', after);
console.log('接口返回：', JSON.stringify(body));

const checks = [
  ['接口 200', res.status === 200],
  ['账户行已删除', after.account === 0],
  ['邮件行已删除', after.messages === 0],
  ['附件行已删除', after.attachments === 0],
  ['日历事件已删除（无悬空引用）', after.events === 0],
  ['磁盘附件文件已删除', !after.fileExists],
  ['返回释放统计', !!body?.report && body.report.files === 1 && body.report.events === 1],
];
let fail = 0;
for (const [name, pass] of checks) {
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}`);
  if (!pass) fail++;
}
console.log(fail ? `\n${fail} 项未通过` : '\n全部通过');
db.close();
process.exitCode = fail ? 1 : 0;
