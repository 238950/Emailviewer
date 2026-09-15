// REST API：账户 / 邮件 / 附件 / AI / 日历 / 规则 / 设置 / 状态
import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { AccountStore, FolderStore, MessageStore, AttachmentStore, RuleStore, EventStore, SettingsStore } from './store.js';
import { getSettings, updateSettings, catLabel, HOST_PRESETS, DEFAULT_SETTINGS } from './settings.js';
import { encrypt } from './crypto.js';
import { syncAccount, setFlags, setFlagsBatch, testConnection } from './imap.js';
import { hydrateByUid } from './hydrate.js';
import { aiClassifyBatch, summarizeMessage, testProvider, activeProvider, chat, resolveApiKey } from './ai.js';
import { extractFromMessage } from './nlp.js';
import { applyRules, applyRulesToHydrated } from './rules.js';
import { busy, runHydration, composeDigest, purgeAttachmentCache, pushNewMailNotice } from './services.js';
import { logger, DATA_DIR, ATTACH_DIR, SAVED_DIR, LOG_FILE } from './logger.js';
import { autoStartStatus, applyAutoStart } from './autostart.js';
import { resolveInboxFolders } from './mailboxes.js';
import { uid, now, mimeGroup, stripHtml } from './util.js';
import { isKeyFromEnv } from './env.js';

export const api = Router();
api.use(expressJson());
api.use(originGuard);

const BODY_LIMIT = 2 * 1024 * 1024;   // 请求体上限 2MB

/**
 * 本地写接口的来源校验。
 * 服务只监听 127.0.0.1，但仍可能被浏览器里的任意网页用跨站表单/请求改写本地数据（CSRF）。
 * 规则：① 写方法必须带 application/json；② 带 Origin/Referer 时必须指向本机服务端口。
 */
function originGuard(req, res, next) {
  const write = req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS';
  const ownHosts = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
  const selfPorts = new Set([String(req.socket?.localPort || ''), String(process.env.MAILVIEW_PORT || '')].filter(Boolean));

  const checkSource = (raw) => {
    if (!raw) return true;
    let u;
    try { u = new URL(raw); } catch { return false; }
    const port = u.port || (u.protocol === 'https:' ? '443' : '80');
    return ownHosts.has(u.hostname) && (!selfPorts.size || selfPorts.has(port));
  };

  if (!checkSource(req.get('origin')) || !checkSource(req.get('referer'))) {
    return fail(res, '已拒绝来自其它站点的请求（来源校验未通过）', 403);
  }
  if (write) {
    const ct = String(req.get('content-type') || '').toLowerCase();
    if (ct && !ct.startsWith('application/json')) {
      return fail(res, '写接口只接受 application/json（已拒绝 text/plain 等可绕过预检的类型）', 415);
    }
  }
  next();
}

