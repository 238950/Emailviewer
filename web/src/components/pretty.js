// 文件夹名 → 中文
export function prettyFolder(name) {
  const u = String(name || '').toUpperCase();
  const map = {
    INBOX: '收件箱',
    SENT: '已发送', 'SENT ITEMS': '已发送', '[GMAIL]/SENT MAIL': '已发送', '&XfJT0ZAB-': '已发送',
    DRAFTS: '草稿', '[GMAIL]/DRAFTS': '草稿',
    TRASH: '已删除', 'DELETED ITEMS': '已删除', '[GMAIL]/TRASH': '已删除',
    JUNK: '垃圾邮件', SPAM: '垃圾邮件', 'JUNK EMAIL': '垃圾邮件', '[GMAIL]/SPAM': '垃圾邮件',
    ARCHIVE: '归档', ARCHIVES: '归档', '[GMAIL]/ALL MAIL': '全部邮件', IMPORTANT: '重要',
    '[GMAIL]/IMPORTANT': '重要', OUTBOX: '发件箱', '[GMAIL]/STARRED': '已加星标',
  };
  if (map[u]) return map[u];
  // IMAP-UTF7 变体常见映射
  if (u.includes('SENT')) return '已发送';
  if (u.includes('JUNK') || u.includes('SPAM')) return '垃圾邮件';
  if (u.includes('TRASH') || u.includes('DELETED')) return '已删除';
  return name || '';
}

/**
 * 界面显示用的文件夹名：只取路径最后一段再译中文。
 * Outlook 的 `\\账号\Inbox` 以前会把账号名一起显示，把真正有区分度的名字挤没了。
 */
export function displayName(fname) {
  const s = String(fname || '');
  const segs = s.split(/[\\/]/).filter(Boolean);
  const last = segs.length ? segs[segs.length - 1] : s;
  const pretty = prettyFolder(last);
  return pretty !== last ? pretty : (last || s);
}

/** 完整路径（用于 hover 提示），例：`user@example.com › 收件箱` */
export function fullName(fname) {
  const segs = String(fname || '').split(/[\\/]/).filter(Boolean);
  if (!segs.length) return String(fname || '');
  return segs.map((seg) => prettyFolder(seg)).join(' › ');
}

/** 是否为“草稿箱”文件夹（默认隐藏，可在 设置 → 外观 打开） */
export function isDraftFolderName(fname) {
  const last = String(fname || '').split(/[\\/]/).filter(Boolean).pop() || String(fname || '');
  return /^drafts?$/i.test(last) || last.includes('草稿') || /draft/i.test(last);
}
