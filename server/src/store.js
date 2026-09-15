// SQLite 存储层（基于 Node 内置 node:sqlite）
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR, ATTACH_DIR, ensureDirs } from './logger.js';
import { safeJson, toJson, now, uid, isJunkAttachment, junkAttachmentReason, mimeGroup as mimeGroupName, MIME_GROUP } from './util.js';

ensureDirs();
const DB_FILE = path.join(DATA_DIR, 'mailview.db');

export const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA busy_timeout = 5000;');
db.exec('PRAGMA foreign_keys = ON;');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS account(
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'imap',
  name TEXT NOT NULL DEFAULT '',
  email TEXT DEFAULT '',
  username TEXT DEFAULT '',
  host TEXT DEFAULT '', port INTEGER DEFAULT 993, ssl INTEGER DEFAULT 1,
  auth TEXT DEFAULT 'password',
  password_enc TEXT DEFAULT '',
  is_primary INTEGER DEFAULT 0,
  color TEXT DEFAULT '#4f8cff',
  sort INTEGER DEFAULT 0,
  enabled INTEGER DEFAULT 1,
  created_at INTEGER DEFAULT 0,
  last_sync_at INTEGER DEFAULT 0,
  sync_state TEXT DEFAULT '',
  sync_error TEXT DEFAULT '',
  extra TEXT DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS folder(
  account_id TEXT NOT NULL,
  name TEXT NOT NULL,
  delim TEXT DEFAULT '/',
  flags TEXT DEFAULT '[]',
  subscribed INTEGER DEFAULT 1,
  uidvalidity TEXT DEFAULT '',
  highest_uid INTEGER DEFAULT 0,
  total INTEGER DEFAULT 0,
  unread INTEGER DEFAULT 0,
  synced_at INTEGER DEFAULT 0,
  PRIMARY KEY(account_id, name)
);
CREATE TABLE IF NOT EXISTS message(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  folder TEXT NOT NULL,
  uid INTEGER NOT NULL,
  msg_id TEXT DEFAULT '',
  subject TEXT DEFAULT '',
  from_addr TEXT DEFAULT '',
  from_name TEXT DEFAULT '',
  to_list TEXT DEFAULT '[]',
  cc_list TEXT DEFAULT '[]',
  date_ms INTEGER DEFAULT 0,
  received_ms INTEGER DEFAULT 0,
  size INTEGER DEFAULT 0,
  flags TEXT DEFAULT '[]',
  read INTEGER DEFAULT 0,
  important INTEGER DEFAULT 0,
  has_attachments INTEGER DEFAULT 0,
  att_json TEXT DEFAULT '[]',
  snippet TEXT DEFAULT '',
  body_text TEXT, body_html TEXT,
  body_fetched INTEGER DEFAULT 0,
  headers_json TEXT DEFAULT '{}',
  category TEXT DEFAULT 'other',
  category_reason TEXT DEFAULT '',
  category_model TEXT DEFAULT '',
  category_at INTEGER DEFAULT 0,
  ai_attempted INTEGER DEFAULT 0,
  ai_summary TEXT DEFAULT '',
  ai_summary_model TEXT DEFAULT '',
  ai_summary_at INTEGER DEFAULT 0,
  labels TEXT DEFAULT '[]',
  created_at INTEGER DEFAULT 0,
  UNIQUE(account_id, folder, uid)
);
CREATE INDEX IF NOT EXISTS idx_msg_acc ON message(account_id, folder);
CREATE INDEX IF NOT EXISTS idx_msg_date ON message(date_ms);
CREATE INDEX IF NOT EXISTS idx_msg_unread ON message(account_id, read);
CREATE TABLE IF NOT EXISTS attachment(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER NOT NULL,
  account_id TEXT DEFAULT '',
  filename TEXT DEFAULT '',
  mime TEXT DEFAULT '',
  size INTEGER DEFAULT 0,
  content_id TEXT DEFAULT '',
  disposition TEXT DEFAULT '',
  part TEXT DEFAULT '',
  stored TEXT DEFAULT '',
  hash TEXT DEFAULT '',
  created_at INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_att_msg ON attachment(message_id);
CREATE INDEX IF NOT EXISTS idx_att_mime ON attachment(account_id, mime);
CREATE TABLE IF NOT EXISTS rule(
  id TEXT PRIMARY KEY,
  name TEXT DEFAULT '',
  enabled INTEGER DEFAULT 1,
  priority INTEGER DEFAULT 0,
  match_json TEXT DEFAULT '[]',
  action_json TEXT DEFAULT '{}',
  created_at INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS event(
  id TEXT PRIMARY KEY,
  title TEXT DEFAULT '',
  start_ms INTEGER DEFAULT 0,
  end_ms INTEGER DEFAULT 0,
  all_day INTEGER DEFAULT 0,
  source TEXT DEFAULT 'manual',
  message_id INTEGER DEFAULT 0,
  note TEXT DEFAULT '',
  color TEXT DEFAULT '#e07b39',
  remind_offsets TEXT DEFAULT '[]',
  created_at INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS reminder(
  id TEXT PRIMARY KEY,
  event_id TEXT DEFAULT '',
  due_ms INTEGER DEFAULT 0,
  fired INTEGER DEFAULT 0,
  fired_at INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_rem_due ON reminder(due_ms);
CREATE TABLE IF NOT EXISTS setting(key TEXT PRIMARY KEY, value TEXT);
`;

db.exec(SCHEMA);
// 增量列（兼容已存在的旧库）
for (const ddl of [
  "ALTER TABLE message ADD COLUMN worth INTEGER DEFAULT 0",
  "ALTER TABLE message ADD COLUMN worth_reason TEXT DEFAULT ''",
  "ALTER TABLE message ADD COLUMN done INTEGER DEFAULT 0",
  "ALTER TABLE message ADD COLUMN done_at INTEGER DEFAULT 0",
  "ALTER TABLE message ADD COLUMN dates_json TEXT DEFAULT '[]'",
  "ALTER TABLE message ADD COLUMN dates_at INTEGER DEFAULT 0",
  // 区分「尚未提取日期」与「用户主动忽略」。
  "ALTER TABLE message ADD COLUMN dates_ignored INTEGER DEFAULT 0",
  "ALTER TABLE message ADD COLUMN hidden INTEGER DEFAULT 0",
  // 杂项判定落库，附件库的列表计数与分组统计才能用同一口径；
  // junk_override 记录用户“这条不是杂项 / 就是杂项”的手动改判（NULL = 用自动判定）
  "ALTER TABLE attachment ADD COLUMN junk INTEGER DEFAULT 0",
  "ALTER TABLE attachment ADD COLUMN junk_override INTEGER DEFAULT NULL",
]) {
  try { db.exec(ddl); } catch { /* 列已存在 */ }
}

/* ---------------- 语句缓存 ---------------- */
const cache = new Map();
export function q(sql, params = []) {
  let st = cache.get(sql);
  if (!st) { st = db.prepare(sql); cache.set(sql, st); }
  const rows = st.all(...params);
  return rows.map((r) => ({ ...r }));
}
export function q1(sql, params = []) {
  const rows = q(sql, params);
  return rows[0] || null;
}
export function run(sql, params = []) {
  let st = cache.get(sql);
  if (!st) { st = db.prepare(sql); cache.set(sql, st); }
  const info = st.run(...params);
  return { lastInsertRowid: Number(info.lastInsertRowid || 0), changes: Number(info.changes || 0) };
}
export function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}

/* ================= 账户 ================= */
export const AccountStore = {
  list() {
    return q('SELECT * FROM account ORDER BY sort, created_at').map(rowToAccount);
  },
  get(id) {
    const r = q1('SELECT * FROM account WHERE id = ?', [id]);
    return r ? rowToAccount(r) : null;
  },
  insert(a) {
    run(`INSERT INTO account (id, kind, name, email, username, host, port, ssl, auth, password_enc, is_primary, color, sort, enabled, created_at, extra)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [a.id, a.kind || 'imap', a.name || '', a.email || '', a.username || '', a.host || '', a.port || 993,
       a.ssl ? 1 : 0, a.auth || 'password', a.passwordEnc || '', a.isPrimary ? 1 : 0, a.color || '#4f8cff',
       a.sort ?? 0, a.enabled ? 1 : 1, now(), toJson(a.extra || {})]);
  },
  update(id, fields) {
    const sets = [];
    const vals = [];
    const int = (v, d = 0) => (v === undefined || v === null ? d : v ? 1 : 0);
    const num = (v, d = 0) => (v === undefined || v === null ? d : Number(v) || 0);
    const str = (v, d = '') => (v === undefined || v === null ? d : String(v));
    const m = {
      name: (v) => { sets.push('name = ?'); vals.push(str(v)); },
      email: (v) => { sets.push('email = ?'); vals.push(str(v)); },
      username: (v) => { sets.push('username = ?'); vals.push(str(v)); },
      host: (v) => { sets.push('host = ?'); vals.push(str(v)); },
      port: (v) => { sets.push('port = ?'); vals.push(num(v, 993)); },
      ssl: (v) => { sets.push('ssl = ?'); vals.push(int(v, 1)); },
      auth: (v) => { sets.push('auth = ?'); vals.push(str(v)); },
      passwordEnc: (v) => { sets.push('password_enc = ?'); vals.push(str(v)); },
      isPrimary: (v) => { sets.push('is_primary = ?'); vals.push(int(v, 0)); },
      color: (v) => { sets.push('color = ?'); vals.push(str(v)); },
      sort: (v) => { sets.push('sort = ?'); vals.push(num(v, 0)); },
      enabled: (v) => { sets.push('enabled = ?'); vals.push(int(v, 1)); },
      lastSyncAt: (v) => { sets.push('last_sync_at = ?'); vals.push(num(v, 0)); },
      syncState: (v) => { sets.push('sync_state = ?'); vals.push(v ? JSON.stringify(v) : ''); },
      syncError: (v) => { sets.push('sync_error = ?'); vals.push(str(v)); },
      extra: (v) => { sets.push('extra = ?'); vals.push(JSON.stringify(v ?? {})); },
    };
    for (const [k, v] of Object.entries(fields)) {
      if (m[k]) m[k](v);
    }
    if (!sets.length) return;
    vals.push(id);
    run(`UPDATE account SET ${sets.join(', ')} WHERE id = ?`, vals);
  },
  /**
   * 删除账户及其全部本地痕迹：
   * 文件夹 / 邮件 / 附件行 / 由该账户邮件派生的事件 / 落盘的附件缓存文件。
   * 返回删除统计，便于界面如实告知释放了多少空间。
   */
  remove(id) {
    const mids = q('SELECT id FROM message WHERE account_id = ?', [id]).map((r) => r.id);
    const files = q('SELECT stored, size FROM attachment WHERE account_id = ? AND stored <> \'\'', [id]);
    let events = 0;
    tx(() => {
      // 先清理由本账户邮件生成的事件，避免日历里留下悬空引用（点“打开来源邮件”会 404）
      if (mids.length) {
        const ph = mids.map(() => '?').join(',');
        const before = q(`SELECT COUNT(*) AS c FROM event WHERE message_id IN (${ph})`, mids)[0].c;
        run(`DELETE FROM reminder WHERE event_id IN (SELECT id FROM event WHERE message_id IN (${ph}))`, mids);
        run(`DELETE FROM event WHERE message_id IN (${ph})`, mids);
        events = before;
      }
      run('DELETE FROM folder WHERE account_id = ?', [id]);
      run('DELETE FROM attachment WHERE account_id = ?', [id]);
      run('DELETE FROM message WHERE account_id = ?', [id]);
      run('DELETE FROM account WHERE id = ?', [id]);
    });
    // 事务提交后再删磁盘文件（删文件不可回滚，放最后避免半途失败留下不一致）
    let bytesFreed = 0;
    let filesRemoved = 0;
    for (const f of files) {
      try {
        const abs = path.join(ATTACH_DIR, path.basename(String(f.stored)));
        if (fs.existsSync(abs)) fs.unlinkSync(abs);
        bytesFreed += Number(f.size) || 0;
        filesRemoved++;
      } catch { /* 单个文件失败不影响整体删除 */ }
    }
    return { messages: mids.length, attachments: files.length, files: filesRemoved, bytesFreed, events };
  },
};

function rowToAccount(r) {
  return {
    id: r.id, kind: r.kind, name: r.name, email: r.email, username: r.username,
    host: r.host, port: r.port, ssl: !!r.ssl, auth: r.auth,
    hasPassword: !!r.password_enc, isPrimary: !!r.is_primary, color: r.color,
    sort: r.sort, enabled: !!r.enabled, createdAt: r.created_at,
    lastSyncAt: r.last_sync_at, syncState: safeJson(r.sync_state, null), syncError: r.sync_error,
    extra: safeJson(r.extra, {}),
  };
}

/* ================= 文件夹 ================= */
export const FolderStore = {
  upsert(f) {
    run(`INSERT INTO folder (account_id, name, delim, flags, subscribed, uidvalidity, highest_uid, total, unread, synced_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(account_id, name) DO UPDATE SET
           flags=excluded.flags, uidvalidity=excluded.uidvalidity,
           highest_uid=excluded.highest_uid, total=excluded.total, unread=excluded.unread, synced_at=excluded.synced_at`,
      [f.accountId, f.name, f.delim || '/', toJson(f.flags || []), f.subscribed ? 1 : 0,
       f.uidvalidity || '', f.highestUid || 0, f.total || 0, f.unread || 0, f.syncedAt || now()]);
  },
  list(accountId) {
    return q('SELECT * FROM folder WHERE account_id = ? ORDER BY name', [accountId]).map((r) => ({
      accountId: r.account_id, name: r.name, delim: r.delim, flags: safeJson(r.flags, []),
      subscribed: !!r.subscribed, uidvalidity: r.uidvalidity, highestUid: r.highest_uid,
      total: r.total, unread: r.unread, syncedAt: r.synced_at,
    }));
  },
  get(accountId, name) {
    const r = q1('SELECT * FROM folder WHERE account_id = ? AND name = ?', [accountId, name]);
    return r ? {
      accountId: r.account_id, name: r.name, delim: r.delim, flags: safeJson(r.flags, []),
      subscribed: !!r.subscribed, uidvalidity: r.uidvalidity, highestUid: r.highest_uid,
      total: r.total, unread: r.unread, syncedAt: r.synced_at,
    } : null;
  },
  clear(accountId) {
    run('DELETE FROM folder WHERE account_id = ?', [accountId]);
  },
  bumpCounts(accountId, name, total, unread, highestUid, uidvalidity) {
    run(`UPDATE folder SET total=?, unread=?, highest_uid=?, uidvalidity=?, synced_at=? WHERE account_id=? AND name=?`,
      [total, unread, highestUid, uidvalidity, now(), accountId, name]);
  },
  setUnreadLocal(accountId, name, unread) {
    run('UPDATE folder SET unread=? WHERE account_id=? AND name=?', [unread, accountId, name]);
  },
  localCounts(accountId, name) {
    const r = q1('SELECT total, unread FROM folder WHERE account_id=? AND name=?', [accountId, name]);
    return r ? { total: r.total, unread: r.unread } : null;
  },
};

/* ================= 邮件 ================= */
const MSG_COLS = 'id, account_id, folder, uid, msg_id, subject, from_addr, from_name, to_list, cc_list, date_ms, received_ms, size, flags, read, important, has_attachments, att_json, snippet, body_fetched, category, category_reason, category_model, category_at, ai_attempted, worth, worth_reason, done, done_at, hidden, dates_json, dates_at, dates_ignored, ai_summary, ai_summary_model, ai_summary_at, labels, created_at';

function rowToMsg(r) {
  return {
    id: r.id, accountId: r.account_id, folder: r.folder, uid: r.uid, msgId: r.msg_id,
    subject: r.subject, fromAddr: r.from_addr, fromName: r.from_name,
    toList: safeJson(r.to_list, []), ccList: safeJson(r.cc_list, []),
    dateMs: r.date_ms || r.received_ms, receivedMs: r.received_ms, size: r.size,
    flags: safeJson(r.flags, []), read: !!r.read, important: !!r.important,
    hasAttachments: !!r.has_attachments, attMeta: safeJson(r.att_json, []),
    snippet: r.snippet || '', bodyFetched: !!r.body_fetched,
    category: r.category, categoryReason: r.category_reason, categoryModel: r.category_model,
    categoryAt: r.category_at, aiAttempted: !!r.ai_attempted, worth: r.worth || 0, worthReason: r.worth_reason || '', done: r.done === 1, doneAt: r.done_at || 0, hidden: r.hidden === 1, dates: safeJson(r.dates_json, []), datesAt: r.dates_at || 0, datesIgnored: r.dates_ignored === 1, aiSummary: r.ai_summary,
    aiSummaryModel: r.ai_summary_model, aiSummaryAt: r.ai_summary_at,
    labels: safeJson(r.labels, []), createdAt: r.created_at,
    accountName: r.account_name || '', accountColor: r.account_color || '',
    hasBody: r.body_fetched === 1,
  };
}

export const MessageStore = {
  byUid(accountId, folder, uid) {
    const r = q1(`SELECT ${MSG_COLS} FROM message WHERE account_id=? AND folder=? AND uid=?`, [accountId, folder, uid]);
    return r ? rowToMsg(r) : null;
  },
  byMsgId(accountId, msgId) {
    const r = q1(`SELECT ${MSG_COLS} FROM message WHERE account_id=? AND msg_id=?`, [accountId, msgId]);
    return r ? rowToMsg(r) : null;
  },
  get(id) {
    const r = q1(`SELECT ${MSG_COLS} FROM message WHERE id=?`, [id]);
    return r ? rowToMsg(r) : null;
  },
  /** 插入信封。若已存在返回 {inserted:false, id}，否则 {inserted:true, id} */
  insertEnvelope(m) {
    const exists = MessageStore.byUid(m.accountId, m.folder, m.uid);
    if (exists) return { inserted: false, id: exists.id, msg: exists };
    const info = run(
      `INSERT INTO message (account_id, folder, uid, msg_id, subject, from_addr, from_name, to_list, cc_list,
         date_ms, received_ms, size, flags, read, important, has_attachments, att_json, labels, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [m.accountId, m.folder, m.uid, m.msgId || '', m.subject || '', m.fromAddr || '', m.fromName || '',
       toJson(m.toList || []), toJson(m.ccList || []), m.dateMs || 0, m.receivedMs || 0, m.size || 0,
       toJson(m.flags || []), m.read ? 1 : 0, m.important ? 1 : 0, m.hasAttachments ? 1 : 0,
       toJson(m.attMeta || []), toJson(m.labels || []), now()]);
    return { inserted: true, id: Number(info.lastInsertRowid), msg: null };
  },
  update(id, fields) {
    // 兼容调用方使用的驼峰键 → 列名
    const ALIAS = {
      subject: 'subject', msgId: 'msg_id', fromAddr: 'from_addr', fromName: 'from_name',
      toList: 'to_list', ccList: 'cc_list', dateMs: 'date_ms', receivedMs: 'received_ms',
      size: 'size', flags: 'flags', read: 'read', important: 'important',
      hasAttachments: 'has_attachments', attJson: 'att_json', attMeta: 'att_json', snippet: 'snippet',
      bodyText: 'body_text', bodyHtml: 'body_html', bodyFetched: 'body_fetched', headers: 'headers_json',
      category: 'category', categoryReason: 'category_reason', categoryModel: 'category_model',
      categoryAt: 'category_at', aiAttempted: 'ai_attempted', worth: 'worth', worthReason: 'worth_reason', done: 'done', doneAt: 'done_at', hidden: 'hidden', dates: 'dates_json', datesAt: 'dates_at', datesIgnored: 'dates_ignored', aiSummary: 'ai_summary',
      aiSummaryModel: 'ai_summary_model', aiSummaryAt: 'ai_summary_at', labels: 'labels',
    };
    const allowed = new Set(['subject', 'from_addr', 'from_name', 'to_list', 'cc_list', 'date_ms', 'received_ms',
      'size', 'flags', 'read', 'important', 'has_attachments', 'att_json', 'snippet', 'body_text', 'body_html',
      'body_fetched', 'headers_json', 'category', 'category_reason', 'category_model', 'category_at',
      'ai_attempted', 'worth', 'worth_reason', 'done', 'done_at', 'hidden', 'dates_json', 'dates_at', 'dates_ignored', 'ai_summary', 'ai_summary_model', 'ai_summary_at', 'labels']);
    const sets = []; const vals = [];
    for (const [orig, v] of Object.entries(fields)) {
      const k = ALIAS[orig] || orig;
      if (!allowed.has(k)) continue;
      if (['to_list', 'cc_list', 'flags', 'att_json', 'labels', 'headers_json', 'dates_json'].includes(k)) {
        sets.push(`${k} = ?`); vals.push(toJson(v ?? []));
      } else if (['read', 'important', 'has_attachments', 'body_fetched', 'done', 'hidden', 'dates_ignored'].includes(k)) {
        sets.push(`${k} = ?`); vals.push(v ? 1 : 0);
      } else { sets.push(`${k} = ?`); vals.push(v ?? null); }
    }
    if (!sets.length) return;
    vals.push(id);
    run(`UPDATE message SET ${sets.join(', ')} WHERE id = ?`, vals);
  },
  /** 细节查询（含正文/头），返回完整行 */
  detail(id) {
    const r = q1(`SELECT * FROM message WHERE id=?`, [id]);
    if (!r) return null;
    const m = rowToMsg(r);
    m.bodyText = r.body_text || '';
    m.bodyHtml = r.body_html || '';
    m.headers = safeJson(r.headers_json, {});
    return m;
  },
  /**
   * 批量按 id 取正文。只选正文列，供启动回填等场景一次取回，
   * 避免在循环里对每封邮件单独查库（N 次 SQL → 1 次）。
   * @param {Array<number|string>} ids
   * @returns {Map<number, {bodyText:string, bodyHtml:string}>}
   */
  bodiesByIds(ids) {
    const out = new Map();
    const list = (ids || []).filter((v) => v != null);
    if (!list.length) return out;
    // 分片查询，避开 SQLite 变量数上限（默认 999）
    const CHUNK = 500;
    for (let i = 0; i < list.length; i += CHUNK) {
      const part = list.slice(i, i + CHUNK);
      const rows = q(
        `SELECT id, body_text, body_html FROM message WHERE id IN (${part.map(() => '?').join(',')})`,
        part);
      for (const r of rows) out.set(r.id, { bodyText: r.body_text || '', bodyHtml: r.body_html || '' });
    }
    return out;
  },
  /** 组合查询 */
  query(opts) {
    const where = [];
    const params = [];
    const push = (cond, ...vals) => { where.push(cond); params.push(...vals); };

    if (opts.accountIds && opts.accountIds.length) {
      push(`account_id IN (${opts.accountIds.map(() => '?').join(',')})`, ...opts.accountIds);
    }
    if (opts.folderIn && opts.folderIn.length) {
      push(`folder IN (${opts.folderIn.map(() => '?').join(',')})`, ...opts.folderIn);
    } else if (opts.folder) push('folder = ?', opts.folder);
    if (opts.unreadOnly) push('read = 0');
    if (opts.doneOnly) push('done = 1');
    if (opts.hiddenOnly) push('hidden = 1');
    else if (!opts.includeHidden) push('hidden = 0');
    if (opts.hideDone) push('done = 0');
    if (opts.flaggedOnly) push('important = 1');
    if (opts.attachment) push('has_attachments = 1');
    if (opts.attachmentType) {
      push('id IN (SELECT message_id FROM attachment WHERE mime LIKE ?)', `%${opts.attachmentType}%`);
    }
    if (opts.category) {
      if (Array.isArray(opts.category) && opts.category.length) {
        push(`category IN (${opts.category.map(() => '?').join(',')})`, ...opts.category);
      } else if (typeof opts.category === 'string' && opts.category) {
        push('category = ?', opts.category);
      }
    }
    if (opts.labels && opts.labels.length) {
      for (const lb of opts.labels) push("labels LIKE ?", `%"${lb}"%`);
    }
    if (opts.q) {
      const like = `%${opts.q}%`;
      push('(subject LIKE ? OR from_name LIKE ? OR from_addr LIKE ? OR to_list LIKE ?)', like, like, like, like);
    }
    if (opts.bodyQ) {
      const like = `%${opts.bodyQ}%`;
      push('(body_text LIKE ? OR body_html LIKE ? OR snippet LIKE ?)', like, like, like);
    }
    if (opts.from) { const like = `%${opts.from}%`; push('(from_name LIKE ? OR from_addr LIKE ?)', like, like); }
    if (opts.subject) push('subject LIKE ?', `%${opts.subject}%`);
    if (opts.dateFrom != null) push('date_ms >= ?', opts.dateFrom);
    if (opts.dateTo != null) push('date_ms <= ?', opts.dateTo);
    if (opts.bodyFetched != null) push('body_fetched = ?', opts.bodyFetched ? 1 : 0);
    if (opts.idIn) {
      const list = Array.isArray(opts.idIn) ? opts.idIn : [];
      if (list.length) push(`id IN (${list.map(() => '?').join(',')})`, ...list);
    }

    const base = `FROM message WHERE ${where.length ? where.join(' AND ') : '1=1'}`;
    const total = q1(`SELECT COUNT(*) AS c ${base}`, params)?.c ?? 0;

    const sortMap = {
      date: 'date_ms', from: 'from_addr', subject: 'subject', read: 'read', size: 'size', uid: 'uid',
    };
    const col = sortMap[opts.sort] || 'date_ms';
    const dir = opts.dir === 'asc' ? 'ASC' : 'DESC';
    const limit = Math.min(Math.max(Number(opts.pageSize) || 50, 1), 200);
    const offset = Math.max(Number(opts.page) || 0, 0) * limit;
    const cols = MSG_COLS.split(', ').map((c) => `message.${c}`).join(', ');
    const rows = q(`SELECT ${cols}, acc.name AS account_name, acc.color AS account_color
      FROM message LEFT JOIN account acc ON acc.id = message.account_id
      WHERE ${where.length ? where.join(' AND ') : '1=1'}
      ORDER BY ${col} ${dir}, message.id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
    return { total, list: rows.map(rowToMsg), page: opts.page || 0, pageSize: limit };
  },
  unreadByAccount() {
    return q('SELECT account_id, COUNT(*) AS unread FROM message WHERE read = 0 GROUP BY account_id');
  },
  unreadByFolder(accountId) {
    return q('SELECT folder, COUNT(*) AS unread FROM message WHERE account_id = ? AND read = 0 GROUP BY folder', [accountId]);
  },
  unreadByCategory() {
    return q('SELECT category, COUNT(*) AS unread FROM message WHERE read = 0 GROUP BY category');
  },
  categoryCounts() {
    return q('SELECT category, COUNT(*) AS total, SUM(CASE WHEN read=0 THEN 1 ELSE 0 END) AS unread FROM message GROUP BY category');
  },
  latest(accountId, folder, n = 10) {
    return q(`SELECT ${MSG_COLS} FROM message WHERE account_id=? AND folder=? ORDER BY date_ms DESC, id DESC LIMIT ?`,
      [accountId, folder, n]).map(rowToMsg);
  },
  hydrateQueue(accountId, limit = 50) {
    return q(`SELECT ${MSG_COLS} FROM message WHERE account_id=? AND body_fetched=0 ORDER BY date_ms DESC LIMIT ?`,
      [accountId, limit]).map(rowToMsg);
  },
  uncategorized(accountId, limit = 30) {
    return q(`SELECT ${MSG_COLS} FROM message WHERE account_id=? AND body_fetched=1 AND ai_attempted=0 ORDER BY date_ms DESC LIMIT ?`,
      [accountId, limit]).map(rowToMsg);
  },
  /** 全库标签清单及数量（智能收件箱按标签筛选用） */
  labelsInventory(accountIds = null) {
    const rows = accountIds && accountIds.length
      ? q(`SELECT labels FROM message WHERE account_id IN (${accountIds.map(() => '?').join(',')})`, accountIds)
      : q('SELECT labels FROM message');
    const map = {};
    for (const r of rows) {
      for (const lb of safeJson(r.labels, []) || []) {
        if (lb) map[lb] = (map[lb] || 0) + 1;
      }
    }
    return Object.entries(map).sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }));
  },
  async applyFlagsRemoteSafe(ids) { return ids; },
};