function expressJson() {
  return (req, res, next) => {
    // 先看声明的 Content-Length，超限直接拒绝（连读取都不需要）
    const declared = Number(req.get('content-length') || 0);
    if (declared > BODY_LIMIT) {
      req.resume();   // 丢弃后续数据，保持连接可复用
      return fail(res, `请求体过大（上限 ${Math.round(BODY_LIMIT / 1024 / 1024)}MB）`, 413);
    }
    const chunks = [];
    let size = 0;
    let aborted = false;
    req.on('data', (c) => {
      if (aborted) return;
      size += c.length;
      if (size > BODY_LIMIT) {
        // 超限：不再缓存任何分片，直接回 413 并丢弃剩余数据（destroy 会让客户端只看到连接中断）
        aborted = true;
        chunks.length = 0;
        return fail(res, `请求体过大（上限 ${Math.round(BODY_LIMIT / 1024 / 1024)}MB）`, 413);
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (aborted) return;
      if (!chunks.length) { req.body = {}; return next(); }
      try {
        req.body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch {
        req.body = {};
      }
      next();
    });
    req.on('error', () => { aborted = true; });
  };
}

/* ---------- 工具 ---------- */
const ok = (res, data, code = 200) => res.status(code).json({ ok: true, ...data });
const fail = (res, msg, code = 400) => res.status(code).json({ ok: false, error: msg });
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const str = (v, d = '') => (v == null ? d : String(v));
/** 整数夹取：非数字/空/负数 → 回落默认值；过大的值夹取到上限 */
const clampInt = (v, dflt, min, max) => {
  const n = Number(v);
  if (v == null || v === '' || !Number.isFinite(n) || n < 0) return dflt;
  return Math.min(Math.max(Math.trunc(n), min), max);
};

/**
 * async 路由包装器。
 * Express 4 不会自动捕获 async 处理函数 reject 的 Promise——一旦抛错就变成
 * unhandledRejection，Node 22 默认 --unhandled-rejections=throw 会直接终止进程。
 * 用 wrap() 把 rejection 显式转交给 next()，交给下方统一错误中间件处理。
 */
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/* ---------- AI 在途请求去重 ---------- */
/**
 * 手动触发的 AI 接口（classify / summarize / ai-classify）原先无锁：
 * 连点、多标签页或网络重试会串行执行多次真实调用 → 重复计费。
 * 这里按 `${kind}:${key}` 维护在途表，重复请求直接 429。
 * 与 services.js 的 busy.classifying（后台批处理）互补，不共用同一把锁，
 * 避免后台批处理运行时用户手动操作被误拒。
 */
const aiInFlight = new Map();

/** 尝试占位；返回 true 表示获得执行权，false 表示已有同键请求在途 */
export function claimAi(kind, key) {
  const k = `${kind}:${key}`;
  if (aiInFlight.has(k)) return false;
  aiInFlight.set(k, Date.now());
  return true;
}
export function releaseAi(kind, key) {
  aiInFlight.delete(`${kind}:${key}`);
}
/** 在途表快照（供 /status 观测，也便于验证脚本断言） */
export function aiInFlightSnapshot() {
  return [...aiInFlight.entries()].map(([k, at]) => ({ key: k, since: at, ms: Date.now() - at }));
}

/* ---------- 日期提取缓存 ---------- */
/**
 * extractFromMessage() 是纯正则扫描，实测 60 封约 404ms，而 /home 每次请求都会
 * 对"尚未预存 dates 的邮件"重跑一遍（liveExtractBudget=60），且结果不缓存——
 * 首页每 60 秒轮询、外加 listKey 变化（标记已读/星标/标签/已处理）都会重算，
 * 造成用户点一下就有可感知卡顿。
 *
 * 缓存键用 `${id}|${dateMs}|${bodyLen}`：
 * - id 区分邮件；
 * - dateMs 变化说明邮件被重新抓取/替换；
 * - bodyLen 是正文长度的廉价指纹——提取结果只依赖主题与正文，
 *   长度相同而内容不同属于极小概率，且最坏后果只是日期候选短暂不准，
 *   下次正文变化即自动失效（不值得为此读全文算哈希）。
 * 容量上限 2000 条，超出按插入顺序淘汰最早的一批（Map 保持插入序）。
 */
const DATE_CACHE = new Map();
const DATE_CACHE_MAX = 2000;

function extractDatesCached(m, bodyMap) {
  const key = `${m.id}|${m.dateMs || 0}|${m.bodyLen || 0}`;
  const hit = DATE_CACHE.get(key);
  if (hit) return hit;

  // 正文优先从批量结果取（避免循环里单条 detail）；批量没命中再回退单条查
  let src = m;
  if (m.bodyLen == null) {
    const b = bodyMap && bodyMap.get(m.id);
    src = b ? { ...m, bodyText: b.bodyText, bodyHtml: b.bodyHtml } : (MessageStore.detail(m.id) || m);
  }
  let list = [];
  try {
    list = extractFromMessage(src).map((c) => ({ ms: c.ms, title: c.context, kind: c.type, confidence: c.confidence, source: 'rule' }));
  } catch { list = []; }

  if (DATE_CACHE.size >= DATE_CACHE_MAX) {
    // 淘汰最早插入的 25%，避免每次满了都做一次 O(n) 清理
    const drop = Math.ceil(DATE_CACHE_MAX / 4);
    let i = 0;
    for (const k of DATE_CACHE.keys()) { DATE_CACHE.delete(k); if (++i >= drop) break; }
  }
  DATE_CACHE.set(key, list);
  return list;
}

const MASK = '••••••••';

/** 密钥脱敏：保留前 4 位与后 4 位，中间用 * 连接（如 sk-a****1234）；过短则统一 **** */
export function maskSecret(secret) {
  const s = String(secret || '');
  if (!s) return '';
  if (s.length <= 8) return '****';
  const stars = '*'.repeat(Math.max(4, Math.min(s.length - 8, 12)));
  return `${s.slice(0, 4)}${stars}${s.slice(-4)}`;
}

/** 脱敏 AI 配置（不下发真实密钥，只给前4/后4）
 *  hasKey 以「.env 优先、数据库兜底」解析后的结果为准；keySource 标明密钥来源：
 *    env  = 由 .env 文件托管（界面输入框改不动，以文件为准）
 *    db   = 存在数据库里（可在设置页修改）
 *    none = 未配置
 */
function sanitizeAi(cfg) {
  const out = JSON.parse(JSON.stringify(cfg || {}));
  for (const k of Object.keys(out.providers || {})) {
    const p = out.providers[k];
    if (!p) continue;
    const { key, source } = resolveApiKey(k, p.apiKey);
    p.hasKey = !!key;
    p.keySource = source;
    p.keyPreview = key ? maskSecret(key) : '';
    p.envManaged = source === 'env';
    delete p.apiKey;
  }
  return out;
}

function sanitizeAccount(a) {
  const { passwordEnc, ...rest } = a;
  void passwordEnc;
  return rest;
}

/* ================= 基础 ================= */
api.get('/health', (req, res) => ok(res, { status: 'up', time: now() }));
api.get('/presets', (req, res) => {
  const s = getSettings();
  ok(res, {
    hostPresets: HOST_PRESETS,
    categories: s.categories,
    categoryColors: s.categoryColors,
    ai: sanitizeAi(s.ai),
    defaultSettings: { syncIntervalMin: s.syncIntervalMin, initialSyncDays: s.initialSyncDays },
  });
});

/* ================= 账户 ================= */
api.get('/accounts', (req, res) => {
  const list = AccountStore.list().map(sanitizeAccount);
  ok(res, { accounts: list });
});

api.post('/accounts', async (req, res) => {
  const b = req.body || {};
  try {
    if (b.kind === 'outlook-local') {
      const { outlookAccounts } = await import('./outlook.js');
      const probe = await outlookAccounts();
      if (!probe.ok) return fail(res, probe.error || '无法连接本机 Outlook，请先安装并登录 Outlook 桌面客户端', 500);
      const acc = (probe.accounts || []).find((x) => (x.smtp || '').toLowerCase() === String(b.email || '').toLowerCase())
        || (probe.accounts || [])[0];
      if (!acc) return fail(res, 'Outlook 中没有可用邮箱账号');
      const email = acc.smtp || b.email;
      if (!email) return fail(res, 'Outlook 账号缺少邮箱地址，请在 Outlook 中补充后重试');
      const accountId = uid();
      AccountStore.insert({
        id: accountId, kind: 'outlook-local', name: b.name || acc.displayName || email.split('@')[0],
        email, username: '', host: '', port: 0, ssl: false, auth: 'outlook-com',
        passwordEnc: '', isPrimary: AccountStore.list().length === 0,
        color: b.color || '#0f9d6e',
      });
      const summary = await syncAccount(accountId).catch((e) => {
        logger.warn('api', `Outlook 账户首轮同步失败 ${email}: ${e.message}`);
        return null;
      });
      if (summary) {
        runHydration(accountId).catch(() => {});
        if (summary.newMessages > 0) pushNewMailNotice(AccountStore.get(accountId), summary.newMessages, { firstSync: true });
      }
      return ok(res, { account: sanitizeAccount(AccountStore.get(accountId)), summary }, 201);
    }
    const { name, email, username, password, host, port, ssl, color, auth, allowInsecureTls } = b;
    if (!host || !email) return fail(res, '请填写服务器地址与邮箱地址');
    if (!password) return fail(res, '请填写密码 / 应用专用密码');
    const accountId = uid();
    const extra = { allowInsecureTls: !!allowInsecureTls };
    AccountStore.insert({
      id: accountId, kind: 'imap', name: name || email.split('@')[0], email, username: username || email,
      host, port: num(port, 993), ssl: ssl !== false, auth: auth || 'password',
      passwordEnc: encrypt(password), isPrimary: AccountStore.list().length === 0, color: color || '#4f8cff',
      extra,   // 把“允许不校验 TLS 证书”等选项真正落库
    });
    // 校验并同步一次
    const summary = await syncAccount(accountId).catch((e) => {
      logger.warn('api', `新账户首次同步失败 ${host}: ${e.message}`);
      return null;
    });
    if (summary) {
      runHydration(accountId).catch(() => {});
      if (summary.newMessages > 0) pushNewMailNotice(AccountStore.get(accountId), summary.newMessages, { firstSync: true });
    }
    ok(res, { account: sanitizeAccount(AccountStore.get(accountId)), summary }, 201);
  } catch (e) {
    fail(res, e.message || '创建失败', 500);
  }
});

api.post('/accounts/test', async (req, res) => {
  const b = req.body || {};
  try {
    const r = await testConnection({
      host: b.host, port: num(b.port, 993), ssl: b.ssl !== false,
      username: b.username || b.email, email: b.email, password: b.password,
      allowInsecureTls: !!b.allowInsecureTls,
    });
    ok(res, { connected: true, folders: r.sampleFolders, port: num(b.port, 993), ssl: b.ssl !== false });
  } catch (e) {
    ok(res, { connected: false, error: e.message });
  }
});

/* ================= 本机 Outlook（COM） ================= */
api.get('/outlook/status', async (req, res) => {
  const { outlookAccounts, psBusy } = await import('./outlook.js');
  if (psBusy()) return ok(res, { ok: false, busy: true });
  const r = await outlookAccounts();
  ok(res, { ...r, kind: 'outlook-local' });
});
api.post('/outlook/folders', async (req, res) => {
  const { outlookFolders } = await import('./outlook.js');
  try {
    const r = await outlookFolders(req.body?.email || '', req.body?.name || '');
    ok(res, r);
  } catch (e) {
    fail(res, e.message, 500);
  }
});

api.get('/accounts/:id', (req, res) => {
  const a = AccountStore.get(req.params.id);
  if (!a) return fail(res, '账户不存在', 404);
  ok(res, { account: sanitizeAccount(a) });
});

api.put('/accounts/:id', (req, res) => {
  const a = AccountStore.get(req.params.id);
  if (!a) return fail(res, '账户不存在', 404);
  const b = req.body || {};
  const patch = {};
  if (b.name != null) patch.name = str(b.name, a.name);
  if (b.color != null) patch.color = str(b.color, a.color);
  if (b.email != null) patch.email = str(b.email);
  if (b.username != null) patch.username = str(b.username);
  if (b.host != null) patch.host = str(b.host);
  if (b.port != null) patch.port = num(b.port, 993);
  if (b.ssl != null) patch.ssl = !!b.ssl;
  if (b.enabled != null) patch.enabled = !!b.enabled;
  if (b.isPrimary) patch.isPrimary = true;
  if (b.password && b.password !== MASK) patch.passwordEnc = encrypt(b.password);
  if (b.allowInsecureTls != null) patch.extra = { ...a.extra, allowInsecureTls: !!b.allowInsecureTls };
  AccountStore.update(a.id, patch);
  if (b.isPrimary) makePrimary(a.id);
  ok(res, { account: sanitizeAccount(AccountStore.get(a.id)) });
});

api.delete('/accounts/:id', (req, res) => {
  const a = AccountStore.get(req.params.id);
  if (!a) return fail(res, '账户不存在', 404);
  // 删除账户时一并清理派生日历事件与落盘的附件文件，并回报释放量
  const report = AccountStore.remove(a.id);
  logger.info('api', `已删除账户 ${a.name}：邮件 ${report.messages}、附件文件 ${report.files}、事件 ${report.events}`);
  ok(res, { removed: true, report });
});

api.post('/accounts/:id/primary', (req, res) => {
  // 账户不存在时必须 404，否则 makePrimary 会把所有账户的主标记清空
  const a = AccountStore.get(req.params.id);
  if (!a) return fail(res, '账户不存在', 404);
  makePrimary(a.id);
  ok(res, { primary: a.id });
});

function makePrimary(id) {
  for (const a of AccountStore.list()) AccountStore.update(a.id, { isPrimary: a.id === id });
}

api.get('/accounts/:id/folders', (req, res) => {
  const a = AccountStore.get(req.params.id);
  if (!a) return fail(res, '账户不存在', 404);
  const folders = FolderStore.list(a.id).map((f) => ({
    ...f,
    unread: MessageStore.unreadByFolder(a.id).find((r) => r.folder === f.name)?.unread || 0,
  }));
  ok(res, { folders, needsSync: !a.lastSyncAt });
});

api.post('/accounts/:id/sync', async (req, res) => {
  const acc = AccountStore.get(req.params.id);
  if (!acc) return fail(res, '账户不存在', 404);
  if (busy.syncing.has(acc.id)) return ok(res, { busy: true });
  busy.syncing.add(acc.id);
  try {
    const summary = await syncAccount(acc.id);
    runHydration(acc.id).catch(() => {});
    if (summary?.newMessages > 0) pushNewMailNotice(acc, summary.newMessages);
    ok(res, { summary });
  } catch (e) {
    fail(res, e.message || '同步失败', 500);
  } finally {
    busy.syncing.delete(acc.id);
  }
});

/* ================= 邮件 ================= */
const PAGE_SIZE = 60;

api.get('/messages', (req, res) => {
  const q = req.query || {};
  const rawA = q.accountId ?? q.account_ids ?? q.accountIds;
  const accountIds = Array.isArray(rawA)
    ? rawA.filter(Boolean)
    : String(rawA || '').split(',').filter(Boolean);
  // “统一收件箱”语义：folder=INBOX 仅对标准 IMAP 成立；Outlook 桌面账户的真实收件箱
  // 是“\账号\Inbox”等路径。这里复用公共解析函数（与首页/汇总保持一致）。
  let folder = q.folder ? str(q.folder) : (q.unified ? 'INBOX' : '');
  let folderIn = null;
  if (q.unified && folder === 'INBOX') {
    if (!accountIds.length) {
      // 未指定/未启用账户时直接返回空，而不是全库查询
      return ok(res, { total: 0, list: [], page: 0, pageSize: num(q.pageSize, PAGE_SIZE) });
    }
    const resolved = resolveInboxFolders(accountIds);
    folderIn = resolved.folders.length ? resolved.folders : ['INBOX'];
    folder = '';
  }
  const opts = {
    accountIds,
    folder,
    folderIn,
    unreadOnly: q.unread === '1' || q.unread === 'true',
    doneOnly: q.done === '1' || q.done === 'true',
    hideDone: q.done === '0' || q.done === 'false',
    flaggedOnly: q.important === '1' || q.important === 'true',
    attachment: q.attachment === '1' || q.attachment === 'true',
    attachmentType: q.attachmentType ? str(q.attachmentType) : '',
    category: q.category ? (Array.isArray(q.category) ? q.category : String(q.category).split(',')) : [],
    labels: q.label ? String(q.label).split(',') : [],
    q: q.q ? str(q.q) : '',
    bodyQ: q.bodyQ ? str(q.bodyQ) : '',
    from: q.from ? str(q.from) : '',
    subject: q.subject ? str(q.subject) : '',
    dateFrom: q.fromDate ? num(q.fromDate, null) : null,
    dateTo: q.toDate ? num(q.toDate, null) : null,
    sort: q.sort ? str(q.sort) : 'date',
    dir: q.dir ? str(q.dir) : 'desc',
    // 非法/越界参数回落默认值并夹取上下限，而不是原样透传
    page: clampInt(q.page, 0, 0, 100000),
    pageSize: clampInt(q.pageSize, PAGE_SIZE, 1, 200),
  };
  const res2 = MessageStore.query(opts);
  ok(res, res2);
});

api.get('/messages/:id', async (req, res) => {
  const m = MessageStore.detail(req.params.id);
  if (!m) return fail(res, '邮件不存在', 404);
  let detail = m;
  if (!m.bodyFetched) {
    try {
      detail = await hydrateByUid(m.accountId, m.folder, m.uid);
    } catch (e) {
      return ok(res, { message: m, fetchError: e.message });
    }
  }
  const attachments = AttachmentStore.byMessage(detail.id);
  const events = EventStore.byMessage(detail.id);
  ok(res, { message: detail, attachments, events });
});

function afterReadStateChange(id) {
  // 本地未读计数即时刷新（folder.unread）
  const m = MessageStore.get(id);
  if (m) {
    const un = MessageStore.unreadByFolder(m.accountId).find((r) => r.folder === m.folder);
    FolderStore.setUnreadLocal(m.accountId, m.folder, un ? un.unread : 0);
  }
}

api.post('/messages/:id/read', (req, res) => {
  const id = num(req.params.id);
  const read = req.body?.read ? 1 : 0;
  const m = MessageStore.get(id);
  if (!m) return fail(res, '邮件不存在', 404);
  MessageStore.update(id, { read: !!read });
  setFlags(m.accountId, m.folder, m.uid, { read: !!read }).catch(() => {});
  afterReadStateChange(id);
  ok(res, { id, read: !!read });
});

api.post('/messages/:id/flag', (req, res) => {
  const id = num(req.params.id);
  const important = !!req.body?.important;
  const m = MessageStore.get(id);
  if (!m) return fail(res, '邮件不存在', 404);
  const flags = (m.flags || []).filter((f) => f !== '\\Flagged' && f !== '\\Unflagged');
  if (important) flags.push('\\Flagged');
  MessageStore.update(id, { important, flags });
  setFlags(m.accountId, m.folder, m.uid, { important }).catch(() => {});
  ok(res, { id, important });
});

api.post('/messages/:id/label', (req, res) => {
  const id = num(req.params.id);
  const m = MessageStore.get(id);
  if (!m) return fail(res, '邮件不存在', 404);
  const label = str(req.body?.label).trim();
  const add = req.body?.add !== false;
  if (!label) return fail(res, '标签不能为空');
  let labels = [...(m.labels || [])];
  if (add) { if (!labels.includes(label)) labels.push(label); }
  else labels = labels.filter((l) => l !== label);
  MessageStore.update(id, { labels });
  ok(res, { id, labels });
});

api.post('/messages/:id/classify', wrap(async (req, res) => {
  const m = MessageStore.detail(req.params.id);
  if (!m) return fail(res, '邮件不存在', 404);
  // 同一封邮件已有在途分类请求时直接拒绝，避免重复调用上游 AI（重复计费）
  if (!claimAi('classify', m.id)) return fail(res, '该邮件正在分类中，请稍候', 429);
  try {
    // 手动分类时重置 ai_attempted 以便重跑
    MessageStore.update(m.id, { ai_attempted: 0 });
    const out = await aiClassifyBatch([MessageStore.detail(m.id)], { save: true });
    ok(res, { result: out[0] || null });
  } finally {
    releaseAi('classify', m.id);
  }
}));

api.post('/messages/:id/summarize', wrap(async (req, res) => {
  const m = MessageStore.detail(req.params.id);
  if (!m) return fail(res, '邮件不存在', 404);
  // 摘要同样加在途去重
  if (!claimAi('summarize', m.id)) return fail(res, '该邮件正在生成摘要，请稍候', 429);
  try {
    const r = await summarizeMessage(m);
    ok(res, { result: r });
  } finally {
    releaseAi('summarize', m.id);
  }
}));

/**
 * 日期候选的可信度门槛。
 * AI 识别的（source=ai）直接信任；规则识别的要求 confidence=high（截止/考试词紧邻日期）。
 * 老库中历史数据没有 confidence，按 medium 处理，只用于阅读窗格展示，不自动进首页/日历。
 */
function isTrustedDate(d) {
  if (!d) return false;
  if (d.source === 'ai') return true;
  return d.confidence === 'high';
}

api.get('/messages/:id/dates', (req, res) => {
  const m = MessageStore.detail(req.params.id);
  if (!m) return fail(res, '邮件不存在', 404);
  // 用户主动忽略过 → 直接返回空，不再实时重提取
  if (m.datesIgnored) return ok(res, { candidates: [], source: 'ignored' });
  // 优先返回已存（AI 识别/规则）的结果；没有则实时用规则提取
  let candidates = Array.isArray(m.dates) ? m.dates.map((d) => ({
    ms: d.ms, dateMs: d.ms, phrase: '', time: null, context: d.title || '', type: d.kind || 'event',
    confidence: d.confidence || (d.source === 'ai' ? 'ai' : 'medium'), source: d.source || 'rule',
  })) : [];
  if (!candidates.length) candidates = extractFromMessage(m);
  ok(res, { candidates, source: Array.isArray(m.dates) && m.dates.length ? (m.dates[0].source || 'rule') : 'rule' });
});

/**
 * 一键忽略/恢复某封邮件的识别结果（允许清掉误报；让忽略真正持久）。
 * 关键：忽略必须落成独立标记，不能只写空数组——否则下次读取会被当成"尚未提取"而重新提取。
 * body: { ignored: true } 忽略（默认）；{ ignored: false } 恢复识别
 */
api.post('/messages/:id/dates/clear', (req, res) => {
  const m = MessageStore.detail(req.params.id);
  if (!m) return fail(res, '邮件不存在', 404);
  const ignored = req.body?.ignored !== false;
  MessageStore.update(m.id, { dates: [], datesAt: ignored ? Date.now() : 0, datesIgnored: ignored });
  ok(res, { id: m.id, dates: [], ignored });
});

api.post('/messages/batch-action', async (req, res) => {
  const { ids, action, value } = req.body || {};
  const list = (ids || []).map(num).filter(Boolean);
  if (!list.length) return fail(res, '请选择邮件');
  // 把邮箱侧标记收集起来一次性提交，同一账户复用一条 IMAP 连接
  const flagJobs = [];
  for (const id of list) {
    const m = MessageStore.get(id);
    if (!m) continue;
    if (action === 'read' || action === 'unread') {
      const read = action === 'read';
      MessageStore.update(id, { read });
      flagJobs.push({ accountId: m.accountId, folder: m.folder, uid: m.uid, flags: { read } });
      afterReadStateChange(id);
    } else if (action === 'important' || action === 'unimportant') {
      const important = action === 'important';
      const flags = (m.flags || []).filter((f) => f !== '\\Flagged');
      if (important) flags.push('\\Flagged');
      MessageStore.update(id, { important, flags });
      flagJobs.push({ accountId: m.accountId, folder: m.folder, uid: m.uid, flags: { important } });
    } else if (action === 'label_add' || action === 'label_remove') {
      const labels = action === 'label_add'
        ? [...new Set([...(m.labels || []), value].filter(Boolean))]
        : (m.labels || []).filter((l) => l !== value);
      MessageStore.update(id, { labels });
    } else if (action === 'delete_local') {
      // 真正的“从本地隐藏”（不再用一个中文标签冒充删除）
      MessageStore.update(id, { hidden: true, read: true });
    } else if (action === 'unhide_local') {
      MessageStore.update(id, { hidden: false });
    }
  }
  let mailSync = null;
  if (flagJobs.length) {
    try {
      const byId = new Map(AccountStore.list().map((a) => [a.id, a]));
      mailSync = await setFlagsBatch(flagJobs.map((j) => ({ ...j, account: byId.get(j.accountId) })));
    } catch { /* 邮箱侧失败不影响本地结果 */ }
  }
  ok(res, { done: list.length, mailSync });
});

/* ================= 分类 / 统计 ================= */
api.get('/categories', (req, res) => {
  const s = getSettings();
  const counts = {};
  for (const c of MessageStore.categoryCounts()) counts[c.category] = { total: c.total, unread: c.unread };
  ok(res, { categories: s.categories, categoryColors: s.categoryColors, counts });
});

api.get('/labels', (req, res) => {
  const q = req.query || {};
  const accountIds = q.accountId ? String(q.accountId).split(',') : [];
  const labels = MessageStore.labelsInventory(accountIds);
  ok(res, { labels });
});

/** 首页：推荐活动 / 重要邮件 / 临近截止 / 未读速览 / 低相关邮件（AI worth 驱动；每封邮件只归属一列） */
api.get('/home', (req, res) => {
  const q = req.query || {};
  const rawA = q.accountId ?? q.account_ids ?? q.accountIds;
  const wantIds = Array.isArray(rawA) ? rawA.filter(Boolean) : String(rawA || '').split(',').filter(Boolean);
  // 未启用任何账户 / 未解析到收件箱时返回空结果，避免退化成“全库查询”
  const inbox = resolveInboxFolders(wantIds);
  if (!inbox.accountIds.length || !inbox.folders.length) {
    return ok(res, {
      aiEnabled: activeProvider().ok,
      doneImportant: 0,
      noAccounts: true,
      sections: [
        { key: 'recommend', title: '推荐活动', subtitle: 'AI 判定值得参加：竞赛 / 讲座 / 招募 / 奖学金 / 实习', items: [] },
        { key: 'important', title: '重要邮件', subtitle: '需要处理：缴费 / 注册 / 成绩 / 截止 / 账号安全', items: [] },
        { key: 'upcoming', title: '临近截止', subtitle: '从邮件里识别出的时间（未来 3 周）', items: [] },
        { key: 'unread', title: '未读速览', subtitle: '其他未读邮件（点击预览）', items: [] },
        { key: 'low', title: '低相关邮件', subtitle: '不重要/无实质内容：广告、水印、闲聊等（已读优先）', items: [] },
      ],
    });
  }
  const all = MessageStore.query({
    accountIds: inbox.accountIds, folderIn: inbox.folders, hideDone: true, hidden: false, pageSize: 500,
  }).list;

  const nowMs = Date.now();
  const horizon = nowMs + 21 * 86400 * 1000;

  // 先挑出"没有预存 dates"的邮件，一次性批量取回正文，供缓存提取使用。
  const needBodyIds = [];
  for (const m of all) {
    if (!Array.isArray(m.dates) || !m.dates.length) needBodyIds.push(m.id);
  }
  let bodyMap = null;
  if (needBodyIds.length) {
    try { bodyMap = MessageStore.bodiesByIds(needBodyIds); } catch { bodyMap = null; }
  }
  // 给这批邮件打上正文字段，让 extractDatesCached 直接命中批量结果
  if (bodyMap && bodyMap.size) {
    for (const m of all) {
      const b = bodyMap.get(m.id);
      if (b) { m.bodyLen = (b.bodyText || b.bodyHtml || '').length; m.bodyText = b.bodyText; m.bodyHtml = b.bodyHtml; }
    }
  }

  /** 取该邮件未来的时间点（优先使用已存的 AI/规则识别结果，其次走缓存的正则提取） */
  let liveExtractBudget = 60; // 首屏最多对 60 封做实时规则兜底，避免页面卡顿
  const futureDates = (m) => {
    // 用户主动忽略过的邮件不参与「临近截止」
    if (m.datesIgnored) return [];
    let list = Array.isArray(m.dates) ? m.dates : [];
    if (!list.length && liveExtractBudget > 0) {
      liveExtractBudget--;
      list = extractDatesCached(m, bodyMap);
    }
    return list.filter((d) => d && d.ms > nowMs - 3600 * 1000 && d.ms < horizon).sort((a, b) => a.ms - b.ms);
  };

  const lite = (m, extra = {}) => ({
    id: m.id, subject: m.subject, fromName: m.fromName, fromAddr: m.fromAddr, dateMs: m.dateMs,
    read: m.read, important: m.important, category: m.category, worth: m.worth || 0,
    worthReason: m.worthReason || '', aiSummary: m.aiSummary || '', snippet: m.snippet || '',
    hasAttachments: m.hasAttachments, accountName: m.accountName, accountColor: m.accountColor, ...extra,
  });

  // 生成候选并按优先级唯一归属：重要 > 推荐 > 临近截止 > 未读 > 低相关
  const buckets = { important: [], recommend: [], upcoming: [], unread: [], low: [] };
  const sorted = all.slice().sort((a, b) => ((b.worth || 0) - (a.worth || 0)) || (b.dateMs - a.dateMs));
  for (const m of sorted) {
    const worth = m.worth || 0;
    // 只有“高置信度”或 AI 识别出的时间才算临近截止，避免噪声污染首页
    const ds = futureDates(m).filter(isTrustedDate);
    const extra = ds[0]
      ? { deadlineMs: ds[0].ms, deadlineText: ds[0].title, deadlineType: ds[0].kind, deadlineConfidence: ds[0].confidence || (ds[0].source === 'ai' ? 'ai' : 'medium') }
      : {};
    const isImportant = worth >= 3 || m.important || ['assignment', 'grade', 'system'].includes(m.category);
    const isRecommend = worth >= 2 && !['assignment', 'grade'].includes(m.category);
    if (isImportant) buckets.important.push(lite(m, extra));
    else if (isRecommend) buckets.recommend.push(lite(m, extra));
    else if (ds.length) buckets.upcoming.push(lite(m, extra));
    else if (!m.read) buckets.unread.push(lite(m));
    else buckets.low.push(lite(m));
  }
  const cap = (arr, n) => arr.slice(0, n);
  const doneImportant = MessageStore.query({
    accountIds: inbox.accountIds, doneOnly: true, pageSize: 200,
  }).list.filter((m) => m.important || (m.worth || 0) >= 3).length;

  ok(res, {
    aiEnabled: activeProvider().ok,
    doneImportant,
    sections: [
      { key: 'recommend', title: '推荐活动', subtitle: 'AI 判定值得参加：竞赛 / 讲座 / 招募 / 奖学金 / 实习', items: cap(buckets.recommend, 12) },
      { key: 'important', title: '重要邮件', subtitle: '需要处理：缴费 / 注册 / 成绩 / 截止 / 账号安全', items: cap(buckets.important, 12) },
      { key: 'upcoming', title: '临近截止', subtitle: '从邮件里识别出的时间（未来 3 周）', items: cap(buckets.upcoming, 12) },
      { key: 'unread', title: '未读速览', subtitle: '其他未读邮件（点击预览）', items: cap(buckets.unread, 12) },
      { key: 'low', title: '低相关邮件', subtitle: '不重要/无实质内容：广告、水印、闲聊等（已读优先）', items: cap(buckets.low, 12) },
    ],
  });
});

/** 已处理归档：已标记“已处理”的重要邮件（done 仅本机归档，不改邮箱已读） */
api.get('/home/done', (req, res) => {
  const q = req.query || {};
  const rawA = q.accountId ?? q.account_ids ?? q.accountIds;
  const wantIds = Array.isArray(rawA) ? rawA.filter(Boolean) : String(rawA || '').split(',').filter(Boolean);
  // 无启用账户 → 空结果（不再全库查询）
  const inbox = resolveInboxFolders(wantIds);
  if (!inbox.accountIds.length) return ok(res, { total: 0, items: [], noAccounts: true });
  const r = MessageStore.query({
    accountIds: inbox.accountIds, doneOnly: true, hidden: false,
    includeHidden: req.query.includeHidden === '1', pageSize: 200, sort: 'date', dir: 'desc',
  });
  const items = r.list
    .sort((a, b) => (((b.important ? 1 : 0) - (a.important ? 1 : 0)) || ((b.worth || 0) - (a.worth || 0)) || (b.dateMs - a.dateMs)))
    .map((m) => ({
      id: m.id, subject: m.subject, fromName: m.fromName, fromAddr: m.fromAddr, dateMs: m.dateMs,
      category: m.category, worth: m.worth || 0, worthReason: m.worthReason || '', important: m.important,
      aiSummary: m.aiSummary || '', snippet: m.snippet || '', accountName: m.accountName, doneAt: m.doneAt,
    }));
  ok(res, { total: items.length, items });
});

/** 标记/取消“已阅”（已处理）——已阅邮件会从首页各列隐藏 */
api.post('/messages/:id/done', (req, res) => {
  const id = num(req.params.id);
  const m = MessageStore.get(id);
  if (!m) return fail(res, '邮件不存在', 404);
  const done = req.body?.done !== false;
  MessageStore.update(id, { done, doneAt: done ? Date.now() : 0 });
  ok(res, { id, done });
});

/* ================= 状态（轮询） ================= */
api.get('/status', (req, res) => {
  // 且在每个账户里重复调用 unreadByAccount()——N 个文件夹 = N 次相同的聚合查询。
  // /status 每 10 秒被轮询，账户/文件夹增长后是 O(账户 × 文件夹) 的重复开销。
  const unreadByAcct = new Map(
    MessageStore.unreadByAccount().map((r) => [r.account_id, r.unread || 0]),
  );
  const accounts = AccountStore.list().map((a) => {
    const perFolder = new Map(
      MessageStore.unreadByFolder(a.id).map((r) => [r.folder, r.unread || 0]),
    );
    const folders = FolderStore.list(a.id).map((f) => {
      const un = perFolder.get(f.name) || 0;
      FolderStore.setUnreadLocal(a.id, f.name, un);
      return { name: f.name, unread: un, total: f.total };
    });
    const unreadTotal = unreadByAcct.get(a.id) || 0;
    return { ...sanitizeAccount(a), folders, unreadTotal, syncing: busy.syncing.has(a.id) };
  });
  const catUnread = {};
  for (const c of MessageStore.unreadByCategory()) catUnread[c.category] = c.unread;
  const upcoming = EventStore.upcoming(3);
  // 暴露在途 AI 请求，便于前端提示与验证脚本断言
  ok(res, { accounts, catUnread, upcomingEvents: upcoming, serverTime: now(), aiInFlight: aiInFlightSnapshot() });
});

/* ================= 附件 ================= */
api.get('/attachments', (req, res) => {
  const q = req.query || {};
  const s = getSettings();
  const opts = {
    accountIds: q.accountId ? String(q.accountId).split(',') : [],
    q: q.q ? str(q.q) : '',
    mimeGroups: q.group ? String(q.group).split(',') : [],
    minSize: q.minSize ? num(q.minSize, null) : null,
    dateFrom: q.fromDate ? num(q.fromDate, null) : null,
    dateTo: q.toDate ? num(q.toDate, null) : null,
    page: clampInt(q.page, 0, 0, 100000),
    pageSize: clampInt(q.pageSize, 48, 1, 200),
    dir: q.dir ? str(q.dir) : 'desc',
    sort: q.sort ? str(q.sort) : 'createdAt',
    // 可在设置里关掉“自动把杂项移出主列表”
    includeJunk: q.includeJunk === '1' || q.includeJunk === 'true' || s.junkHideAuto === false,
  };
  const result = AttachmentStore.list(opts);
  ok(res, result);
});

api.get('/attachments/groups', (req, res) => {
  const q = req.query || {};
  const accountIds = q.accountId ? String(q.accountId).split(',') : [];
  const st = AttachmentStore.stats({ accountIds });
  ok(res, { groups: st.groups, junk: st.junk, clean: st.clean, total: st.total, accountIds });
});

/** 逐条改判“杂项”（junk=false 表示这条其实不是杂项；junk=null 恢复自动判定） */
api.post('/attachments/:id/junk', (req, res) => {
  const att = AttachmentStore.get(req.params.id);
  if (!att) return fail(res, '附件不存在', 404);
  const body = req.body || {};
  const raw = body.junk;
  const value = raw === null || raw === undefined || raw === 'auto' ? null : !!raw;
  const next = AttachmentStore.setJunkOverride(att.id, value);
  ok(res, { attachment: next });
});

api.get('/attachments/:id/download', (req, res) => sendAttach(req, res, 'attachment'));
api.get('/attachments/:id/inline', (req, res) => sendAttach(req, res, 'inline'));

function sendAttach(req, res, mode) {
  const att = AttachmentStore.get(req.params.id);
  if (!att) return fail(res, '附件不存在', 404);
  const rel = att.row.stored;
  if (!rel) {
    // 邮件正文尚未抓取 → 触发抓取后重试（前端可轮询）
    return fail(res, '该附件所在邮件尚未下载正文，请先打开邮件', 409);
  }
  const abs = path.join(ATTACH_DIR, path.basename(rel));
  if (!fs.existsSync(abs)) return fail(res, '附件文件缺失', 404);
  const isInlineable = /^(image\/|text\/|application\/pdf|application\/json|application\/xml|application\/javascript|text\/calendar)/.test(att.mime) || mimeGroup(att.mime) === 'text';
  const dispo = mode === 'inline' && isInlineable ? 'inline' : 'attachment';
  const filename = encodeURIComponent(att.filename || 'file');
  res.setHeader('Content-Type', att.mime || 'application/octet-stream');
  res.setHeader('Content-Disposition', `${dispo}; filename*=UTF-8''${filename}`);
  fs.createReadStream(abs).pipe(res);
}

api.post('/attachments/:id/save', (req, res) => {
  const att = AttachmentStore.get(req.params.id);
  if (!att) return fail(res, '附件不存在', 404);
  const rel = att.row.stored;
  if (!rel) return fail(res, '附件文件尚未下载', 409);
  const src = path.join(ATTACH_DIR, path.basename(rel));
  if (!fs.existsSync(src)) return fail(res, '附件文件缺失', 404);
  const s = getSettings();
  const requested = (req.body && req.body.dir) || s.attachmentSaveDir || SAVED_DIR;

  // 保存目录必须落在白名单前缀内。
  // 任何同源页面都能借该接口把文件写到任意可写路径（实测曾成功写入 C:\Windows\Temp）。
  // 修法：resolve 成绝对路径后再做前缀比较（必须先 resolve，否则 ../ 可绕过字符串比较）。
  const allowed = saveDirWhitelist(s);
  const resolvedDir = resolveSaveDir(requested, allowed);
  if (!resolvedDir) {
    logger.warn('api', `拒绝越界的附件保存目录：${requested}`);
    return fail(res, '保存目录不在允许范围内（仅允许设置中的保存目录及其子目录）', 403);
  }

  try {
    fs.mkdirSync(resolvedDir, { recursive: true });
    const baseName = safeLocalName(att.filename || `attachment-${att.id}`);
    //（含用户自己编辑过的版本），属不可逆数据丢失。改为自动编号保存。
    let dest = uniqueSavePath(resolvedDir, baseName);
    for (let attempt = 0; ; attempt++) {
      try {
        // COPYFILE_EXCL：目标已存在则报错，避免 existsSync 与写入之间的竞态
        fs.copyFileSync(src, dest, fs.constants.COPYFILE_EXCL);
        break;
      } catch (e) {
        if (e.code !== 'EEXIST' || attempt >= 50) throw e;
        dest = uniqueSavePath(resolvedDir, baseName);
      }
    }
    // 仅在目录通过白名单校验后才打开资源管理器，避免"打开任意目录"被滥用
    if (s.autoOpenFolderAfterSave) {
      try { execFile('explorer.exe', [resolvedDir]); } catch { /* 忽略 */ }
    }
    ok(res, { savedTo: dest, renamed: path.basename(dest) !== baseName });
  } catch (e) {
    fail(res, `保存失败：${e.message}`, 500);
  }
});

/**
 * 在目标目录里为同名附件找一个不冲突的文件名（`名称 (1).ext`、`名称 (2).ext`…）。
 * 只做"建议路径"，真正的排他写入由调用方的 COPYFILE_EXCL 保证。
 */
function uniqueSavePath(dir, name) {
  const ext = path.extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  for (let i = 0; i < 1000; i++) {
    const candidate = path.join(dir, i === 0 ? name : `${stem} (${i})${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  return path.join(dir, `${stem}-${Date.now()}${ext}`);
}

/** 附件保存的可写根目录白名单（去重 + 解析为绝对路径） */
function saveDirWhitelist(s) {
  const roots = [s.attachmentSaveDir, SAVED_DIR, ATTACH_DIR].filter(Boolean).map((d) => path.resolve(String(d)));
  return [...new Set(roots)];
}

/**
 * 把候选目录解析为绝对路径并校验落在白名单内。
 * 通过返回 resolve 后的绝对路径，不通过返回 null。
 * 用 path.relative 判断包含关系（比字符串 startsWith 更可靠，能正确处理
 * 大小写差异、路径分隔符差异，以及 "C:\data" vs "C:\database" 这类前缀误判）。
 */
function resolveSaveDir(candidate, allowedRoots) {
  const abs = path.resolve(String(candidate));
  for (const root of allowedRoots) {
    const rel = path.relative(root, abs);
    // rel 为空表示就是 root 本身；不以 .. 开头且非绝对路径表示是 root 的子目录
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return abs;
  }
  return null;
}

function safeLocalName(n) {
  return String(n || 'file').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 180) || 'file';
}

/* ================= 日历事件 ================= */
api.get('/events', (req, res) => {
  const start = num(req.query.start, 0);
  const end = num(req.query.end, now() + 3 * 30 * 86400000);
  ok(res, { events: EventStore.list(start, end) });
});
/** 事件时间规范化：先 coerce 再校验，非法值报错而不是落库成 1970/负数 */
function normalizeEventTimes(b, base = {}) {
  const rawStart = b.startMs ?? base.startMs;
  const startMs = Number(rawStart);
  if (!Number.isFinite(startMs)) return { error: '开始时间不是有效数字' };
  // 区间限制在 2000–2100 年，避免误输入（0 会落库成 1970）
  if (startMs < Date.UTC(2000, 0, 1) || startMs > Date.UTC(2100, 0, 1)) return { error: '开始时间超出合理范围（2000–2100 年）' };
  const rawEnd = b.endMs ?? base.endMs;
  const endMs = rawEnd == null ? startMs + 3600000 : Number(rawEnd);
  if (!Number.isFinite(endMs)) return { error: '结束时间不是有效数字' };
  if (endMs < startMs) return { error: '结束时间不能早于开始时间' };
  return { startMs, endMs };
}

api.post('/events', (req, res) => {
  const b = req.body || {};
  if (!b.title) return fail(res, '请填写标题');
  if (b.startMs == null || b.startMs === '') return fail(res, '缺少开始时间');
  const t = normalizeEventTimes(b);
  if (t.error) return fail(res, t.error);
  const id = EventStore.insert({
    id: uid(), title: str(b.title), startMs: t.startMs, endMs: t.endMs,
    allDay: !!b.allDay, source: b.source || 'manual', messageId: num(b.messageId, 0),
    note: str(b.note), color: str(b.color, '#e07b39'),
    remindOffsets: Array.isArray(b.remindOffsets) ? b.remindOffsets : [],
  });
  ok(res, { event: EventStore.get(id) }, 201);
});
api.put('/events/:id', (req, res) => {
  const ev = EventStore.get(req.params.id);
  if (!ev) return fail(res, '事件不存在', 404);
  const b = req.body || {};
  const t = normalizeEventTimes(b, ev);
  if (t.error) return fail(res, t.error);
  EventStore.update(ev.id, {
    title: b.title ?? ev.title, startMs: t.startMs, endMs: t.endMs,
    allDay: b.allDay ?? ev.allDay, note: b.note ?? ev.note, color: b.color ?? ev.color,
    remindOffsets: b.remindOffsets ?? ev.remindOffsets, messageId: b.messageId ?? ev.messageId,
  });
  ok(res, { event: EventStore.get(ev.id) });
});
api.delete('/events/:id', (req, res) => {
  // 与 /accounts、/messages 保持一致，删除不存在的事件返回 404
  const ev = EventStore.get(req.params.id);
  if (!ev) return fail(res, '事件不存在', 404);
  EventStore.remove(ev.id);
  ok(res, { removed: true });
});

/** 智能日历：把邮件中识别到的截止/考试/活动时间一键安排进内置日历（自动去重、限量） */
api.post('/calendar/auto-from-mail', (req, res) => {
  const b = req.body || {};
  const days = Math.min(Math.max(num(b.days, 21), 1), 120);
  const limit = Math.min(Math.max(num(b.limit, 30), 1), 80);
  const rawA = b.accountId ?? b.accountIds;
  const wantIds = Array.isArray(rawA) ? rawA.filter(Boolean) : String(rawA || '').split(',').filter(Boolean);
  // 无启用账户 → 不安排任何事件
  const inbox = resolveInboxFolders(wantIds);
  if (!inbox.accountIds.length) return ok(res, { created: 0, skipped: 0, candidates: 0, events: [], noAccounts: true });
  const nowMs = Date.now();
  const horizon = nowMs + days * 86400000;
  const msgs = MessageStore.query({ accountIds: inbox.accountIds, folderIn: inbox.folders, pageSize: 500 }).list;
  const existing = new Set(
    EventStore.list(nowMs - 86400000, horizon + 86400000)
      .filter((e) => e.messageId)
      .map((e) => `${e.messageId}|${Math.round(e.startMs / 3600000)}`),
  );

  // 只考虑“值得关注”的邮件：未处理、非营销/垃圾，且（有价值分或未读）
  const candidates = [];
  let skipped = 0;
  for (const m of msgs) {
    if (m.done) continue;
    if (['promo', 'spam'].includes(m.category)) continue;
    if (!((m.worth || 0) >= 2 || !m.read)) continue;
    // 用户主动忽略过的邮件不再被自动排入日历
    if (m.datesIgnored) continue;
    let list = Array.isArray(m.dates) ? m.dates : [];
    if (!list.length) {
      // 复用日期提取缓存。这里一次可扫 500 封，原先逐封 detail()+正则
      // 是无缓存的重活；走缓存后与 /home 共享结果，二次触发近乎零成本。
      list = extractDatesCached(m, null);
    }
    const picked = list
      .filter((d) => d && d.ms && d.ms > nowMs - 3600000 && d.ms <= horizon)
      // 只安排高置信度（AI 识别或“截止/考试词紧邻日期”）的时间，避免日历被噪声塞满
      .filter(isTrustedDate)
      .sort((x, y) => x.ms - y.ms)
      .slice(0, 2); // 每封最多 2 个时间，避免刷屏
    for (const d of picked) {
      const key = `${m.id}|${Math.round(d.ms / 3600000)}`;
      if (existing.has(key)) { skipped++; continue; }
      candidates.push({ m, d, key });
    }
  }
  candidates.sort((x, y) => x.d.ms - y.d.ms);

  let created = 0;
  const createdList = [];
  for (const c of candidates) {
    if (created >= limit) break;
    const { m, d, key } = c;
    existing.add(key);
    const kind = d.kind || 'event';
    const color = kind === 'deadline' ? '#ef4444' : (kind === 'exam' ? '#8b5cf6' : '#10b981');
    const title = String(d.title || m.subject || '邮件日程').slice(0, 40);
    const id = EventStore.insert({
      id: uid(), title, startMs: d.ms, endMs: d.ms + 3600000, allDay: false, source: 'auto',
      messageId: m.id, note: `来自邮件「${String(m.subject || '').slice(0, 60)}」\n识别片段：${String(d.title || '').slice(0, 80)}`,
      color, remindOffsets: [-1440],
    });
    created++;
    createdList.push({ id, messageId: m.id, title, startMs: d.ms, kind });
  }
  logger.info('api', `智能日历：从邮件安排 ${created} 个事件（跳过已存在 ${skipped}，候选 ${candidates.length}）`);
  ok(res, { created, skipped, candidates: candidates.length, events: createdList.slice(0, 60) });
});
api.get('/reminders', (req, res) => {
  const events = EventStore.all().map((ev) => ({
    ...ev,
    reminders: (ev.remindOffsets || []).map((off) => ({ dueMs: ev.startMs + Number(off) * 60000, offsetMin: Number(off) })),
  }));
  ok(res, { events });
});

/* ================= 规则 ================= */
api.get('/rules', (req, res) => ok(res, { rules: RuleStore.list() }));
api.post('/rules', (req, res) => {
  const id = RuleStore.save(req.body || {});
  ok(res, { rule: RuleStore.get(id) }, 201);
});
api.put('/rules/:id', (req, res) => {
  const r = RuleStore.get(req.params.id);
  if (!r) return fail(res, '规则不存在', 404);
  RuleStore.save({ ...r, ...(req.body || {}) });
  ok(res, { rule: RuleStore.get(req.params.id) });
});
api.delete('/rules/:id', (req, res) => {
  RuleStore.remove(req.params.id);
  ok(res, { removed: true });
});
api.post('/rules/apply', (req, res) => {
  const accountId = req.body?.accountId;
  if (accountId) {
    const r = applyRulesToHydrated(accountId);
    return ok(res, r);
  }
  const accounts = AccountStore.list().filter((a) => a.enabled);
  let scanned = 0; let changed = 0;
  for (const a of accounts) {
    const r = applyRulesToHydrated(a.id);
    scanned += r.scanned; changed += r.changed;
  }
  ok(res, { scanned, changed });
});
/** 单封预览规则命中效果 */
api.post('/messages/:id/rules-preview', (req, res) => {
  const m = MessageStore.detail(num(req.params.id));
  if (!m) return fail(res, '邮件不存在', 404);
  const rules = RuleStore.list();
  const eff = applyRules(m, rules);
  ok(res, { effects: eff });
});

/* ================= AI ================= */
api.get('/ai/config', (req, res) => {
  const s = getSettings();
  ok(res, { ai: sanitizeAi(s.ai), enabled: !!s.ai.enabled });
});
api.put('/ai/config', (req, res) => {
  const patch = req.body || {};
  const cur = getSettings().ai || {};
  const next = JSON.parse(JSON.stringify(cur));
  const notices = [];
  if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled;
  if (patch.active) next.active = patch.active;
  if (typeof patch.autoClassify === 'boolean') next.autoClassify = patch.autoClassify;
  if (typeof patch.autoSummarize === 'boolean') next.autoSummarize = patch.autoSummarize;

  // 恢复内置服务商（保留已填写的 Key）
  if (patch.resetProviders) {
    const defaults = JSON.parse(JSON.stringify(DEFAULT_SETTINGS.ai.providers || {}));
    for (const [k, p] of Object.entries(defaults)) {
      if (next.providers[k] && next.providers[k].apiKey) p.apiKey = next.providers[k].apiKey;
    }
    next.providers = defaults;
    if (!next.providers[next.active]) next.active = Object.keys(next.providers)[0] || '';
  }

  if (patch.providers) {
    for (const [k, p] of Object.entries(patch.providers)) {
      // 传 null 表示删除该服务商模块
      if (p === null) { delete next.providers[k]; continue; }
      // 允许新增任意 OpenAI 兼容服务商（如自建网关），也允许覆盖预设
      const base = next.providers[k] || {};
      const np = { ...base, ...p };
      if (p.clearApiKey) np.apiKey = '';
      else if (p.apiKey === MASK || !p.apiKey) np.apiKey = base.apiKey || '';
      else np.apiKey = p.apiKey;
      delete np.clearApiKey;
      if (!np.label) np.label = k;
      if (!np.baseUrl) np.baseUrl = '';
      if (!np.model) np.model = '';
      // 密钥已由 .env 托管时，不把明文写回数据库（.env 优先级更高，写库只会造成两处不一致）
      if (isKeyFromEnv(k)) {
        if (String(np.apiKey || '').trim()) {
          notices.push(`服务商「${k}」的密钥由 .env 提供，本次输入未保存到数据库；如需更换请修改 server/.env 后重启。`);
        }
        np.apiKey = '';
      } else {
        // 顺手把 " " 这类纯空白归一为空，避免被判定成「已配置」
        np.apiKey = String(np.apiKey == null ? '' : np.apiKey).trim();
      }
      next.providers[k] = np;
    }
  }
  // 当前服务商被删除时，自动落到剩余的第一个
  if (!next.providers[next.active]) next.active = Object.keys(next.providers)[0] || '';
  if (!Object.keys(next.providers).length) next.enabled = false;
  updateSettings({ ai: next });
  ok(res, { ai: sanitizeAi(next), notices });
});
api.post('/ai/test', async (req, res) => {
  try {
    const provider = req.body?.provider;
    const r = await testProvider(provider || activeProvider().name || 'deepseek');
    ok(res, r);
  } catch (e) {
    ok(res, { ok: false, error: e.message });
  }
});

/** 获取该服务商的可用模型列表（OpenAI 兼容 GET /models） */
api.post('/ai/models', async (req, res) => {
  try {
    const b = req.body || {};
    const s = getSettings();
    let baseUrl = str(b.baseUrl);
    let apiKey = str(b.apiKey);
    if ((!baseUrl || !apiKey) && b.provider) {
      const p = (s.ai?.providers || {})[b.provider];
      // 密钥同样走 .env 优先、数据库兜底的解析
      if (p) { baseUrl = baseUrl || p.baseUrl; apiKey = apiKey || resolveApiKey(b.provider, p.apiKey).key; }
    }
    if (!baseUrl) return fail(res, '缺少 Base URL');
    const url = `${String(baseUrl).replace(/\/+$/, '')}/models`;
    const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
    if (!r.ok) {
      let d = '';
      try { d = (await r.text()).slice(0, 200); } catch { /* */ }
      return ok(res, { ok: false, error: `HTTP ${r.status} ${d}`, models: [] });
    }
    const data = await r.json().catch(() => null);
    const ids = (data?.data || data?.models || [])
      .map((m) => (typeof m === 'string' ? m : (m?.id || m?.name || '')))
      .filter(Boolean).sort();
    ok(res, { ok: true, models: ids.slice(0, 300), count: ids.length });
  } catch (e) {
    ok(res, { ok: false, error: e.message, models: [] });
  }
});

/** AI 助手对话：可附带选中邮件作为上下文；未配置 AI 时降级为本地邮件检索 */
api.post('/ai/chat', async (req, res) => {
  const b = req.body || {};
  const history = (Array.isArray(b.messages) ? b.messages : [])
    .slice(-12)
    .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '').slice(0, 4000) }))
    .filter((m) => m.content.trim());
  const question = (history[history.length - 1]?.content || '').trim();
  const emailIds = Array.isArray(b.emailIds) ? [...new Set(b.emailIds.map(Number).filter(Boolean))].slice(0, 5) : [];
  const scope = ['selected', 'auto', 'unread'].includes(b.scope) ? b.scope : (emailIds.length ? 'selected' : 'auto');
  const p = activeProvider();

  const tokens = (question.match(/[\u4e00-\u9fff]{2,}|[A-Za-z0-9_-]{3,}/g) || []).slice(0, 3);
  const unreadOnly = /未读|新的|新邮件/.test(question);

  /** 选出要送给 AI 的邮件（可压缩） */
  const pickMails = () => {
    if (scope === 'selected' && emailIds.length) return emailIds.map((id) => MessageStore.detail(id)).filter(Boolean);
    if (scope === 'unread') return MessageStore.query({ unreadOnly: true, pageSize: 6 }).list;
    const r = MessageStore.query({ q: tokens[0] || '', bodyQ: tokens[1] || tokens[0] || '', unreadOnly, pageSize: 6 });
    if (r.list.length) return r.list.map((m) => MessageStore.detail(m.id) || m);
    const u = MessageStore.query({ unreadOnly: true, pageSize: 5 }).list;
    return (u.length ? u : MessageStore.query({ pageSize: 5 }).list).map((m) => MessageStore.detail(m.id) || m);
  };

  /** 压缩邮件内容为可发送给 AI 的上下文（正文截断 + 总量限制） */
  const buildContext = (mails) => {
    const perMail = mails.length <= 3 ? 1200 : 800;
    const parts = mails.map((m) => {
      const body = (m.bodyText || stripHtml(m.bodyHtml) || m.snippet || '').replace(/\s+/g, ' ').trim();
      return `【邮件#${m.id}】主题：${String(m.subject || '(无主题)').slice(0, 120)}\n`
        + `发件人：${m.fromName || m.fromAddr}\n时间：${new Date(m.dateMs).toLocaleString('zh-CN')}｜分类：${catLabel(m.category)}\n`
        + `AI摘要：${(m.aiSummary || '').slice(0, 120)}\n正文摘要：${body.slice(0, perMail)}`;
    });
    let ctx = parts.join('\n\n----------\n\n');
    if (ctx.length > 6000) ctx = ctx.slice(0, 6000) + '\n…（上下文已按长度截断）';
    return ctx;
  };

  const mails = pickMails();
  const sources = mails.map((m) => ({ id: m.id, subject: m.subject, fromName: m.fromName || m.fromAddr, dateMs: m.dateMs, category: m.category }));

  if (!p.ok) {
    // 降级：把问题当关键词做本地邮件检索
    const r = tokens.length
      ? MessageStore.query({ q: tokens[0], bodyQ: tokens[1] || tokens[0], unreadOnly, pageSize: 8 })
      : MessageStore.query({ unreadOnly: true, pageSize: 8 });
    return ok(res, {
      mode: 'search',
      reply: r.total
        ? `当前未启用 AI（或未配置有效 Key），已改为在本地邮件中检索到 ${r.total} 封相关邮件：`
        : '当前未启用 AI，且本地邮件中没有检索到相关内容。可在「设置 → AI 智能」配置 Key 后与邮件对话。',
      results: r.list.map((m) => ({
        id: m.id, subject: m.subject, fromName: m.fromName || m.fromAddr, dateMs: m.dateMs,
        category: m.category, accountName: m.accountName, snippet: m.aiSummary || m.snippet,
      })),
      sources,
      note: '提示：配置任意 OpenAI 兼容服务商后，这里会变成真正的 AI 邮件助手（可直接读邮件内容）。',
    });
  }

  const ctx = buildContext(mails);
  const system = `你是嵌入在学生邮件查看器里的邮箱助手，可以读取用户邮件内容（下面是压缩后的邮件正文）。用中文回答，简洁、可执行；总结/提取待办/截止时间时输出条目列表，点明关键日期与发件人，并引用邮件编号（如 #123）。信息不足时请说明缺什么，不要编造。

本次可用邮件（共 ${mails.length} 封，正文已压缩截断）：
${ctx || '（当前没有可用邮件）'}`;

  try {
    const reply = await chat([{ role: 'system', content: system }, ...history], { maxTokens: 1500, temperature: 0.3 });
    ok(res, { mode: 'ai', reply: String(reply).trim(), engine: p.model, sources, scope, usedMails: mails.length });
  } catch (e) {
    ok(res, { mode: 'error', error: e.message, sources });
  }
});
api.post('/ai/classify', wrap(async (req, res) => {
  const accountId = req.body?.accountId;
  // 整批分类加全局在途锁——批处理耗时长，重复触发的代价最高
  if (!claimAi('ai-classify', accountId || '*')) return fail(res, '批量分类正在进行中，请稍候', 429);
  try {
    const accounts = accountId ? [accountId] : AccountStore.list().filter((a) => a.enabled).map((a) => a.id);
    let total = 0;
    const details = [];
    for (const aid of accounts) {
      const need = MessageStore.uncategorized(aid, 30);
      if (!need.length) continue;
      const out = await aiClassifyBatch(need, { save: true });
      total += out.length; details.push(...out);
    }
    ok(res, { classified: total, details: details.slice(0, 40) });
  } finally {
    releaseAi('ai-classify', accountId || '*');
  }
}));
api.get('/ai/status', (req, res) => {
  const p = activeProvider();
  const pending = {};
  for (const a of AccountStore.list().filter((x) => x.enabled)) {
    pending[a.id] = MessageStore.uncategorized(a.id, 1).length ? MessageStore.query({ accountIds: [a.id], bodyFetched: true, pageSize: 200 }).list.filter((m) => !m.aiAttempted).length : 0;
  }
  ok(res, { provider: p, pending, busyClassifying: busy.classifying });
});

