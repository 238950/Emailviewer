// 收件箱文件夹解析（公共逻辑）：
// Outlook 桌面账户的真实收件箱文件夹是 “\账号\Inbox / \账号\收件箱” 这类路径，
// 与字面量 “INBOX” 不相等。汇总、首页、日历等所有“收件箱语义”的查询都必须复用它。
import { AccountStore, FolderStore } from './store.js';

export const folderLastSeg = (name) => String(name || '').split(/[\\/]/).filter(Boolean).pop() || '';

/** 是否为收件箱同义名（INBOX / Inbox / 收件箱 …） */
export function isInboxFolderName(name) {
  const last = folderLastSeg(name);
  return /^inbox$/i.test(last) || last.includes('收件箱');
}

/** 取启用的账户；传入 accountIds 时只取其中启用的（空数组 = 全部启用账户） */
export function enabledAccounts(accountIds) {
  const want = Array.isArray(accountIds) ? accountIds.filter(Boolean) : [];
  const all = AccountStore.list().filter((a) => a.enabled);
  return want.length ? all.filter((a) => want.includes(a.id)) : all;
}

/**
 * 解析一组账户各自的收件箱文件夹名。
 * @returns {{accounts:Array, accountIds:Array<string>, folders:Array<string>}}
 */
export function resolveInboxFolders(accountIds) {
  const accounts = enabledAccounts(accountIds);
  const folders = new Set();
  for (const a of accounts) {
    const hits = FolderStore.list(a.id).filter((f) => isInboxFolderName(f.name));
    if (hits.length) hits.forEach((f) => folders.add(f.name));
    else folders.add('INBOX'); // 尚未同步文件夹的账户，保留原字面语义
  }
  return { accounts, accountIds: accounts.map((a) => a.id), folders: [...folders] };
}
