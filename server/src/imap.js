// IMAP 引擎：连接、文件夹与信封同步、正文抓取、标记操作
import { ImapFlow } from 'imapflow';
import { logger } from './logger.js';
import { decrypt } from './crypto.js';
import { AccountStore, FolderStore, MessageStore } from './store.js';
import { addrList, addrText, now, mimeGroup, isDraftFolderName } from './util.js';
import { getSettings } from './settings.js';

export function clientFor(account) {
  const full = AccountStore.get(account.id) || account;
  const password = decrypt(full.passwordEnc || '');
  return new ImapFlow({
    host: account.host,
    port: Number(account.port) || 993,
    secure: account.ssl !== false,
    auth: { user: account.username || account.email, pass: password },
    logger: false,
    emitLogs: false,
    tls: { rejectUnauthorized: account.extra?.allowInsecureTls ? false : true },
  });
}

/** 递归收集 bodyStructure 中的附件信息（不下载正文即可获得文件名/大小） */
export function walkStructure(node, out = []) {
  if (!node) return out;
  if (node.childNodes && node.childNodes.length) {
    // multipart：有些客户端把附件放 multipart/mixed 下层
    for (const c of node.childNodes) walkStructure(c, out);
    return out;
  }
  const params = node.parameters || {};
  const name = params.name || (node.disposition && node.disposition.parameters && node.disposition.parameters.filename) || '';
  const disp = node.disposition && node.disposition.type;
  const isTextBody = node.type === 'text' && !name && disp !== 'attachment';
  if (!isTextBody && (disp === 'attachment' || (name && disp === 'inline') || (name && node.type !== 'text') || name)) {
    out.push({
      filename: name || '',
      mime: `${node.type}/${node.subtype}`,
      size: node.size || 0,
      disposition: disp || (name ? 'inline' : ''),
      part: node.part,
      group: mimeGroup(`${node.type}/${node.subtype}`),
    });
  }
  return out;
}

/** 一次性同步某个账户：文件夹清单 + 新邮件信封（按 kind 分流） */
export async function syncAccount(accountId) {
  const account = AccountStore.get(accountId);
  if (!account) throw new Error('账户不存在');
  if (account.kind === 'outlook-local') {
    const { syncOutlookAccount } = await import('./outlook.js');
    return syncOutlookAccount(account);
  }
  const s = getSettings();
  const client = clientFor(account);
  const summary = { folders: 0, newMessages: 0, skipped: 0, errors: [] };
  try {
    await client.connect();
    // 1) 文件夹清单
    const folders = await client.list();
    const realFolders = folders.filter((f) => !(f.flags || []).includes('\\Noselect'));
    const folderRows = [];
    for (const f of realFolders) {
      folderRows.push({ accountId, name: f.path, delim: f.delimiter || '/', flags: f.flags || [] });
    }
    for (const f of folderRows) {
      FolderStore.upsert({ ...f, total: 0, unread: 0 });
    }
    summary.folders = folderRows.length;

    // 2) 每个文件夹增量同步信封（草稿箱默认跳过，可在设置 → 外观 打开）
    const sinceDays = Number(s.initialSyncDays) || 30;
    const sinceDate = new Date(Date.now() - sinceDays * 86400000);
    for (const f of folderRows) {
      if (!s.showDrafts && isDraftFolderName(f.name)) {
        logger.info('imap', `跳过草稿文件夹：${f.name}`);
        continue;
      }
      try {
        const info = await syncFolderEnvelopes(client, account, f, sinceDate, summary);
        // folder 统计以本地库为准（未读 = 本应用内可见的未读）
        const unreadRows = MessageStore.unreadByFolder(account.id).find((r) => r.folder === f.name);
        const localTotal = MessageStore.query({ accountIds: [account.id], folder: f.name, pageSize: 1 }).total;
        FolderStore.bumpCounts(account.id, f.name, localTotal, unreadRows ? unreadRows.unread : 0, info.highestUid, info.uidValidity);
      } catch (e) {
        logger.warn('imap', `文件夹 ${f.name} 同步失败: ${e.message}`);
        summary.errors.push(`${f.name}: ${e.message}`);
      }
    }
    AccountStore.update(account.id, { lastSyncAt: now(), syncState: summary, syncError: '' });
    return summary;
  } catch (e) {
    AccountStore.update(account.id, { syncError: e.message, syncState: summary });
    logger.error('imap', `同步账户 ${account.name} 失败:`, e);
    throw e;
  } finally {
    try { await client.logout(); } catch { /* */ }
  }
}