/* ================= 设置 ================= */
/** 可写的标量设置白名单 + 类型/范围校验，避免 "abc" 之类垃圾值落库后静默关掉功能 */
const SETTINGS_SPEC = {
  port: { type: 'int', min: 1024, max: 65535 },
  syncIntervalMin: { type: 'int', min: 0, max: 1440 },
  showDrafts: { type: 'bool' },
  initialSyncDays: { type: 'int', min: 1, max: 3650 },
  hydrateNewLimit: { type: 'int', min: 0, max: 500 },
  attachmentCapMB: { type: 'int', min: 0, max: 100000 },
  attachmentSort: { type: 'enum', values: ['createdAt', 'size', 'name'] },
  attachmentSortDir: { type: 'enum', values: ['asc', 'desc'] },
  autoStart: { type: 'bool' },
  newMailNotify: { type: 'bool' },
  markReadOnOpen: { type: 'bool' },          // 打开邮件是否自动标记已读
  junkHideAuto: { type: 'bool' },            // 是否自动把“杂项附件”移出主列表
  theme: { type: 'enum', values: ['light', 'dark', 'system'] },
  attachmentSaveDir: { type: 'string', maxLen: 512 },
  autoOpenFolderAfterSave: { type: 'bool' },
  digest: null,                              // 下面单独校验
};

