// 后台服务：定时同步 / 正文预取 / AI 分类 / 每日汇总 / 到期提醒 / 附件清理
import fs from 'node:fs';
import path from 'node:path';
import { logger, ATTACH_DIR } from './logger.js';
import { AccountStore, MessageStore, EventStore, SettingsStore, AttachmentStore, run } from './store.js';
import { getSettings, catLabel } from './settings.js';
import { autoStartStatus, applyAutoStart } from './autostart.js';
import { syncAccount } from './imap.js';
import { hydrateByUid } from './hydrate.js';
import { aiClassifyBatch, activeProvider, localWorth } from './ai.js';
import { extractFromMessage } from './nlp.js';
import { resolveInboxFolders } from './mailboxes.js';
import { uid, now } from './util.js';

export const busy = { syncing: new Set(), hydrating: false, classifying: false, digestRunDate: '', lastCleanup: 0 };
export const lastActivity = { syncAt: {}, hydrateAt: 0, classifyAt: 0, digestAt: 0 };

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/* ---------- 新邮件到件通知（通知中心 + 前端系统通知） ---------- */
export function pushNewMailNotice(account, newCount, { firstSync = false } = {}) {
  const s = getSettings();
  if (!s.newMailNotify) return null;
  if (!newCount || newCount <= 0) return null;
  // 通知预览只取该账户「收件箱」里的邮件：
  // 此前不带 folder 过滤，会把已归档/已移动/已删除的旧邮件也算进来，
  // 导致预览条目与"刚收到"的语义不符（Outlook 桌面账户的收件箱还是 \账号\Inbox 这类路径）。
  const inbox = resolveInboxFolders([account.id]);
  const scope = inbox.folders.length ? { folderIn: inbox.folders } : {};
  const rows = MessageStore.query({ accountIds: [account.id], ...scope, unreadOnly: true, pageSize: 3 }).list;
  const fallback = rows.length ? rows : MessageStore.query({ accountIds: [account.id], ...scope, pageSize: 3 }).list;
  const items = fallback.slice(0, 3).map((m) => ({
    id: m.id, subject: m.subject, fromName: m.fromName || m.fromAddr, dateMs: m.dateMs,
  }));
  const notice = {
    id: uid(), type: 'newmail', seen: false, at: now(),
    accountId: account.id, accountName: account.name,
    count: newCount, firstSync, items,
    title: firstSync ? `已完成首次同步：${account.name}` : `${account.name} 收到 ${newCount} 封新邮件`,
    body: items[0] ? `最新：${items[0].fromName} — ${items[0].subject || '(无主题)'}` : '',
  };
  const list = (SettingsStore.get('pending_notifications', []) || []);
  SettingsStore.set('pending_notifications', [...list, notice].slice(-80));
  logger.info('svc', `新邮件通知：${account.name} ${newCount} 封`);
  return notice;
}

/* ---------- 周期自动同步 ---------- */
export async function runAutoSync() {
  const accounts = AccountStore.list().filter((a) => a.enabled);
  for (const acc of accounts) {
    if (busy.syncing.has(acc.id)) continue;
    const s = getSettings();
    const last = acc.lastSyncAt || 0;
    const interval = (Number(s.syncIntervalMin) || 0) * 60000;
    if (interval <= 0) continue;
    if (Date.now() - last < interval) continue;
    busy.syncing.add(acc.id);
    try {
      const summary = await syncAccount(acc.id);
      pushNewMailNotice(acc, summary?.newMessages || 0);
    } catch (e) {
      logger.warn('svc', `自动同步 ${acc.name} 失败: ${e.message}`);
    } finally {
      busy.syncing.delete(acc.id);
    }
    await sleep(1500);
  }
}

/* ---------- 正文预取（信封 → 正文，供列表摘要/AI/附件预览） ---------- */
export async function runHydration(accountId = null) {
  if (busy.hydrating) return;
  busy.hydrating = true;
  try {
    const accounts = accountId ? AccountStore.list().filter((a) => a.id === accountId) : AccountStore.list().filter((a) => a.enabled);
    // 每轮抓取封数由设置「每次同步后台抓取正文的封数」决定（0 = 不预取正文）
    const perRound = clampLimit(getSettings().hydrateNewLimit, 60, 0, 500);
    if (perRound === 0) return;
    for (const acc of accounts) {
      if (busy.syncing.has(acc.id)) continue;
      const need = MessageStore.hydrateQueue(acc.id, perRound);
      if (!need.length) continue;
      // 每轮最多抓取 perRound 封（Outlook COM 天然串行，IMAP 也已限速）
      for (const m of need.slice(0, perRound)) {
        try {
          await hydrateByUid(m.accountId, m.folder, m.uid);
          await sleep(60);
        } catch (e) {
          // 失败即跳过该封，避免反复重试拖慢队列
          MessageStore.update(m.id, { snippet: m.snippet || '(正文获取失败)' });
          logger.warn('svc', `正文预取失败 ${acc.name}/${m.folder}/${m.uid}: ${e.message}`);
        }
      }
      await sleep(80);
    }
  } finally {
    busy.hydrating = false;
    lastActivity.hydrateAt = Date.now();
  }
}

