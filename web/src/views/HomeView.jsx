// 首页：推荐活动 / 重要邮件 / 临近截止 / 未读速览 / 低相关邮件（AI worth 驱动，每封邮件只归属一列）
import React, { useEffect, useRef, useState } from 'react';
import { Sparkles, RefreshCw, Star, CalendarClock, Mail, Trophy, AlertTriangle, Paperclip, Archive, CheckCircle2, RotateCcw, X } from 'lucide-react';
import { useStore, M } from '../store.js';
import { api, fmtDate, dayLabel } from '../api.js';
import FolderColumn from '../components/FolderColumn.jsx';
import ReaderPane from '../components/ReaderPane.jsx';
import { Spinner, Empty, Modal } from '../components/common.jsx';

const SECTION_ICON = { recommend: Trophy, important: Star, upcoming: CalendarClock, unread: Mail, low: Archive };

export default function HomeView() {
  const { accountId, messageId, closeMessage, status, listKey, toast } = useStore();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [doneOpen, setDoneOpen] = useState(false);
  const [doneData, setDoneData] = useState(null);

  // BUG-57：listKey 在「任何」列表动作后都会递增（标记已读/星标/标签/已处理/同步…），
  // 原先每次变化都立即重取 /home，且 accountId 未变时等同重复请求同一份数据。
  // 这里统一走去抖 + 并发去重：300ms 内的多次触发只发一次，
  // 已在途时不再叠加（用 inFlight ref），避免用户连点卡片打出一串请求。
  const debounceRef = useRef(null);
  const inFlightRef = useRef(false);
  const pendingRef = useRef(false);

  const load = () => {
    if (inFlightRef.current) { pendingRef.current = true; return; }
    inFlightRef.current = true;
    const qs = accountId ? `?accountId=${encodeURIComponent(accountId)}` : '';
    api.get(`/api/home${qs}`)
      .then((r) => setData(r))
      .catch(() => setData(null))
      .finally(() => {
        inFlightRef.current = false;
        setLoading(false);
        // 在途期间又有触发 → 补一次，保证最终状态是最新的
        if (pendingRef.current) { pendingRef.current = false; load(); }
      });
  };
  const loadDebounced = () => {
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(load, 300);
  };
  const loadDone = () => {
    const qs = accountId ? `?accountId=${encodeURIComponent(accountId)}` : '';
    api.get(`/api/home/done${qs}`).then((r) => setDoneData(r)).catch(() => setDoneData(null));
  };

  useEffect(() => { setLoading(true); load(); /* eslint-disable-next-line */ }, [accountId]);
  useEffect(() => {
    const t = setInterval(load, 60000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId]);
  // 同步完成（lastSyncAt 变化）→ 立即刷新；列表动作（listKey）→ 去抖刷新
  const syncSig = (status?.accounts || []).map((a) => a.lastSyncAt).join(',');
  useEffect(() => { if (syncSig) load(); /* eslint-disable-next-line */ }, [syncSig]);
  useEffect(() => { loadDebounced(); /* eslint-disable-next-line */ }, [listKey]);
  // 卸载时清掉待触发的去抖定时器，避免对已卸载组件 setState
  useEffect(() => () => clearTimeout(debounceRef.current), []);

  const open = (item) => useStore.getState().openMessage(item);
  const markDone = async (item, done) => {
    try {
      await api.post(`/api/messages/${item.id}/done`, { done });
      toast(done ? '已处理：该邮件已从首页隐藏（可在左下角找回）' : '已取消已处理', 'success');
      if (doneOpen) loadDone();
      useStore.getState().bumpList();
    } catch (e) { toast(e.message, 'error'); }
  };
  const openDoneArchive = () => { setDoneOpen(true); loadDone(); };

  return (
    <div className={`home-layout${messageId ? ' has-reader' : ''}`}>
      <FolderColumn />
      <div className="home-main">
        <div className="home-head">
          <Sparkles size={16} />
          <b>首页</b>
          <span className="dim">按“是否值得花时间”排序：值得参加的活动与必须处理的邮件</span>
          <div className="home-head-right">
            {data && !data.aiEnabled && (
              <span className="home-ai-warn" title="未启用 AI 时使用本地关键词规则判定，配置 Key 后更准确">
                <AlertTriangle size={12} /> 本地规则判定（设置 → AI 智能 可更准）
              </span>
            )}
            {data?.aiEnabled && <span className="chat-engine">AI 判定已启用</span>}
            <button className="mini-btn" onClick={() => { setLoading(true); load(); }}><RefreshCw size={12} /> 刷新</button>
          </div>
        </div>

        <div className="home-scroll">
          {loading && !data && <div className="list-loading"><Spinner /> 正在整理你的邮件…</div>}
          {data && (
            <div className="home-grid">
              {(data.sections || []).map((sec) => {
                const Icon = SECTION_ICON[sec.key] || Mail;
                return (
                  <section className="home-col" key={sec.key}>
                    <div className="home-col-head">
                      <Icon size={14} />
                      <b>{sec.title}</b>
                      <span className="home-col-count">{sec.items.length}</span>
                    </div>
                    <div className="dim home-col-sub">{sec.subtitle}</div>
                    <div className="home-cards">
                      {!sec.items.length && <Empty icon={<Icon size={22} />} text="暂无内容" />}
                      {sec.items.map((it) => (
                        <div className={`home-card${it.read ? ' read' : ''}${messageId === it.id ? ' sel' : ''}`} key={sec.key + it.id}
                          data-id={it.id} onClick={() => open(it)} title={it.subject}>
                          <div className="home-card-top">
                            {it.worth >= 3 && <span className="worth-badge w3">必须处理</span>}
                            {it.worth === 2 && <span className="worth-badge w2">推荐</span>}
                            <span className="cat-badge" style={{ background: M.catColor(it.category, useStore.getState().categoryColors), color: '#fff' }}>
                              {M.catLabel(it.category, useStore.getState().categories)}
                            </span>
                            {it.hasAttachments && <Paperclip size={11} className="dim" />}
                            <button className="card-done-btn" title="标记为已处理：仅在本机归档，从首页隐藏（不改动邮箱未读状态）"
                              onClick={(e) => { e.stopPropagation(); markDone(it, true); }}>
                              <CheckCircle2 size={12} /> 已处理
                            </button>
                            <span className="home-card-date">{it.deadlineMs ? dayLabel(it.deadlineMs) : fmtDate(it.dateMs)}</span>
                          </div>
                          <div className="home-card-subject">{it.subject || '(无主题)'}</div>
                          <div className="home-card-from dim">
                            {it.fromName || it.fromAddr}
                            {it.accountName ? ` · ${it.accountName}` : ''}
                          </div>
                          {(it.worthReason || it.aiSummary || it.snippet) && (
                            <div className="home-card-why">
                              {it.worthReason && <span className="why-tag">{it.worthReason}</span>}
                              {it.deadlineMs && <span className="why-tag deadline">⏰ {fmtDate(it.deadlineMs, { full: true })}</span>}
                              <span className="why-text">{it.aiSummary || it.snippet}</span>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </section>
                );
              })}
            </div>
          )}
          {!loading && !data && <Empty text="暂时无法加载首页数据（请确认服务已启动）" />}
        </div>

        {/* 左下角：重要已处理入口 */}
        <div className="home-foot">
          <button className="btn ghost done-archive-btn" onClick={openDoneArchive} title="查看已标记为“已处理”的重要邮件（仅本机归档）">
            <Archive size={14} /> 重要已处理
            {data?.doneImportant > 0 && <span className="done-count">{data.doneImportant}</span>}
          </button>
          <span className="dim">「已处理」只在本机归档：这些邮件不会出现在上方各列，可在这里找回或取消。它不会改动邮箱里的已读状态。</span>
        </div>
      </div>
      {messageId ? <ReaderPane onBack={closeMessage} /> : <div className="reader-placeholder" />}

      {doneOpen && (
        <Modal title="重要已处理邮件" onClose={() => setDoneOpen(false)} wide footer={(
          <div className="modal-actions"><button className="btn primary" onClick={() => setDoneOpen(false)}>关闭</button></div>
        )}>
          {!doneData && <div className="list-loading"><Spinner /> 加载中…</div>}
          {doneData && !doneData.items.length && <Empty icon={<Archive size={26} />} text="还没有已处理的重要邮件" sub="在阅读窗格点「标记为已处理」即可把处理完的邮件归档到这里" />}
          {doneData && doneData.items.length > 0 && (
            <div className="done-list">
              {doneData.items.map((it) => (
                <div className="done-item" key={it.id}>
                  <div className="done-item-main" onClick={() => { open(it); setDoneOpen(false); }}>
                    <div className="done-item-subject">
                      {it.important && <Star size={11} fill="currentColor" style={{ color: '#f59e0b' }} />}
                      {it.subject || '(无主题)'}
                    </div>
                    <div className="dim">
                      {it.fromName || it.fromAddr} · {fmtDate(it.dateMs)}
                      {it.accountName ? ` · ${it.accountName}` : ''}
                      {it.worthReason ? ` · ${it.worthReason}` : ''}
                    </div>
                  </div>
                  <button className="mini-btn" onClick={() => markDone(it, false)}><RotateCcw size={12} /> 取消已处理</button>
                </div>
              ))}
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}