function validateSetting(key, value) {
  const spec = SETTINGS_SPEC[key];
  if (spec === undefined) return { error: `未知的设置项：${key}` };
  if (spec === null) return { ok: true, value };   // 复合项另行处理
  switch (spec.type) {
    case 'bool':
      if (typeof value !== 'boolean') return { error: `${key} 需要布尔值` };
      return { ok: true, value };
    case 'int': {
      const n = Number(value);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n < spec.min || n > spec.max) {
        return { error: `${key} 需要 ${spec.min}–${spec.max} 之间的整数` };
      }
      return { ok: true, value: n };
    }
    case 'enum':
      if (!spec.values.includes(value)) return { error: `${key} 只能是 ${spec.values.join(' / ')}` };
      return { ok: true, value };
    case 'string':
      if (typeof value !== 'string' || value.length > spec.maxLen) return { error: `${key} 需要不超过 ${spec.maxLen} 字符的文本` };
      return { ok: true, value };
    default:
      return { error: `无法校验的设置项：${key}` };
  }
}

function validateDigest(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { error: 'digest 需要对象' };
  const out = {};
  if (v.enabled != null) {
    if (typeof v.enabled !== 'boolean') return { error: 'digest.enabled 需要布尔值' };
    out.enabled = v.enabled;
  }
  if (v.time != null) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(v.time))) return { error: 'digest.time 需要 HH:MM 格式' };
    out.time = String(v.time);
  }
  if (v.windowHours != null) {
    const n = Number(v.windowHours);
    if (![12, 24, 30, 48, 72].includes(n)) return { error: 'digest.windowHours 只能是 12/24/30/48/72' };
    out.windowHours = n;
  }
  if (v.importantCategories != null) {
    if (!Array.isArray(v.importantCategories) || v.importantCategories.some((c) => typeof c !== 'string')) {
      return { error: 'digest.importantCategories 需要字符串数组' };
    }
    out.importantCategories = v.importantCategories;
  }
  return { ok: true, value: out };
}