async function syncFolderEnvelopes(client, account, folder, sinceDate, summary) {
  await client.mailboxOpen(folder.name);
  const mb = client.mailbox;
  const exists = mb.exists;
  const uidValidity = String(mb.uidValidity || '');
  const prev = FolderStore.get(account.id, folder.name);

  // uidvalidity 变化 → 重建该文件夹
  const uidValidChanged = prev && prev.uidvalidity && prev.uidvalidity !== uidValidity;
  if (uidValidChanged) {
    logger.info('imap', `文件夹 ${folder.name} UIDVALIDITY 变化，重建索引`);
  }
  const lastUid = uidValidChanged ? 0 : (prev?.highestUid || 0);

  // 需要抓取的 UID 集合
  let uids = [];
  if (lastUid > 0) {
    if (mb.uidNext - 1 > lastUid) {
      uids = await client.search({ uid: `${lastUid + 1}:*` });
    }
  } else {
    uids = await client.search({ since: sinceDate });
    if (!uids.length && mb.exists) {
      // 服务器不支持按日期搜时退回最近若干封
      const top = Math.min(mb.exists, 50);
      uids = await client.search({ seq: `${Math.max(1, mb.exists - top + 1)}:*` });
    }
  }
  let highestUid = lastUid;
  let newCount = 0;
  const wantUids = (uids || []).filter((u) => u > lastUid);
  if (wantUids.length) {
    for await (const msg of client.fetch({ uid: wantUids }, { uid: true, envelope: true, bodyStructure: true, flags: true, size: true, internalDate: true }, { uid: true })) {
      try {
        const atts = walkStructure(msg.bodyStructure || null);
        const env = msg.envelope || {};
        const fromArr = env.from || [];
        const date = env.date ? new Date(env.date) : new Date(msg.internalDate || Date.now());
        const flags = msg.flags || [];
        const read = flags.includes('\\Seen');
        const important = flags.includes('\\Flagged');
        const rec = MessageStore.insertEnvelope({
          accountId: account.id, folder: folder.name, uid: msg.uid,
          msgId: env.messageId || '', subject: (env.subject || '').slice(0, 1000),
          fromAddr: addrList(fromArr)[0] || '',
          fromName: (fromArr[0] && (fromArr[0].name || '')) || '',
          toList: addrText(env.to), ccList: addrText(env.cc),
          dateMs: date.getTime(),
          receivedMs: msg.internalDate ? new Date(msg.internalDate).getTime() : date.getTime(),
          size: msg.size || 0, flags,
          read, important,
          hasAttachments: atts.length > 0,
          attMeta: atts,
          labels: [],
        });
        if (rec.inserted) newCount++;
        if (msg.uid > highestUid) highestUid = msg.uid;
      } catch (e) {
        logger.warn('imap', `信封落库失败 uid=${msg.uid}: ${e.message}`);
      }
    }
  } else if (lastUid > 0 && mb.uidNext - 1 > lastUid) {
    highestUid = mb.uidNext - 1;
  } else if (!lastUid) {
    highestUid = mb.uidNext > 0 ? mb.uidNext - 1 : 0;
  }
  const unseen = (await client.search({ unseen: true })).length;
  summary.newMessages += newCount;
  return { exists, unseen, highestUid, uidValidity };
}

/** 抓取单封邮件完整原文并落库（仅 IMAP；Outlook 走 hydrate 分流） */
export async function fetchMessageSource(accountId, folder, uid) {
  const account = AccountStore.get(accountId);
  if (!account) throw new Error('账户不存在');
  if (account.kind !== 'imap') throw new Error('该账户类型不支持直接抓取原文');
  const client = clientFor(account);
  try {
    await client.connect();
    await client.mailboxOpen(folder);
    const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
    if (!msg || !msg.source) throw new Error('服务器未返回正文');
    return msg.source; // Buffer
  } finally {
    try { await client.logout(); } catch { /* */ }
  }
}