/** 设置值夹取：非法值回落默认，避免 NaN/负数把队列打乱 */
function clampLimit(v, dflt, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

/* ---------- AI 批量分类（仅当 AI 启用、开启自动分类且有可用 Key 时） ---------- */
export async function runAiClassify() {
  if (busy.classifying) return;
  const s = getSettings();
  const ai = s.ai || {};
  if (!ai.enabled || !ai.autoClassify) return;
  const provider = activeProvider();
  if (!provider.ok) return;
  busy.classifying = true;
  try {
    const accounts = AccountStore.list().filter((a) => a.enabled);
    for (const acc of accounts) {
      const need = MessageStore.uncategorized(acc.id, 120);
      if (!need.length) continue;
      try {
        const res = await aiClassifyBatch(need, { save: true });
        if (res.length) {
          const usedAI = res.some((x) => x.model && x.model !== 'local');
          const engineTxt = usedAI
            ? `AI（${provider.model || provider.label}）`
            : '本地关键词（AI 未成功响应，邮件会保留在待 AI 队列）';
          logger.info('svc', `分类完成 ${acc.name}: ${res.length} 封（引擎：${engineTxt}）`);
        }
      } catch (e) {
        logger.warn('svc', `AI 分类失败 ${acc.name}: ${e.message}`);
      }
      await sleep(500);
    }
  } finally {
    busy.classifying = false;
    lastActivity.classifyAt = Date.now();
  }
}

/* ---------- 到期提醒 → 待通知 ---------- */
export async function runReminders() {
  const due = EventStore.dueReminders(now());
  if (!due.length) return;
  const list = (SettingsStore.get('pending_notifications', []) || []);
  const evs = new Map();
  for (const r of due) {
    const ev = EventStore.get(r.eventId);
    if (!ev) continue;
    const existing = evs.get(ev.id);
    evs.set(ev.id, {
      id: uid(), type: 'reminder', at: r.dueMs, seen: false,
      event: { id: ev.id, title: ev.title, startMs: ev.startMs, color: ev.color },
    });
    void existing;
  }
  const added = [...evs.values()];
  SettingsStore.set('pending_notifications', [...list, ...added].slice(-50));
}

/* ---------- 每日未读重点汇总 ---------- */
export function composeDigest(opts = {}) {
  const s = getSettings();
  const dg = s.digest || {};
  if (!dg.enabled && !opts.force) return null;
  const nowMs = Date.now();
  if (!opts.force) {
    const [h, m] = String(dg.time || '21:00').split(':').map((x) => Number(x) || 0);
    const target = new Date();
    target.setHours(h, m, 0, 0);
    // 到达设定时间后的 15 分钟窗口内触发一次
    if (nowMs < target.getTime() || nowMs - target.getTime() > 15 * 60000) return null;
  }
  const today = new Date().toDateString();
  if (!opts.force && busy.digestRunDate === today) return null;
  if (!opts.force && !busy.digestRunDate) busy.digestRunDate = today;

  const windowMs = (Number(dg.windowHours) || 30) * 3600000;
  const sinceMs = Date.now() - windowMs;
  const cats = dg.importantCategories?.length ? dg.importantCategories : ['assignment', 'grade', 'course', 'club'];
  // Outlook 桌面账户的收件箱是 “\账号\Inbox” 路径，必须按账户解析真实文件夹名
  const inbox = resolveInboxFolders(null);
  if (!inbox.accountIds.length) return null;
  if (!inbox.folders.length) {
    logger.warn('svc', '汇总：未解析到任何收件箱文件夹（请先同步账户文件夹）');
    return null;
  }
  const res = MessageStore.query({
    accountIds: inbox.accountIds, folderIn: inbox.folders, unreadOnly: true, category: cats, dateFrom: sinceMs, pageSize: 100,
  });
  const items = res.list.map((m) => ({
    id: m.id, subject: m.subject, fromName: m.fromName, fromAddr: m.fromAddr,
    category: m.category, categoryLabel: catLabel(m.category), summary: m.aiSummary || m.snippet,
    dateMs: m.dateMs, accountName: m.accountName || '',
  }));
  const digest = { id: `${Date.now()}-${Math.floor(Math.random() * 1e6)}`, generatedAt: now(), date: today, count: items.length, items, read: false };
  SettingsStore.set('last_digest', digest);
  return digest;
}

/* ---------- 孤儿附件清理：删除磁盘上已无数据库引用的缓存文件 ---------- */
export function sweepOrphanFiles() {
  try {
    if (!fs.existsSync(ATTACH_DIR)) return 0;
    const refs = AttachmentStore.referencedStoredNames();
    let removed = 0; let bytes = 0;
    for (const fn of fs.readdirSync(ATTACH_DIR)) {
      const fp = path.join(ATTACH_DIR, fn);
      let st = null;
      try { st = fs.statSync(fp); } catch { continue; }
      if (!st.isFile()) continue;
      if (refs.has(fn)) continue;      // 仍被引用 → 保留
      try { fs.unlinkSync(fp); removed++; bytes += st.size; } catch { /* 占用忽略 */ }
    }
    if (removed) logger.info('svc', `附件去重清理：删除 ${removed} 个无引用缓存文件（释放 ${(bytes / 1048576).toFixed(1)}MB）`);
    return removed;
  } catch (e) {
    logger.warn('svc', `孤儿附件清理失败：${e.message}`);
    return 0;
  }
}

/* ---------- 附件容量清理（超上限删最旧；关联消息标记为可重新抓取） ---------- */
export function runAttachmentCleanup(force = false) {
  const s = getSettings();
  const capMB = Number(s.attachmentCapMB) || 400;
  const cap = capMB * 1024 * 1024;
  if (!force && Date.now() - busy.lastCleanup < 3600000) return;
  busy.lastCleanup = Date.now();
  try {
    sweepOrphanFiles();
    if (!fs.existsSync(ATTACH_DIR)) return;
    const rows = AttachmentStore.allStored();
    const files = rows
      .map((r) => {
        const fp = path.join(ATTACH_DIR, path.basename(r.stored));
        try {
          const st = fs.statSync(fp);
          return { ...r, fp, size: st.size, mtime: st.mtimeMs };
        } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => a.mtime - b.mtime);
    let total = files.reduce((s2, f) => s2 + f.size, 0);
    if (total <= cap) return;
    const touched = new Set();
    let freed = 0;
    for (const f of files) {
      if (total - freed <= cap) break;
      try {
        fs.unlinkSync(f.fp);
        freed += f.size;
        touched.add(f.message_id);
      } catch { /* 占用忽略 */ }
    }
    if (touched.size) {
      run(`DELETE FROM attachment WHERE message_id IN (${[...touched].map(() => '?').join(',')})`, [...touched]);
      run(`UPDATE message SET body_fetched=0, body_text=NULL, body_html=NULL WHERE id IN (${[...touched].map(() => '?').join(',')})`, [...touched]);
    }
    if (freed) logger.info('svc', `附件容量清理: 释放 ${(freed / 1048576).toFixed(1)}MB（涉及 ${touched.size} 封邮件，将按需重新抓取）`);
  } catch (e) {
    logger.warn('svc', `附件清理失败: ${e.message}`);
  }
}

/** 手动清空附件缓存：删除全部附件文件并重置为可重新抓取 */
export function purgeAttachmentCache() {
  let removed = 0;
  try {
    const rows = AttachmentStore.allStored();
    for (const r of rows) {
      const fp = path.join(ATTACH_DIR, path.basename(r.stored));
      try { fs.unlinkSync(fp); removed++; } catch { /* */ }
    }
    AttachmentStore.removeAllStored();
    run('UPDATE message SET body_fetched=0, body_text=NULL, body_html=NULL');
    logger.info('svc', `手动清空附件缓存：删除 ${removed} 个文件`);
  } catch (e) {
    logger.warn('svc', `清空附件缓存失败: ${e.message}`);
  }
  return removed;
}

/* ---------- 服务主循环 ---------- */
export function startServices() {
  // 一次性修复：旧版本在“AI 未成功”时也把 ai_attempted 置 1，导致换有效 Key 后不会重试
  try {
    run("UPDATE message SET ai_attempted=0 WHERE ai_attempted=1 AND category_model='local'");
  } catch (e) { logger.warn('svc', `ai_attempted 修复失败：${e.message}`); }
  // 价值评分 + 日期回填：对历史邮件先按本地规则补全（AI 随后精修，避免首页首屏逐封实时计算）
  try {
    const rows = MessageStore.query({ bodyFetched: true, pageSize: 200 }).list;

    // 性能优化：先判定哪些邮件「真的需要读正文重算日期」，
    // 再用一次查询把这些邮件的正文批量取回（原先在循环里对每封调 detail()，
    // 200 封就是 200 次额外 SQL + 200 次对象构造，启动瞬间有可感知的同步 IO 尖峰）。
    const needBody = [];
    for (const m of rows) {
      const stored = Array.isArray(m.dates) ? m.dates : [];
      const hasAi = stored.some((d) => d.source === 'ai');
      const needsRefresh = stored.length === 0 || (!hasAi && stored.some((d) => !d.confidence));
      if (needsRefresh && !hasAi) needBody.push(m.id);
    }
    const bodies = needBody.length ? MessageStore.bodiesByIds(needBody) : new Map();

    let scored = 0; let dated = 0; let purged = 0;
    for (const m of rows) {
      const patch = {};
      if (!m.worthReason) { const w = localWorth(m); patch.worth = w.worth; patch.worthReason = w.reason; patch.ai_attempted = 0; scored++; }
      const stored = Array.isArray(m.dates) ? m.dates : [];
      const hasAi = stored.some((d) => d.source === 'ai');
      // 老库里的日期是用“泛触发词”识别的（没有 confidence 字段），噪声极大。
      // 这里用收紧后的规则重算一次；重算不出高置信度候选就清空，避免污染首页与日历。
      const needsRefresh = stored.length === 0 || (!hasAi && stored.some((d) => !d.confidence));
      if (needsRefresh && !hasAi) {
        try {
          const body = bodies.get(m.id);
          // 正文缺失时回退到不含正文的行（extractFromMessage 只用 subject/body），并顺带清掉旧噪声
          const src = body ? { ...m, bodyText: body.bodyText, bodyHtml: body.bodyHtml } : m;
          const ds = extractFromMessage(src)
            .map((c) => ({ ms: c.ms, title: String(c.context || '').slice(0, 24), kind: c.type, confidence: c.confidence, source: 'rule' }))
            .filter((c) => c.confidence === 'high')
            .slice(0, 6);
          if (ds.length) { patch.dates = ds; patch.datesAt = Date.now(); dated++; }
          else if (stored.length) { patch.dates = []; patch.datesAt = Date.now(); purged++; }
        } catch { /* 忽略单封 */ }
      }
      if (Object.keys(patch).length) MessageStore.update(m.id, patch);
    }
    if (scored || dated || purged) {
      logger.info('svc', `回填完成：价值评分 ${scored} 封、高置信日期 ${dated} 封、清理旧误报日期 ${purged} 封（AI 将随后精修）`);
    }
  } catch (e) { logger.warn('svc', `回填失败：${e.message}`); }
  // 启动时顺带清理历史遗留的重复/孤儿附件缓存（同一内容只保留一份）
  try { sweepOrphanFiles(); } catch (e) { logger.warn('svc', e.message); }
  // 开机自启：按设置同步注册表（默认开启，可在 设置 → 启动与通知 关闭）
  (async () => {
    try {
      const s = getSettings();
      const st = await autoStartStatus(s.autoStart);
      if (s.autoStart && !st.installed) await applyAutoStart(true);
      else if (!s.autoStart && st.installed) await applyAutoStart(false);
    } catch (e) { logger.warn('svc', `开机自启同步失败：${e.message}`); }
  })();
  const tick = async () => {
    try { await runAutoSync(); } catch (e) { logger.warn('svc', e.message); }
    try { await runReminders(); } catch (e) { logger.warn('svc', e.message); }
    try { await runHydration(); } catch (e) { logger.warn('svc', e.message); }
    try { await runAiClassify(); } catch (e) { logger.warn('svc', e.message); }
    try { composeDigest(); } catch (e) { logger.warn('svc', e.message); }
    try { runAttachmentCleanup(); } catch (e) { logger.warn('svc', e.message); }
  };
  const timer = setInterval(tick, 30000);
  tick();
  return () => clearInterval(timer);
}