api.get('/settings', (req, res) => {
  const s = getSettings();
  const out = { ...s };
  out.ai = sanitizeAi(out.ai);
  ok(res, { settings: out, dataDir: DATA_DIR, savedDir: SAVED_DIR });
});
api.put('/settings', async (req, res) => {
  const patch = req.body || {};
  const clean = {};
  const rejected = [];
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'ai') continue; // 走 /ai/config，避免密钥被误覆盖
    if (k === 'digest') {
      const r = validateDigest(v);
      if (r.error) { rejected.push(r.error); continue; }
      clean.digest = r.value;
      continue;
    }
    const r = validateSetting(k, v);
    if (r.error) { rejected.push(r.error); continue; }
    clean[k] = r.value;
  }
  if (!Object.keys(clean).length) {
    return fail(res, rejected.length ? rejected.join('；') : '没有可保存的设置项');
  }
  const next = updateSettings(clean);
  // 开机自启开关变化 → 立即应用到注册表
  if (typeof patch.autoStart === 'boolean') {
    try { await applyAutoStart(patch.autoStart); } catch (e) { logger.warn('api', `应用开机自启失败：${e.message}`); }
  }
  ok(res, { settings: { ...next, ai: sanitizeAi(next.ai) }, rejected });
});

/* ================= 开机自启 ================= */
api.get('/autostart', async (req, res) => {
  const s = getSettings();
  const st = await autoStartStatus(s.autoStart);
  ok(res, st);
});
api.put('/autostart', async (req, res) => {
  const enabled = !!req.body?.enabled;
  updateSettings({ autoStart: enabled });
  const r = await applyAutoStart(enabled);
  const st = await autoStartStatus(enabled);
  ok(res, { ...st, applyResult: r });
});
api.post('/settings/save-dir-test', (req, res) => {
  const dir = str(req.body?.dir);
  if (!dir) return fail(res, '目录为空');
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, '.mailview-write-test');
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    ok(res, { writable: true });
  } catch (e) {
    fail(res, `目录不可写：${e.message}`);
  }
});