/**
 * 批量标记：同一账户的多封邮件复用一条连接（BUG-34）。
 * 以前每封都 connect→login→操作→logout，批量时会被服务器限流。
 */
export async function setFlagsBatch(items) {
  const imapItems = (items || []).filter((it) => it && it.account && it.account.kind !== 'outlook-local');
  if (!imapItems.length) {
    for (const it of items || []) {
      if (it?.account) await setFlags(it.account.id, it.folder, it.uid, it.flags || {});
    }
    return { connections: 0, operations: imapItems.length };
  }
  const byAccount = new Map();
  for (const it of imapItems) {
    if (!byAccount.has(it.account.id)) byAccount.set(it.account.id, []);
    byAccount.get(it.account.id).push(it);
  }
  let connections = 0;
  for (const [accountId, list] of byAccount) {
    const account = AccountStore.get(accountId);
    if (!account) continue;
    const client = clientFor(account);
    connections++;
    try {
      await client.connect();
      for (const folder of [...new Set(list.map((i) => i.folder))]) {
        await client.mailboxOpen(folder);
        const u = { uid: true };
        for (const it of list.filter((i) => i.folder === folder)) {
          const f = it.flags || {};
          try {
            if (f.read === true) await client.messageFlagsAdd(String(it.uid), ['\\Seen'], u);
            if (f.read === false) await client.messageFlagsRemove(String(it.uid), ['\\Seen'], u);
            if (f.important === true) await client.messageFlagsAdd(String(it.uid), ['\\Flagged'], u);
            if (f.important === false) await client.messageFlagsRemove(String(it.uid), ['\\Flagged'], u);
          } catch (e) {
            logger.warn('imap', `批量标记失败 account=${account.name} uid=${it.uid}: ${e.message}`);
          }
        }
      }
    } catch (e) {
      logger.warn('imap', `批量标记连接失败 account=${account.name}: ${e.message}`);
    } finally {
      try { await client.logout(); } catch { /* */ }
    }
  }
  return { connections, operations: imapItems.length };
}

/** 标记已读/未读、星标（尽力而为，失败不回滚本地状态；IMAP 与 Outlook 按类型分流） */
export async function setFlags(accountId, folder, uid, { read, important }) {
  const account = AccountStore.get(accountId);
  if (!account) return;
  if (account.kind === 'outlook-local') {
    const row = MessageStore.byUid(accountId, folder, uid);
    if (!row || !row.msgId) return;
    const { outlookSetFlags } = await import('./outlook.js');
    try {
      await outlookSetFlags(account, row.msgId, { read, important });
    } catch (e) {
      logger.warn('imap', `Outlook 标记失败 ${account.name} uid=${uid}: ${e.message}`);
    }
    return;
  }
  const client = clientFor(account);
  try {
    await client.connect();
    await client.mailboxOpen(folder);
    const u = { uid: true };
    if (read === true) await client.messageFlagsAdd(String(uid), ['\\Seen'], u);
    if (read === false) await client.messageFlagsRemove(String(uid), ['\\Seen'], u);
    if (important === true) await client.messageFlagsAdd(String(uid), ['\\Flagged'], u);
    if (important === false) await client.messageFlagsRemove(String(uid), ['\\Flagged'], u);
  } catch (e) {
    logger.warn('imap', `设置标记失败 account=${account.name} folder=${folder} uid=${uid}: ${e.message}`);
  } finally {
    try { await client.logout(); } catch { /* */ }
  }
}

/** 测试连接（新建账户时使用；支持 allowInsecureTls 以适配自签名服务器） */
export async function testConnection(opts) {
  const client = new ImapFlow({
    host: opts.host,
    port: Number(opts.port) || 993,
    secure: opts.ssl !== false,
    auth: { user: opts.username || opts.email, pass: opts.password },
    logger: false,
    emitLogs: false,
    tls: { rejectUnauthorized: opts.allowInsecureTls ? false : true },
  });
  await client.connect();
  const folders = await client.list();
  await client.logout();
  return { ok: true, folderCount: folders.length, sampleFolders: folders.slice(0, 5).map((f) => f.path) };
}