/* ================= 附件 ================= */
/** 统一的“是否杂项”表达式：用户手动改判优先，其次自动判定 */
const JUNK_EXPR = 'COALESCE(a.junk_override, a.junk)';

export const AttachmentStore = {
  insert(a) {
    const junk = isJunkAttachment(a.filename, a.mime, a.size) ? 1 : 0;
    const info = run(
      `INSERT INTO attachment (message_id, account_id, filename, mime, size, content_id, disposition, part, stored, hash, created_at, junk)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [a.messageId, a.accountId || '', a.filename || '', a.mime || '', a.size || 0, a.contentId || '',
       a.disposition || '', a.part || '', a.stored || '', a.hash || '', now(), junk]);
    return Number(info.lastInsertRowid);
  },
  /** 用户手动改判某条附件是否为“杂项”（junk=true 归为杂项，false 表示“这条其实不是杂项”，null 恢复自动判定） */
  setJunkOverride(id, junk) {
    if (junk === null || junk === undefined) run('UPDATE attachment SET junk_override = NULL WHERE id = ?', [id]);
    else run('UPDATE attachment SET junk_override = ? WHERE id = ?', [junk ? 1 : 0, id]);
    const r = q1('SELECT * FROM attachment WHERE id = ?', [id]);
    return r ? rowToAtt(r) : null;
  },
  /** 重算全部附件的自动杂项标记（老库升级 / 规则调整后调用） */
  reclassifyJunk() {
    const rows = q('SELECT id, filename, mime, size FROM attachment');
    let changed = 0;
    for (const r of rows) {
      const junk = isJunkAttachment(r.filename, r.mime, r.size) ? 1 : 0;
      run('UPDATE attachment SET junk = ? WHERE id = ? AND junk <> ?', [junk, r.id, junk]);
      changed++;
    }
    return { scanned: rows.length, changed };
  },
  byMessage(messageId) {
    return q('SELECT * FROM attachment WHERE message_id = ? ORDER BY id', [messageId]).map(rowToAtt);
  },
  get(id) {
    const r = q1('SELECT * FROM attachment WHERE id = ?', [id]);
    if (!r) return null;
    return { ...rowToAtt(r), row: r };
  },
  deleteByMessage(messageId) {
    run('DELETE FROM attachment WHERE message_id = ?', [messageId]);
  },
  findStored(messageId, filename, size) {
    return q1('SELECT * FROM attachment WHERE message_id=? AND filename=? AND size=?', [messageId, filename, size]);
  },
  /** 按内容哈希查找已缓存附件（跨邮件 / 多次同步去重） */
  findByHash(hash, size) {
    if (!hash) return null;
    const r = q1("SELECT * FROM attachment WHERE hash=? AND size=? AND stored != '' ORDER BY id LIMIT 1", [hash, size]);
    return r ? rowToAtt(r) : null;
  },
  /** 当前仍被引用的落盘文件名集合（孤儿文件清理用） */
  referencedStoredNames() {
    const rows = q("SELECT DISTINCT stored FROM attachment WHERE stored != ''");
    return new Set(rows.map((r) => r.stored));
  },
  /** 组合查询：过滤/排序/分页全部下推 SQL，total 与分组统计口径一致 */
  list(opts) {
    const where = ['1=1']; const params = [];
    if (opts.accountIds && opts.accountIds.length) {
      where.push(`a.account_id IN (${opts.accountIds.map(() => '?').join(',')})`); params.push(...opts.accountIds);
    }
    if (opts.q) { where.push('a.filename LIKE ?'); params.push(`%${opts.q}%`); }
    if (opts.minSize != null) { where.push('a.size >= ?'); params.push(opts.minSize); }
    if (opts.dateFrom != null) { where.push('m.date_ms >= ?'); params.push(opts.dateFrom); }
    if (opts.dateTo != null) { where.push('m.date_ms <= ?'); params.push(opts.dateTo); }
    if (opts.onlyStored) { where.push("a.stored != ''"); }

    const sel = (opts.mimeGroups || []).filter(Boolean);
    const wantJunk = sel.includes('junk');
    const wantGroups = sel.filter((g) => g !== 'junk');
    const noJunkByDefault = !opts.includeJunk && !wantJunk;
    if (wantJunk) where.push(`${JUNK_EXPR} = 1`);
    else if (noJunkByDefault) where.push(`${JUNK_EXPR} = 0`);

    // 性能优化：把「MIME 大类」过滤下推到 SQL。
    // 附件量大时（实测本机 300+ 条）要把所有行连同正文消息字段都读进 JS 再丢弃。
    // 现在按分组定义翻译成 mime 的 IN/LIKE 条件，交给 SQLite 用索引过滤。
    if (wantGroups.length) {
      const pred = groupPredicate(wantGroups);
      if (pred) { where.push(pred.sql); params.push(...pred.params); }
    }

    const sortKey = opts.sort === 'size' ? 'a.size' : (opts.sort === 'date' ? 'm.date_ms' : 'a.created_at');
    const dir = opts.dir === 'asc' ? 'ASC' : 'DESC';
    const limit = Math.min(Math.max(Number(opts.pageSize) || 60, 1), 200);
    const offset = Math.max(Number(opts.page) || 0, 0) * limit;

    const agg = q1(
      `SELECT COUNT(*) AS total, COALESCE(SUM(a.size), 0) AS totalBytes
       FROM attachment a JOIN message m ON m.id = a.message_id
       WHERE ${where.join(' AND ')}`, params);
    const rows = q(
      `SELECT a.*, m.subject, m.from_name, m.from_addr, m.date_ms, m.read
       FROM attachment a JOIN message m ON m.id = a.message_id
       WHERE ${where.join(' AND ')}
       ORDER BY ${sortKey} ${dir}, a.id DESC
       LIMIT ? OFFSET ?`, [...params, limit, offset]);
    return {
      total: agg?.total || 0,
      totalBytes: agg?.totalBytes || 0,
      list: rows.map(rowToAtt),
      page: opts.page || 0,
      pageSize: limit,
    };
  },
  /** 按 MIME 大类和“杂项”分组的统计（同样走 SQL，和 list 的 total 同口径） */
  stats(opts) {
    const where = []; const params = [];
    if (opts.accountIds && opts.accountIds.length) {
      where.push(`account_id IN (${opts.accountIds.map(() => '?').join(',')})`); params.push(...opts.accountIds);
    }
    const rows = q(
      `SELECT mime, size, COALESCE(junk_override, junk) AS is_junk FROM attachment${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`,
      params);
    const out = { junk: { n: 0, bytes: 0 }, clean: { n: 0, bytes: 0 }, groups: {}, total: 0 };
    for (const r of rows) {
      out.total++;
      if (r.is_junk) { out.junk.n++; out.junk.bytes += r.size || 0; continue; }
      const g = mimeGroupName(r.mime);
      out.clean.n++; out.clean.bytes += r.size || 0;
      out.groups[g] = out.groups[g] || { n: 0, bytes: 0 };
      out.groups[g].n++; out.groups[g].bytes += r.size || 0;
    }
    return out;
  },
  /** 全部已落盘附件（用于容量清理） */
  allStored() {
    return q("SELECT id, message_id, stored FROM attachment WHERE stored != ''");
  },
  removeAllStored() {
    run("DELETE FROM attachment WHERE stored != ''");
  },
};

/* MIME 大类定义与判定统一来自 util.js（单一事实源），此处不再重复定义，
   避免与附件库/过滤规则对同一附件给出不同分组名。 */
const MIME_GROUPS = MIME_GROUP;

function mimeList(g) { return MIME_GROUPS[g] || []; }

/**
 * 把「MIME 大类名」翻译成等价的 SQL 条件，使过滤能下推到 SQLite。
 * 语义必须与 mimeGroup() 完全一致，否则附件库筛选会漏项：
 *   - 显式枚举的组（document/table/...）→ mime IN (...)
 *   - 以前缀兜底的组（image/text/audio/video）→ mime LIKE 'prefix/%'
 *   - text 组额外包含 JSON/XML/JS/PHP 等非 text/ 前缀类型
 *   - other 组 = 上述都不匹配的剩余项（用 NOT 组合表达）
 * @returns {{sql:string, params:Array}|null}
 */
function groupPredicate(groups) {
  const clauses = []; const params = [];
  /** 所有被显式枚举过的 MIME（小写）——other 组必须把它们全部排除，语义才与 mimeGroup() 一致 */
  const allExplicit = [];
  for (const list of Object.values(MIME_GROUPS)) for (const m of list) allExplicit.push(m.toLowerCase());

  for (const g of groups) {
    // 每个分组的若干「候选条件」之间是 OR（命中任一即属于该组），
    // 分组之间也是 OR；整个分组用一层括号包住。
    const alts = [];
    const exact = mimeList(g);
    if (exact.length) {
      alts.push(`lower(a.mime) IN (${exact.map(() => '?').join(',')})`);
      params.push(...exact.map((m) => m.toLowerCase()));
    }

    if (g === 'text') {
      // text 组 = text/ 前缀 ∪ TEXT_LIKE（JSON/XML/JS/PHP）——两者必须 OR
      alts.push("a.mime LIKE 'text/%'");
      alts.push(`lower(a.mime) IN (${TEXT_LIKE_LOWER.map(() => '?').join(',')})`);
      params.push(...TEXT_LIKE_LOWER);
    } else if (g === 'image' || g === 'audio' || g === 'video') {
      // 这些组：显式枚举 ∪ 前缀兜底 —— 同样 OR
      alts.push(`a.mime LIKE '${g}/%'`);
    } else if (g === 'other') {
      // other = 排除所有已知前缀与所有显式枚举类型后的剩余项（整体作为一个条件）
      const notPrefix = "(a.mime NOT LIKE 'text/%' AND a.mime NOT LIKE 'image/%' AND a.mime NOT LIKE 'audio/%' AND a.mime NOT LIKE 'video/%')";
      alts.push(`${notPrefix} AND lower(a.mime) NOT IN (${allExplicit.map(() => '?').join(',')}) AND lower(a.mime) NOT IN (${TEXT_LIKE_LOWER.map(() => '?').join(',')})`);
      params.push(...allExplicit, ...TEXT_LIKE_LOWER);
    }

    if (alts.length) clauses.push(`(${alts.join(' OR ')})`);
  }
  return clauses.length ? { sql: `(${clauses.join(' OR ')})`, params } : null;
}

/** util.js 中 text 组除 text/ 前缀外的额外类型（小写，供 SQL 比较） */
const TEXT_LIKE_LOWER = ['application/json', 'application/xml', 'application/javascript', 'application/x-httpd-php'];

/** 兼容既有调用方（rules.js 等）：统一转发到 util.js 的实现 */
export { mimeGroupName };

function rowToAtt(r) {
  // junk_override 优先（用户手动改判），否则用落库的自动判定
  const autoJunk = !!r.junk;
  const junk = r.junk_override === null || r.junk_override === undefined ? autoJunk : !!r.junk_override;
  return {
    id: r.id, messageId: r.message_id, accountId: r.account_id, filename: r.filename,
    mime: r.mime, size: r.size, contentId: r.content_id, disposition: r.disposition,
    part: r.part, stored: r.stored, hash: r.hash, createdAt: r.created_at,
    subject: r.subject, fromName: r.from_name, fromAddr: r.from_addr,
    dateMs: r.date_ms, read: !!r.read, group: mimeGroupName(r.mime),
    junk, autoJunk, junkOverridden: r.junk_override !== null && r.junk_override !== undefined,
    junkReason: junk ? junkAttachmentReason(r.filename, r.mime, r.size) : '',
  };
}

/* ================= 规则 ================= */
export const RuleStore = {
  list() {
    return q('SELECT * FROM rule ORDER BY priority DESC, created_at').map((r) => ({
      id: r.id, name: r.name, enabled: !!r.enabled, priority: r.priority,
      match: safeJson(r.match_json, []), action: safeJson(r.action_json, {}), createdAt: r.created_at,
    }));
  },
  get(id) {
    const r = q1('SELECT * FROM rule WHERE id = ?', [id]);
    return r ? { id: r.id, name: r.name, enabled: !!r.enabled, priority: r.priority, match: safeJson(r.match_json, []), action: safeJson(r.action_json, {}) } : null;
  },
  save(rule) {
    // 未显式传 enabled 时默认「启用」（此前会被存成停用，规则看似存在却不生效）
    const enabledFlag = rule.enabled === undefined || rule.enabled === null
      ? 1
      : (rule.enabled ? 1 : 0);
    if (rule.id) {
      run('UPDATE rule SET name=?, enabled=?, priority=?, match_json=?, action_json=? WHERE id=?',
        [rule.name || '', enabledFlag, rule.priority || 0, toJson(rule.match || []), toJson(rule.action || {}), rule.id]);
      return rule.id;
    }
    const id = uid();
    run('INSERT INTO rule (id, name, enabled, priority, match_json, action_json, created_at) VALUES (?,?,?,?,?,?,?)',
      [id, rule.name || '', enabledFlag, rule.priority || 0, toJson(rule.match || []), toJson(rule.action || {}), now()]);
    return id;
  },
  remove(id) { run('DELETE FROM rule WHERE id = ?', [id]); },
};

/* ================= 日历事件 / 提醒 ================= */
export const EventStore = {
  list(start, end) {
    return q('SELECT * FROM event WHERE end_ms >= ? AND start_ms <= ? ORDER BY start_ms', [start || 0, end || Number.MAX_SAFE_INTEGER]).map(rowToEvent);
  },
  all() { return q('SELECT * FROM event ORDER BY start_ms').map(rowToEvent); },
  get(id) { const r = q1('SELECT * FROM event WHERE id = ?', [id]); return r ? rowToEvent(r) : null; },
  byMessage(messageId) { return q('SELECT * FROM event WHERE message_id = ?', [messageId]).map(rowToEvent); },
  insert(ev) {
    run(`INSERT INTO event (id, title, start_ms, end_ms, all_day, source, message_id, note, color, remind_offsets, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [ev.id, ev.title || '', ev.startMs || 0, ev.endMs || 0, ev.allDay ? 1 : 0, ev.source || 'manual',
       ev.messageId || 0, ev.note || '', ev.color || '#e07b39', toJson(ev.remindOffsets || []), now()]);
    if (ev.remindOffsets && ev.remindOffsets.length) {
      for (const off of ev.remindOffsets) {
        const due = ev.startMs + Number(off) * 60000;
        run('INSERT OR IGNORE INTO reminder (id, event_id, due_ms, fired) VALUES (?,?,?,0)', [uid(), ev.id, due]);
      }
    }
    return ev.id;
  },
  update(id, fields) {
    const m = {
      title: (v) => ['title', v], startMs: (v) => ['start_ms', v], endMs: (v) => ['end_ms', v],
      allDay: (v) => ['all_day', v ? 1 : 0], messageId: (v) => ['message_id', v],
      note: (v) => ['note', v], color: (v) => ['color', v],
    };
    const sets = []; const vals = [];
    for (const [k, v] of Object.entries(fields)) {
      if (m[k]) { const [col, val] = m[k](v); sets.push(`${col} = ?`); vals.push(val); }
    }
    if (fields.remindOffsets) {
      sets.push('remind_offsets = ?'); vals.push(toJson(fields.remindOffsets));
      run('DELETE FROM reminder WHERE event_id = ?', [id]);
      for (const off of fields.remindOffsets) {
        const due = (fields.startMs ?? EventStore.get(id)?.startMs ?? 0) + Number(off) * 60000;
        run('INSERT OR IGNORE INTO reminder (id, event_id, due_ms, fired) VALUES (?,?,?,0)', [uid(), id, due]);
      }
    }
    if (!sets.length) return;
    vals.push(id);
    run(`UPDATE event SET ${sets.join(', ')} WHERE id = ?`, vals);
  },
  remove(id) { run('DELETE FROM event WHERE id = ?', [id]); run('DELETE FROM reminder WHERE event_id = ?', [id]); },
  /** 到期未触发的提醒 */
  dueReminders(nowMs) {
    const rows = q('SELECT * FROM reminder WHERE fired = 0 AND due_ms <= ? ORDER BY due_ms', [nowMs]).map((r) => ({
      id: r.id, eventId: r.event_id, dueMs: r.due_ms,
    }));
    if (rows.length) {
      const ids = rows.map((r) => r.id);
      run(`UPDATE reminder SET fired=1, fired_at=? WHERE id IN (${ids.map(() => '?').join(',')})`, [nowMs, ...ids]);
    }
    return rows;
  },
  upcoming(n = 20) {
    return q('SELECT * FROM event WHERE end_ms >= ? ORDER BY start_ms LIMIT ?', [now(), n]).map(rowToEvent);
  },
};

function rowToEvent(r) {
  return {
    id: r.id, title: r.title, startMs: r.start_ms, endMs: r.end_ms, allDay: !!r.all_day,
    source: r.source, messageId: r.message_id || null, note: r.note, color: r.color,
    remindOffsets: safeJson(r.remind_offsets, []), createdAt: r.created_at,
  };
}

/* ================= 设置 ================= */
export const SettingsStore = {
  get(key, fb = null) {
    const r = q1('SELECT value FROM setting WHERE key = ?', [key]);
    return r ? safeJson(r.value, fb) : fb;
  },
  set(key, value) {
    run('INSERT INTO setting (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', [key, toJson(value)]);
  },
  all() {
    const rows = q('SELECT key, value FROM setting');
    const out = {};
    for (const r of rows) out[r.key] = safeJson(r.value, null);
    return out;
  },
};
