// 邮件正文抓取、MIME 解析、附件落盘与本地分类收尾
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { simpleParser } from 'mailparser';
import { logger, ATTACH_DIR } from './logger.js';
import { fetchMessageSource } from './imap.js';
import { AccountStore, MessageStore, AttachmentStore } from './store.js';
import { stripHtml, makeSnippetText, mimeGroup } from './util.js';
import { classifyByKeywords, summarizeLocally, msgText, localWorth } from './ai.js';
import { extractFromMessage } from './nlp.js';
import { applyRulesAndSave } from './rules.js';

/** 文件名安全化（防路径穿越） */
export function safeName(name, fb = 'file') {
  const n = String(name || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .trim()
    .slice(0, 180);
  return n || fb;
}

/** 按 uid 抓取并解析落库（IMAP 与 Outlook 桌面按账户类型分流） */
export async function hydrateByUid(accountId, folder, uid) {
  const account = AccountStore.get(accountId);
  if (!account) throw new Error('账户不存在');
  const msg = MessageStore.byUid(accountId, folder, uid);
  if (!msg) throw new Error('邮件不存在');
  if (msg.bodyFetched) return MessageStore.detail(msg.id);
  if (account.kind === 'outlook-local') {
    if (!msg.msgId) throw new Error('Outlook 邮件缺少 EntryID');
    const { outlookMessageParts } = await import('./outlook.js');
    const parts = await outlookMessageParts(account, msg.msgId);
    const fake = {
      text: parts.text,
      html: parts.html,
      headers: new Map(),
      attachments: parts.attachments,
    };
    return finalizeParsed(msg, fake);
  }
  const source = await fetchMessageSource(accountId, folder, uid);
  if (!source) throw new Error('未取到正文');
  return finalizeSource(msg, source);
}

/** IMAP：抓 RFC822 原文 → mailparser → 通用落库 */
export async function finalizeSource(msg, source) {
  const parsed = await simpleParser(source, { skipHtmlToText: false }).catch((e) => {
    logger.warn('hydrate', `mailparser 解析失败 id=${msg.id}: ${e.message}`);
    // 极端的非 MIME 邮件：直接当作纯文本
    return { text: source.toString('utf8'), html: '', attachments: [], headers: new Map() };
  });
  return finalizeParsed(msg, parsed);
}

/** 解析结果 → 通用落库（附件、正文、分类、规则；IMAP / Outlook 共用） */
export async function finalizeParsed(msg, parsed) {
  const text = parsed.text || '';
  const html = parsed.html || '';
  const headersMap = parsed.headers || new Map();

  const pickHeader = (key) => {
    try {
      const v = headersMap.get(key);
      if (v == null) return '';
      if (Array.isArray(v)) return v.map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join('; ');
      if (typeof v === 'object') return JSON.stringify(v);
      return String(v);
    } catch { return ''; }
  };

  const headers = {
    messageId: pickHeader('message-id'),
    date: pickHeader('date'),
    replyTo: pickHeader('reply-to'),
    inReplyTo: pickHeader('in-reply-to'),
    references: pickHeader('references'),
    contentType: pickHeader('content-type'),
    listUnsubscribe: pickHeader('list-unsubscribe'),
    returnPath: pickHeader('return-path'),
    deliveredTo: pickHeader('delivered-to'),
    xOriginalTo: pickHeader('x-original-to'),
  };

  const atts = [];
  const usedFiles = new Set();
  const attsTotalSize = (parsed.attachments || []).reduce((s, a) => s + (a.size || (a.content ? a.content.length : 0)), 0);
  const MAX_SAVE = 120 * 1024 * 1024; // 单封附件总上限 120MB，防爆盘
  let savedBytes = 0;

  // 幂等：先清掉该邮件旧的附件行（配合缓存清理后重抓）
  AttachmentStore.deleteByMessage(msg.id);

  for (const [i, att] of (parsed.attachments || []).entries()) {
    const contentType = att.contentType || 'application/octet-stream';
    const disposition = att.disposition || (att.filename ? 'attachment' : 'inline');
    const isInlineCid = Boolean(att.contentId) && disposition === 'inline';
    const rawName = att.filename || (isInlineCid ? `inline-${safeName(att.contentId).replace(/[<>@]/g, '_')}.png` : '');
    const base = safeName(rawName || `attachment-${i + 1}`, `attachment-${i + 1}`);
    let content = att.content;
    // mailparser 大附件可能给流
    if (!Buffer.isBuffer(content)) {
      const chunks = [];
      try { for await (const c of content) chunks.push(c); } catch { /* */ }
      content = Buffer.concat(chunks);
    }
    const size = content.length || att.size || 0;
    if (!content.length && isInlineCid && size === 0) continue;

    // 内容哈希 → 全局去重池：同一份内容在本机只落盘一次。
    // 这样即使同一封邮件被重复抓取/重复同步，也不会重复占用磁盘。
    const hash = crypto.createHash('sha1').update(content).digest('hex');
    let stored = '';
    const ext = base.includes('.') ? base.slice(base.lastIndexOf('.')) : extFor(contentType);
    const pooledName = `p_${hash.slice(0, 24)}${ext}`;
    const pooledAbs = path.join(ATTACH_DIR, pooledName);

    // 1) 已有相同哈希的附件行且文件仍在 → 直接复用（不写盘）
    const hit = AttachmentStore.findByHash(hash, size);
    if (hit && hit.stored && fs.existsSync(path.join(ATTACH_DIR, path.basename(hit.stored)))) {
      stored = hit.stored;
    } else if (size > 0 && savedBytes + size <= MAX_SAVE) {
      // 2) 池中已有同名文件（内容必然一致）→ 复用；否则写入池文件名（稳定命名=幂等）
      if (fs.existsSync(pooledAbs)) {
        stored = pooledName;
      } else {
        try {
          fs.writeFileSync(pooledAbs, content);
          stored = pooledName;
          savedBytes += size;
        } catch (e) {
          logger.warn('hydrate', `附件写盘失败 ${pooledName}: ${e.message}`);
        }
      }
    }
    void usedFiles;

    const id = AttachmentStore.insert({
      messageId: msg.id, accountId: msg.accountId, filename: base, mime: contentType, size,
      contentId: att.contentId || '', disposition, part: String(i), stored, hash,
    });
    if (!isInlineCid) {
      atts.push({ filename: base, mime: contentType, size, group: mimeGroup(contentType), id, contentId: att.contentId || '', disposition });
    } else {
      atts.push({ filename: base, mime: contentType, size, inline: true, id, contentId: att.contentId || '', disposition: 'inline' });
    }
  }
  void attsTotalSize;

  const snippetText = text || stripHtml(html);
  const snippet = makeSnippetText(snippetText, 200) || (msg.subject ? `（无正文）${msg.subject}` : '');
  const realAtts = atts.filter((a) => !a.inline);

  MessageStore.update(msg.id, {
    body_text: text, body_html: html, body_fetched: 1,
    headers_json: headers,
    snippet,
    att_json: atts,
    has_attachments: realAtts.length > 0,
  });
  // 附件组在附件汇总视图里用 content_id 识别内嵌
  void realAtts;

  const fresh = MessageStore.detail(msg.id);
  // 本地关键词分类 + 本地摘要（AI 由后台服务随后升级）
  if (!fresh.category || fresh.category === 'other' || fresh.categoryModel === 'local') {
    const kw = classifyByKeywords(fresh);
    MessageStore.update(fresh.id, { category: kw.category, categoryReason: kw.reason, categoryModel: 'local', categoryAt: Date.now() });
    fresh.category = kw.category; fresh.categoryReason = kw.reason;
  }
  if (!fresh.aiSummary) {
    const local = summarizeLocally(fresh);
    MessageStore.update(fresh.id, { ai_summary: local, ai_summary_model: 'local', ai_summary_at: Date.now() });
    fresh.aiSummary = local;
  }
  // 价值评分（首页“推荐活动 / 重要邮件”用；AI 分类后会被更准的 AI 判断覆盖）
  if (!fresh.worth || fresh.categoryModel === 'local') {
    const w = localWorth(fresh);
    MessageStore.update(fresh.id, { worth: w.worth, worthReason: w.reason });
    fresh.worth = w.worth; fresh.worthReason = w.reason;
  }
  // 日期候选（截止/活动时间）：先用规则识别，AI 分类时会用更准确的结果覆盖，
  // 供「首页·临近截止」与「日历·一键安排」使用。
  if (!fresh.dates || !fresh.dates.length) {
    try {
      const ds = extractFromMessage(fresh).map((c) => ({
        ms: c.ms, title: String(c.context || '').slice(0, 24), kind: c.type, confidence: c.confidence, source: 'rule',
      // 只落库高置信度候选（截止/考试词紧邻日期），减少首页与日历噪声
      })).filter((c) => c.confidence === 'high').slice(0, 6);
      if (ds.length) {
        MessageStore.update(fresh.id, { dates: ds, datesAt: Date.now() });
        fresh.dates = ds;
      }
    } catch { /* 忽略单封识别失败 */ }
  }
  // 用户规则（含正文匹配）
  try { applyRulesAndSave(fresh); } catch (e) { logger.warn('hydrate', `规则应用失败 id=${fresh.id}: ${e.message}`); }
  logger.info('hydrate', `落库完成 id=${fresh.id} subject=${fresh.subject}`);
  return MessageStore.detail(fresh.id);
}

function extFor(mime) {
  const map = {
    'application/pdf': '.pdf',
    'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp',
    'text/calendar': '.ics', 'text/csv': '.csv', 'application/zip': '.zip',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
    'application/msword': '.doc', 'application/vnd.ms-excel': '.xls',
  };
  return map[mime] || '.bin';
}

export { msgText };
