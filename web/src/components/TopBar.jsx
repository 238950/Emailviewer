// 顶栏：Logo / 视图切换 / 全局操作
import React, { useEffect, useRef, useState } from 'react';
import { Mail, Sparkles, Paperclip, CalendarDays, Settings, RefreshCw, Bell, Moon, Sun, Plus, Inbox, MessageSquare, MailPlus, Home } from 'lucide-react';
import { useStore } from '../store.js';
import { api } from '../api.js';
import { Toasts } from './common.jsx';

const VIEWS = [
  { key: 'home', label: '首页', icon: Home },
  { key: 'mail', label: '邮箱', icon: Mail },
  { key: 'smart', label: '智能收件箱', icon: Sparkles },
  { key: 'chat', label: 'AI 助手', icon: MessageSquare },
  { key: 'attach', label: '附件库', icon: Paperclip },
  { key: 'calendar', label: '日历', icon: CalendarDays },
  { key: 'settings', label: '设置', icon: Settings },
];

export default function TopBar() {
  const { view, setView, theme, setTheme, status, accounts, refreshStatus, bumpList, toast, notifications, setNewAccountOpen } = useStore();
  const [syncingAll, setSyncingAll] = useState(false);
  const [bellOpen, setBellOpen] = useState(false);
  const [bellList, setBellList] = useState([]);
  const bellRef = useRef(null);

  // 铃铛：轮询通知（提醒/每日汇总）
  // BUG-51：依赖里不能放 `status`。App.jsx 每 10 秒 refreshStatus 一次，
  // status 一变这个 effect 就被销毁重建，20 秒的定时器在第 10 秒就被重置，
  // 永远等不到触发（铃铛几乎不刷新）。改为只依赖 view，
  // 需要读状态时在 load 内部用 useStore.getState() 现取。
  useEffect(() => {
    const load = async () => {
      try {
        const r = await api.get('/api/notifications');
        setBellList([...(r.notifications || []).map((n) => ({ ...n, kind: 'reminder' })), ...(r.digest ? [{ ...r.digest, kind: 'digest' }] : [])]);
      } catch { /* */ }
    };
    load();
    const t = setInterval(load, 20000);
    // 窗口重新可见时补一次（长时间后台后定时器可能被浏览器降频）
    const onVis = () => { if (document.visibilityState === 'visible') load(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onVis); };
  }, [view]);

  useEffect(() => {
    const h = (e) => { if (bellRef.current && !bellRef.current.contains(e.target)) setBellOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  const totalUnread = (status?.accounts || []).reduce((s, a) => s + (a.unreadTotal || 0), 0);

  const syncAll = async () => {
    setSyncingAll(true);
    try {
      const act = accounts.filter((a) => a.enabled);
      if (!act.length) { toast('没有可同步的账户', 'info'); return; }
      for (const a of act) {
        try { await api.sync(a.id); } catch (e) { toast(`${a.name}：${e.message}`, 'error'); }
      }
      toast('同步完成', 'success');
    } finally {
      setSyncingAll(false);
      refreshStatus();
      bumpList();
    }
  };

  const ack = async (id, kind) => {
    if (kind === 'digest') { try { await api.post('/api/digest/ack'); } catch { /* */ } }
    else { try { await api.post('/api/notifications/ack', { id }); } catch { /* */ } }
    setBellList((l) => l.filter((x) => !(kind === 'digest' ? x.kind === 'digest' : x.id === id)));
  };

  /** 点击通知：新邮件 → 直接打开对应邮件；提醒 → 关闭；汇总 → 打开智能收件箱 */
  const openNotice = async (it) => {
    if (it.kind === 'digest') { await ack(it.id, 'digest'); setView('smart'); return; }
    if (it.type === 'newmail' && it.items?.[0]?.id) {
      useStore.getState().selectMessage(it.items[0].id);
      setView('mail');
    }
    await ack(it.id, it.kind);
  };

  const notifyAll = async () => {
    const items = bellList.filter((x) => x.kind === 'reminder' || x.type === 'newmail');
    if (items.length) {
      await Promise.all(items.map((x) => api.post('/api/notifications/ack', { id: x.id }).catch(() => {})));
      setBellList((l) => l.filter((x) => !items.some((i) => i.id === x.id)));
    }
  };

  // 桌面系统通知（可选）
  const fireNative = async (title, body) => {
    try {
      if (!('Notification' in window)) return;
      if (Notification.permission === 'granted') new Notification(title, { body });
      else if (Notification.permission !== 'denied') await Notification.requestPermission();
    } catch { /* */ }
  };
  useEffect(() => {
    if (!bellList.length) return;
    // 对“尚未弹出过系统通知”的新项目逐条通知（新邮件 / 事件提醒），随后标记 seen
    const fresh = bellList.filter((x) => x.seen === false && (x.type === 'newmail' || x.kind === 'reminder'));
    if (!fresh.length) return;
    const first = fresh[0];
    if (first.type === 'newmail') {
      fireNative(first.title || '收到新邮件', first.body || '');
    } else {
      fireNative('邮件提醒', first.event?.title || '');
    }
    api.post('/api/notifications/seen', { ids: fresh.map((x) => x.id) }).catch(() => {});
    setBellList((l) => l.map((x) => (fresh.some((f) => f.id === x.id) ? { ...x, seen: true } : x)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bellList]);

  return (
    <header className="topbar">
      <div className="brand">
        <div className="brand-logo"><Mail size={17} /></div>
        <div className="brand-text">学生邮件查看器</div>
        <span className="brand-tag">仅查看</span>
      </div>

      <nav className="top-nav">
        {VIEWS.map((v) => {
          const Icon = v.icon;
          const badge = v.key === 'mail' && totalUnread > 0 ? totalUnread : 0;
          return (
            <button key={v.key} className={`nav-btn${view === v.key ? ' active' : ''}`} onClick={() => setView(v.key)}>
              <Icon size={16} />
              <span>{v.label}</span>
              {badge > 0 && <span className="nav-badge">{badge > 99 ? '99+' : badge}</span>}
            </button>
          );
        })}
      </nav>

      <div className="top-right">
        <button className="btn ghost" title="同步全部 IMAP 账户" onClick={syncAll} disabled={syncingAll}>
          <RefreshCw size={15} className={syncingAll ? 'spin' : ''} />
          <span>刷新</span>
        </button>
        <button className="btn primary" onClick={() => setNewAccountOpen(true)} title="添加本机 Outlook / IMAP 账户">
          <Plus size={15} /><span>添加账户</span>
        </button>

        <div className="bell-wrap" ref={bellRef}>
          <button className="icon-btn" title="提醒与每日汇总" onClick={() => setBellOpen((o) => !o)}>
            <Bell size={16} />
            {bellList.length > 0 && <span className="dot-red" />}
          </button>
          {bellOpen && (
            <div className="bell-pop">
              <div className="bell-head">
                <b>提醒中心</b>
                {bellList.some((x) => x.kind === 'reminder' || x.type === 'newmail') && <button className="link-btn" onClick={notifyAll}>全部已读</button>}
              </div>
              <div className="bell-list">
                {!bellList.length && <div className="bell-empty"><Inbox size={20} />暂无新提醒</div>}
                {bellList.map((it) => (
                  <div className="bell-item" key={it.kind + (it.id || it.generatedAt || '')} onClick={() => openNotice(it)}>
                    {it.kind === 'digest' ? (
                      <>
                        <div className="bell-item-title"><Sparkles size={13} /> 每日未读重点汇总</div>
                        <div className="bell-item-sub">新到未读重点邮件 {it.count} 封（点击查看）</div>
                      </>
                    ) : it.type === 'newmail' ? (
                      <>
                        <div className="bell-item-title"><MailPlus size={13} /> {it.title || `收到 ${it.count} 封新邮件`}</div>
                        <div className="bell-item-sub">{it.body || ''}（点击打开最新一封）</div>
                      </>
                    ) : (
                      <>
                        <div className="bell-item-title" style={{ color: it.event?.color || undefined }}>⏰ {it.event?.title}</div>
                        <div className="bell-item-sub">事件提醒已到（点击关闭）</div>
                      </>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <button className="icon-btn" title={theme === 'dark' ? '切换浅色模式' : '切换深色模式'} onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
          {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
        </button>
      </div>
      <Toasts toasts={useStore.getState().toasts} />
    </header>
  );
}