/* ================= 每日汇总 ================= */
api.get('/digest/latest', (req, res) => {
  const dg = SettingsStore.get('last_digest', null);
  ok(res, { digest: dg });
});
api.post('/digest/ack', (req, res) => {
  const dg = SettingsStore.get('last_digest', null);
  if (dg) { dg.read = true; SettingsStore.set('last_digest', dg); }
  ok(res, { ack: true });
});
api.post('/digest/now', (req, res) => {
  const digest = composeDigest({ force: true });
  ok(res, { digest: digest || SettingsStore.get('last_digest', null) });
});
api.post('/digest/reset', (req, res) => {
  busy.digestRunDate = '';
  SettingsStore.set('last_digest', null);
  ok(res, { reset: true });
});

/* ================= 通知 ================= */
api.get('/notifications', (req, res) => {
  const list = SettingsStore.get('pending_notifications', []) || [];
  const dg = SettingsStore.get('last_digest', null);
  ok(res, { notifications: list, digest: dg && !dg.read ? dg : null });
});
api.post('/notifications/ack', (req, res) => {
  const id = req.body?.id;
  const list = SettingsStore.get('pending_notifications', []) || [];
  const next = id ? list.filter((n) => n.id !== id) : [];
  SettingsStore.set('pending_notifications', next);
  ok(res, { remaining: next.length });
});
/** 标记通知“已弹出系统通知”（保留在铃铛列表中） */
api.post('/notifications/seen', (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : (req.body?.id ? [req.body.id] : []);
  const list = SettingsStore.get('pending_notifications', []) || [];
  let changed = 0;
  const next = list.map((n) => {
    if (ids.length && ids.includes(n.id) && !n.seen) { changed++; return { ...n, seen: true }; }
    return n;
  });
  SettingsStore.set('pending_notifications', next);
  ok(res, { changed, remaining: next.length });
});

