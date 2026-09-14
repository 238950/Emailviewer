// 用户自定义过滤规则引擎（如「来自某课程助教的邮件自动打标签」）
import { RuleStore, MessageStore, mimeGroupName } from './store.js';
import { msgText } from './ai.js';

// 支持：from_contains / from_is / subject_contains / body_contains / to_contains / any_contains / account_is / folder_is / has_attachment / attachment_group / unread / cc_contains
const FIELD_ALIAS = {
  from_contains: ['fromAddr', 'fromName'],
  from_is: ['fromAddr'],
  subject_contains: ['subject'],
  body_contains: ['_body'],
  to_contains: ['toList'],
  cc_contains: ['ccList'],
  any_contains: ['subject', 'fromAddr', 'fromName', 'toList', 'ccList', '_body'],
};

function getFieldValue(msg, field) {
  if (field === '_body') return msgText(msg);
  return msg[field];
}

/** 布尔型条件：不需要 value（BUG-03：以前空 value 会被当成“恒真”） */
const BOOL_FIELDS = new Set(['has_attachment', 'unread']);

function matchCondition(cond, msg) {
  const field = cond.field;
  const rawValue = cond.value == null ? '' : String(cond.value).trim();
  const value = rawValue.toLowerCase();

  // 布尔型字段忽略 value，永远按真实状态判断
  switch (field) {
    case 'has_attachment': return !!msg.hasAttachments;
    case 'unread': return !msg.read;
    default: break;
  }

  // 文本型/枚举型字段：value 为空 → 该条件不参与匹配（返回 false，避免误伤全部邮件）
  if (!value) return false;

  switch (field) {
    case 'account_is': return msg.accountId === rawValue;
    case 'folder_is': return (msg.folder || '').toLowerCase() === value;
    case 'attachment_group': {
      if (!msg.attMeta) return false;
      return (msg.attMeta || []).some((a) => (a.group || mimeGroupName(a.mime)) === value);
    }
    default: {
      const fields = FIELD_ALIAS[field] || [field];
      return fields.some((f) => {
        const v = getFieldValue(msg, f);
        if (Array.isArray(v)) return v.some((x) => String(x).toLowerCase().includes(value));
        return String(v || '').toLowerCase().includes(value);
      });
    }
  }
}

/** 对一条消息执行规则（rules 缺省取全部启用规则），返回命中结果 */
export function applyRules(msg, rules) {
  const list = (rules || RuleStore.list().filter((r) => r.enabled));
  const effects = { labels: new Set(msg.labels || []), category: null, markRead: null, important: null };
  let hitRule = null;
  for (const rule of list.sort((a, b) => (b.priority || 0) - (a.priority || 0))) {
    if (!rule.enabled) continue;
    const conds = rule.match || [];
    if (!conds.length) continue;
    const allHit = conds.every((c) => matchCondition(c, msg));
    if (!allHit) continue;
    hitRule = rule;
    const act = rule.action || {};
    if (Array.isArray(act.labels)) for (const lb of act.labels) if (lb) effects.labels.add(lb);
    if (act.category) effects.category = act.category;
    if (typeof act.markRead === 'boolean') effects.markRead = act.markRead;
    if (typeof act.important === 'boolean') effects.important = act.important;
  }
  return {
    ruleHit: hitRule,
    labels: [...effects.labels],
    category: effects.category,
    markRead: effects.markRead,
    important: effects.important,
  };
}

/** 应用规则并写回数据库 */
export function applyRulesAndSave(msg, rules) {
  const r = applyRules(msg, rules);
  const patch = {};
  if (r.labels) patch.labels = r.labels;
  if (r.category) patch.category = r.category;
  if (r.markRead != null) patch.read = r.markRead;
  if (r.important != null) patch.important = r.important;
  if (Object.keys(patch).length) MessageStore.update(msg.id, patch);
  return r;
}

/**
 * 对已抓正文的邮件执行规则。
 * BUG-10 修复：按分页循环扫描全部已下载邮件（此前只扫最近 200 封，老邮件永远匹配不到）。
 * @returns {{scanned:number, changed:number, truncated:boolean}}
 */
export function applyRulesToHydrated(accountId, rules, { maxScan = 10000 } = {}) {
  let scanned = 0; let changed = 0; let page = 0; let truncated = false;
  for (;;) {
    const batch = MessageStore.query({ accountId, bodyFetched: true, pageSize: 200, page, includeHidden: true });
    if (!batch.list.length) break;
    for (const m of batch.list) {
      const before = JSON.stringify({ l: m.labels, c: m.category, r: m.read, i: m.important });
      applyRulesAndSave(m, rules);
      const after = MessageStore.get(m.id);
      if (JSON.stringify({ l: after.labels, c: after.category, r: after.read, i: after.important }) !== before) changed++;
      scanned++;
    }
    if (batch.list.length < batch.pageSize) break;
    page++;
    if (scanned >= maxScan) { truncated = true; break; }
  }
  return { scanned, changed, truncated };
}
