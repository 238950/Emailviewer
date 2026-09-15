// 邮箱视图左栏：账户列表（主/副）+ 文件夹树
import React, { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Inbox, Folder, RefreshCw, Plus, Mail, Loader2 } from 'lucide-react';
import { useStore } from '../store.js';
import { api, fmtBytes } from '../api.js';
import { displayName, fullName, isDraftFolderName } from './pretty.js';

const FOLDER_ICON = (name) => {
  const u = String(name || '').toUpperCase();
  if (u === 'INBOX' || u === '收件箱') return 'inbox';
  if (u.includes('SENT') || u.includes('已发送')) return 'sent';
  if (u.includes('JUNK') || u.includes('SPAM') || u.includes('垃圾')) return 'junk';
  if (u.includes('TRASH') || u.includes('DELETED') || u.includes('已删除')) return 'trash';
  if (u.includes('DRAFT') || u.includes('草稿')) return 'draft';
  if (u.includes('ARCHIVE') || u.includes('归档')) return 'archive';
  return 'folder';
};

export default function FolderColumn() {
  const { accounts, status, accountId, folder, selectAccount, selectMessage, folderTree, setFolderTree, expandedAccounts, toggleExpandAccount, syncing, refreshStatus, toast, setNewAccountOpen, openFolder, settings } = useStore();
  const [loading, setLoading] = useState({});
  const showDrafts = !!settings?.showDrafts;   // 草稿箱默认隐藏（设置 → 外观 可开）

  // 文件夹按“使用频率”排序：收件箱必须第一，其后 已发送→草稿→垃圾→已删除→存档→其余按名称
  const folderRank = (nameRaw) => {
    const last = String(nameRaw || '').split(/[\\/]/).filter(Boolean).pop() || String(nameRaw || '');
    const n = last.toLowerCase();
    if (n === 'inbox' || last.includes('收件箱')) return 0;
    if (/sent|已发送/.test(n)) return 1;
    if (/draft|草稿/.test(n)) return 2;
    if (/junk|spam|垃圾/.test(n)) return 3;
    if (/deleted|trash|已删除/.test(n)) return 4;
    if (/archive|存档|归档/.test(n)) return 5;
    return 10;
  };

  // 文件夹树：账户切换立即加载；每 20 秒与同步完成后自动刷新（含未读数/排序）
  useEffect(() => {
    if (!accountId) return;
    let dead = false;
    const load = () => api.folders(accountId)
      .then((r) => {
        if (dead) return;
        setFolderTree(accountId, r.folders);
        // 关键修复：经典 Outlook 账户的文件夹名是“\账号\Inbox”路径，默认“INBOX”查不到邮件。
        // 文件夹加载后若当前选中的文件夹不在该账户里，自动切换到最佳文件夹（收件箱优先），
        // 避免“先显示没有邮件/过几秒才出来/点不开”的体验。
        const st = useStore.getState();
        const cur = st.folder;
        const allFolders = r.folders || [];
        const showD = !!st.settings?.showDrafts;
        // 隐藏草稿箱时，参与“自动选择”的文件夹里也排除草稿
        const folders = showD ? allFolders : allFolders.filter((f) => !isDraftFolderName(f.name));
        if (folders.length && accountId === st.accountId && !folders.some((f) => f.name === cur)) {
          const best = [...folders].sort((a, b) => folderRank(a.name) - folderRank(b.name))[0];
          if (best && best.name !== cur) {
            openFolder(accountId, best.name);
          }
        }
      })
      .catch(() => { /* 静默：账户可能临时不可用 */ });
    load();
    const t = setInterval(load, 20000);
    return () => { dead = true; clearInterval(t); };
  }, [accountId, status?.accounts?.find((a) => a.id === accountId)?.lastSyncAt]);

  const doSync = async (id, e) => {
    e && e.stopPropagation();
    setLoading((s) => ({ ...s, [id]: true }));
    try {
      await api.sync(id);
      await refreshStatus(true);
      const r = await api.folders(id);
      setFolderTree(id, r.folders);
      toast('同步完成', 'success');
    } catch (err) { toast(err.message, 'error'); }
    finally { setLoading((s) => ({ ...s, [id]: false })); }
  };

  const pickFolder = (accId, fname) => {
    openFolder(accId, fname);
  };

  const selected = accounts.find((a) => a.id === accountId) || accounts[0];

  const renderAccount = (acc) => {
    const expanded = expandedAccounts.includes(acc.id);   // 展开态可再次点击折叠（主账户同样受控）
    const accFolders = (folderTree[acc.id] || [])
      .filter((f) => showDrafts || !isDraftFolderName(f.name))   // 草稿箱默认隐藏
      .map((f) => ({
        ...f,
        pretty: displayName(f.name),
        icon: FOLDER_ICON(f.name),
        unread: f.unread || 0,
      }))
      .sort((a, b) => folderRank(a.name) - folderRank(b.name) || a.pretty.localeCompare(b.pretty, 'zh'));
    const isActive = acc.id === accountId;
    const isSyncing = syncing[acc.id] || loading[acc.id];
    return (
      <div key={acc.id} className={`acc-block${isActive ? ' active' : ''}`} onClick={() => { selectAccount(acc.id); selectMessage(null); }}>
        <div className="acc-head" onClick={(e) => e.stopPropagation()}>
          <span className="acc-dot" style={{ background: acc.color }} />
          <span className="acc-name" title={`${acc.email || ''}${acc.syncError ? ` ｜ ${acc.syncError}` : ''}`}>
            {acc.name}
            {acc.kind === 'outlook-local' && <span className="acc-outlook-tag">Outlook</span>}
            {acc.kind === 'imap' && <span className="acc-imap-tag">IMAP</span>}
            {acc.isPrimary && <span className="acc-primary-tag">主</span>}
          </span>
          {acc.unreadTotal > 0 && <span className="acc-unread">{acc.unreadTotal > 99 ? '99+' : acc.unreadTotal}</span>}
          <span
            className="acc-fold-hint"
            title={expanded ? '折叠此账户' : '展开此账户'}
            role="button"
            aria-expanded={expanded}
            onClick={(e) => { e.stopPropagation(); toggleExpandAccount(acc.id); }}>
            {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          </span>
        </div>
        {expanded && (
          <div className="acc-folders">
            {accFolders.map((f) => (
              <div key={f.name} className={`folder-row${accountId === acc.id && folder === f.name ? ' active' : ''}`}
                onClick={(e) => { e.stopPropagation(); pickFolder(acc.id, f.name); }}>
                <span className="folder-icon">{folderIconEl(f.icon)}</span>
                <span className="folder-name" title={fullName(f.name)}>{f.pretty}</span>
                <span className="folder-meta">
                  {f.unread > 0 && <span className="folder-unread">{f.unread}</span>}
                  {f.total > 0 && <span className="folder-total">{f.total > 999 ? `${(f.total / 1000).toFixed(1)}k` : f.total}</span>}
                </span>
              </div>
            ))}
            {!accFolders.length && <div className="folder-empty">尚无文件夹，点击账户右侧刷新</div>}
            <div className="acc-actions">
              <button className="mini-btn" title="立即同步此账户" onClick={(e) => doSync(acc.id, e)}>
                {isSyncing ? <Loader2 size={12} className="spin" /> : <RefreshCw size={12} />} 同步
              </button>
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="folder-col">
      <div className="folder-col-title">
        <Mail size={14} />
        <span>账户与文件夹</span>
        <button className="mini-btn icon-only" title="添加账户" onClick={() => setNewAccountOpen(true)}><Plus size={13} /></button>
      </div>
      <div className="folder-scroll">
        {!accounts.length && (
          <div className="folder-empty-big">
            <Inbox size={26} />
            <p>还没有账户</p>
            <button className="btn primary" onClick={() => setNewAccountOpen(true)}>添加本机 Outlook 账户</button>
            <span className="dim">Outlook 桌面模式直接读取你电脑上已同步好的邮件，无需密码</span>
          </div>
        )}
        {accounts.map(renderAccount)}
      </div>
    </div>
  );
}

function folderIconEl(kind) {
  switch (kind) {
    case 'inbox': return <Inbox size={14} />;
    case 'sent': return <Mail size={14} />;
    case 'junk': return <span className="fi junk">!</span>;
    case 'trash': return <span className="fi trash">🗑</span>;
    case 'draft': return <span className="fi draft">✎</span>;
    case 'archive': return <span className="fi archive">🗄</span>;
    default: return <Folder size={14} />;
  }
}