/* ================= 存储 / 日志 ================= */
api.get('/storage', (req, res) => {
  const s = getSettings();
  let used = 0; let files = 0;
  try {
    for (const fn of fs.readdirSync(ATTACH_DIR)) {
      const p = path.join(ATTACH_DIR, fn);
      try { const st = fs.statSync(p); if (st.isFile()) { used += st.size; files++; } } catch { /* */ }
    }
  } catch { /* */ }
  ok(res, { used, files, capMB: s.attachmentCapMB, capBytes: (Number(s.attachmentCapMB) || 400) * 1048576, saveDir: s.attachmentSaveDir || SAVED_DIR });
});
api.post('/storage/purge-cache', (req, res) => {
  const removed = purgeAttachmentCache();
  ok(res, { removed, note: '附件缓存已清空；打开相关邮件时会重新抓取' });
});
api.get('/logs', (req, res) => {
  try {
    // 改用 clampInt——原先的 num() 不夹取，tail=999999999 会把整个日志文件读进内存返回
    const n = clampInt(req.query.tail, 120, 1, 2000);
    const content = fs.readFileSync(LOG_FILE, 'utf8').split('\n').slice(-n).join('\n');
    ok(res, { logs: content });
  } catch {
    ok(res, { logs: '' });
  }
});
api.get('/system', (req, res) => {
  ok(res, { version: '0.1.0', dataDir: DATA_DIR, uptime: process.uptime(), pid: process.pid });
});

/* 未知 /api 路由统一返回 JSON 404（而不是 Express 的 HTML "Cannot GET /api/xxx"） */
api.use((req, res) => {
  fail(res, `接口不存在：${req.method} /api${req.path === '/' ? '' : req.path}`, 404);
});

/**
 * 统一错误中间件（必须四个参数，且必须放在所有路由与 404 兜底之后）。
 * 作用是兜住 wrap() 转交过来的 async rejection，以及同步路由里被 next(err) 抛出的异常。
 * 若没有它，这些错误会冒泡到 Express 默认处理器：开发环境返回 HTML 堆栈、生产环境静默 500，
 * 且日志里看不到任何线索。这里统一：写日志（含堆栈与请求上下文）→ 返回结构化 JSON。
 */
api.use((err, req, res, next) => {
  const detail = err?.stack || err?.message || String(err);
  logger.error('api', `未捕获异常 ${req.method} /api${req.path}：${detail}`);
  if (res.headersSent) return next(err);   // 响应已开始发送，只能交给 Express 收尾（否则二次写入会崩）
  fail(res, `服务器内部错误：${err?.message || '未知错误'}`, 500);
});
