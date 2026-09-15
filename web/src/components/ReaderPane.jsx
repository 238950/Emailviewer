// 阅读窗格：邮件头、HTML/文本渲染、附件、AI 摘要、日期提取 → 日历
import React, { useEffect, useMemo, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import { Mail, ChevronLeft, Star, StarOff, Paperclip, Download, Save, Sparkles, Tag, CalendarPlus, Image as ImageIcon, FileText, X, ExternalLink, Clock, RotateCcw, Info, CheckCircle2, MessageSquare } from 'lucide-react';
import { useStore, M } from '../store.js';
import { api, attUrl, downloadAttachment, fmtBytes, fmtDate, dayLabel } from '../api.js';
import { Spinner, Empty, IconBtn, Modal, Chip, PopMenu, ConfirmDialog } from './common.jsx';
import FileViewer from './FileViewer.jsx';

const MAX_INLINE_IMAGE_MB = 15;

export default function ReaderPane({ onBack }) {
  const store = useStore();
  const { messageId, msgVersion, categories, categoryColors, toast, accounts, bumpList } = store;
  const [detail, setDetail] = useState(null);
  const [attachments, setAttachments] = useState([]);
  const [events, setEvents] = useState([]);
  const [dates, setDates] = useState([]);
  const [datesIgnored, setDatesIgnored] = useState(false);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState('');
  const [showRemote, setShowRemote] = useState(false);
  const [showFullHeaders, setShowFullHeaders] = useState(false);
  const [busy, setBusy] = useState('');
  const [addingEvent, setAddingEvent] = useState(null);
  const [preview, setPreview] = useState(null);
  const [labelOpen, setLabelOpen] = useState(false);
  const [menu, setMenu] = useState(null);
  const [ask, setAsk] = useState(null);       // 待确认的危险操作（删除日程等）
  const bodyRef = useRef(null);

  useEffect(() => {
    if (messageId == null) {
      setDetail(null); setAttachments([]); setEvents([]); setDates([]); setDatesIgnored(false);
      return;
    }
    // 切换邮件时必须先清空上一封的详情与附属数据。
    // 而所有按钮已指向新的 messageId —— 用户以为在操作 A，实际改的是 B
    //（已读/星标/标签/已处理全部错位），属会造成真实副作用的对象错位。
    setDetail(null); setAttachments([]); setEvents([]); setDates([]); setDatesIgnored(false);
    setLoading(true); setFetchError(''); setShowRemote(false); setPreview(null);
    let dead = false;
    api.message(messageId)
      .then(async (r) => {
        if (dead) return;
        // 双重保险：响应返回时若已切到其它邮件（或服务端返回了非本次请求的邮件），直接丢弃
        if (String(r.message?.id) !== String(messageId)) return;
        setDetail(r.message); setAttachments(r.attachments || []); setEvents(r.events || []);
        if (r.fetchError) setFetchError(r.fetchError);
        // 自动标记已读（可在 设置 → 外观 关闭，关掉后完全不动邮箱的未读状态）
        if (!r.message.read && useStore.getState().settings?.markReadOnOpen !== false) {
          try { await api.post(`/api/messages/${r.message.id}/read`, { read: true }); } catch { /* */ }
          store.refreshStatus(true); bumpList();
        }
        // 预取可提取日期
        try {
          const d = await api.get(`/api/messages/${r.message.id}/dates`);
          if (!dead) { setDates(d.candidates || []); setDatesIgnored(d.source === 'ignored'); }
        } catch { /* */ }
      })
      .catch((e) => { if (!dead) setFetchError(e.message); })
      .finally(() => { if (!dead) setLoading(false); });
    return () => { dead = true; };
  }, [messageId, msgVersion]);

  const html = useMemo(() => {
    if (!detail || !detail.bodyHtml) return '';
    const cidMap = {};
    const inlinePool = [];
    for (const a of attachments) {
      if (a.contentId) cidMap[String(a.contentId).trim().replace(/^<|>$/g, '')] = a.id;
      if (a.contentId && a.disposition === 'inline') inlinePool.push(a.id);
    }
    const node = new DOMParser().parseFromString(detail.bodyHtml, 'text/html');
    let poolIdx = 0;
    node.querySelectorAll('img').forEach((img) => {
      const src = img.getAttribute('src') || '';
      if (src.startsWith('cid:')) {
        const key = src.slice(4).replace(/[<>]/g, '').trim();
        // 兜底：cid 未命中时，按正文中出现顺序与内嵌附件依次配对
        const id = cidMap[key] || inlinePool[poolIdx++];
        if (id) {
          img.setAttribute('src', attUrl(id));
        } else {
          // 仍无法匹配 → 显式占位，避免裂图
          const ph = node.createElement('span');
          ph.className = 'img-missing';
          ph.textContent = '🖼 内嵌图片未能加载';
          img.replaceWith(ph);
        }
      } else if (/^https?:\/\//.test(src)) {
        img.setAttribute('data-remote', src);
        img.setAttribute('src', '');
        img.style.minHeight = '40px';
      }
    });
    return DOMPurify.sanitize(node.body ? node.body.innerHTML : detail.bodyHtml, {
      USE_PROFILES: { html: true },
      ADD_ATTR: ['data-remote'],
    });
    // 依赖中不含 showRemote。函数体从未读取它——远程图片的填充由下方
    // 独立 effect 在 showRemote 变化时直接操作 DOM 完成。把 showRemote 放进依赖
    // 会让每次"加载远程图片"都白白重跑一遍 DOMPurify 净化，并因 DOM 被重建
    // 导致图片"先闪一下再出现"。useMemo 依赖应精确反映函数体实际使用的值。
  }, [detail, attachments]);

  // 内嵌图片（有 contentId 且 inline）已渲染在正文里，不在附件区重复展示（附带问题）
  const visibleAtts = useMemo(
    () => (attachments || []).filter((a) => !(a.contentId && a.disposition === 'inline')),
    [attachments],
  );

  // 远程图片填充
  useEffect(() => {
    if (!bodyRef.current || !showRemote) return;
    bodyRef.current.querySelectorAll('img[data-remote]').forEach((img) => {
      img.setAttribute('src', img.getAttribute('data-remote'));
      img.removeAttribute('style');
    });
  }, [showRemote, html]);

  // 注意：所有 hooks 必须在本条件 return 之前声明，否则切换选中邮件时
  // 会触发 React “Rendered more hooks than during the previous render” 崩溃。
  const hasRemote = useMemo(() => /<img[^>]+data-remote/.test(html), [html]);

  if (!messageId) {
    return (
      <div className="reader empty-reader">
        <Empty icon={<Mail size={30} />} text="选择一封邮件开始阅读" sub="点击左侧列表中的邮件即可预览（本查看器仅用于阅读）" />
      </div>
    );
  }

  // 正文未到时先用“列表行快照”即时渲染头部（发件人/主题/标签），避免预览长时间空白
  const draft = store.messageDraft && store.messageDraft.id === messageId ? store.messageDraft : null;
  const m = detail || draft;

  // 这两个操作原先在 catch 之后仍执行 setDetail 乐观更新，
  // 于是接口失败时界面显示"已加星标/已读"，服务端其实没变，用户被界面误导。
  // 现在失败即 return，只有成功才更新本地状态；并校验 detail 仍属于当前邮件。
  const doFlag = async (important) => {
    try { await api.post(`/api/messages/${messageId}/flag`, { important }); }
    catch (e) { toast(e.message, 'error'); return; }
    setDetail((d) => (d && String(d.id) === String(messageId) ? { ...d, important } : d));
    bumpList();
  };
  const doRead = async (read) => {
    try { await api.post(`/api/messages/${messageId}/read`, { read }); }
    catch (e) { toast(e.message, 'error'); return; }
    setDetail((d) => (d && String(d.id) === String(messageId) ? { ...d, read } : d));
    store.refreshStatus(true); bumpList();
  };
  /** 仅在详情仍属于当前邮件时更新本地字段（的配套保护：避免旧响应写回新邮件） */
  const patchDetail = (patch) => setDetail((d) => (d && String(d.id) === String(messageId) ? { ...d, ...patch } : d));

  const doLabel = async (label) => {
    try {
      const cur = (m.labels || []).includes(label);
      await api.post(`/api/messages/${messageId}/label`, { label, add: !cur });
      patchDetail({ labels: cur ? (m.labels || []).filter((x) => x !== label) : [...(m.labels || []), label] });
    } catch (e) { toast(e.message, 'error'); }
    bumpList();
  };
  const doClassify = async () => {
    setBusy('classify');
    try {
      const r = await api.post(`/api/messages/${messageId}/classify`);
      patchDetail({
        category: r.result.category, categoryReason: r.result.reason,
        // ②：摘要来源要如实标注（AI 模型名 / 本地关键词），不再硬编码 'local'
        aiSummary: r.result.summary || m?.aiSummary,
        aiSummaryModel: r.result.model || (r.result.summary ? 'ai' : 'local'),
      });
      toast(`已分类为「${M.catLabel(r.result.category, categories)}」`, 'success');
    } catch (e) { toast(e.message, 'error'); } finally { setBusy(''); }
  };
  const doSummarize = async () => {
    setBusy('summarize');
    try {
      const r = await api.post(`/api/messages/${messageId}/summarize`);
      patchDetail({ aiSummary: r.result.summary, aiSummaryModel: r.result.model });
      toast('已生成一句话摘要', 'success');
    } catch (e) { toast(e.message, 'error'); } finally { setBusy(''); }
  };
  const saveAtt = async (att) => {
    try {
      const r = await api.post(`/api/attachments/${att.id}/save`);
      toast(`已保存到：${r.savedTo}`, 'success');
    } catch (e) { toast(e.message, 'error'); }
  };

  /** 标记/取消“已处理（本机归档）”：与「已读」不同，只在本地隐藏，不改邮箱状态 */
  const doDone = async (done) => {
    try {
      await api.post(`/api/messages/${messageId}/done`, { done });
      patchDetail({ done });
      toast(done ? '已标记为已处理：首页将隐藏这封邮件（左下角「重要已处理」可找回）' : '已取消已处理', 'success');
      bumpList();
    } catch (e) { toast(e.message, 'error'); }
  };
  const askAI = () => {
    useStore.getState().sendMailToAI([messageId], '请阅读这封邮件：它讲了什么？需要我做什么？有没有截止时间或值得参加的信息？');
    toast('已把这封邮件发给 AI 助手', 'success');
  };
  /** 把检测到的所有时间一键加入内置日历（同一时间点只建一条，重复点击不会重复建） */
  const addAllDates = async () => {
    if (!dates.length) return;
    setBusy('dates');
    try {
      // 已在日历里的时间点（同一封邮件 + 同一小时）视为已安排，避免重复
      const existRes = await api.get(`/api/events?start=${Date.now() - 86400000}`);
      const existing = new Set((existRes.events || [])
        .filter((e) => String(e.messageId || '') === String(messageId))
        .map((e) => `${String(e.messageId)}|${Math.round(e.startMs / 3600000)}`));
      let n = 0;
      let dup = 0;
      for (const c of dates) {
        const key = `${messageId}|${Math.round(c.ms / 3600000)}`;
        if (existing.has(key)) { dup++; continue; }
        try {
          await api.post('/api/events', {
            title: String(c.context || m?.subject || '邮件日程').slice(0, 40),
            startMs: c.ms, endMs: c.ms + 3600000, allDay: false,
            messageId, source: 'auto',
            color: c.type === 'due' ? '#ef4444' : (c.type === 'exam' ? '#8b5cf6' : '#10b981'),
            remindOffsets: [-1440],
            note: `来自邮件「${String(m?.subject || '').slice(0, 60)}」\n识别片段：${c.context || ''}`,
          });
          existing.add(key);
          n++;
        } catch { /* 单个失败继续 */ }
      }
      toast(dup ? `已加入 ${n} 个时间，跳过 ${dup} 个已存在的日程` : `已把 ${n} 个时间加入内置日历`, 'success');
      const r2 = await api.get(`/api/messages/${messageId}`);
      setEvents(r2.events || []);
    } catch (e) { toast(e.message, 'error'); } finally { setBusy(''); }
  };

  /**
   * 识别有误时一键忽略，不再污染首页「临近截止」与日历。
   * 忽略状态现在会持久化（dates_ignored），刷新/重开邮件后依然生效。
   */
  const ignoreDates = async () => {
    setBusy('dates');
    try {
      await api.post(`/api/messages/${messageId}/dates/clear`, { ignored: true });
      toast('已忽略这封邮件识别出的时间', 'success');
      setDates([]);
      setDatesIgnored(true);
      bumpList();
    } catch (e) { toast(e.message, 'error'); } finally { setBusy(''); }
  };
  /** 忽略后提供恢复入口，避免成为无法回退的死路 */
  const restoreDates = async () => {
    setBusy('dates');
    try {
      await api.post(`/api/messages/${messageId}/dates/clear`, { ignored: false });
      const d = await api.get(`/api/messages/${messageId}/dates`);
      setDates(d.candidates || []);
      setDatesIgnored(d.source === 'ignored');
      toast((d.candidates || []).length ? '已恢复识别结果' : '已恢复识别（这封邮件没有可识别的时间）', 'success');
      bumpList();
    } catch (e) { toast(e.message, 'error'); } finally { setBusy(''); }
  };

  const headerKeys = ['date', 'messageId', 'replyTo', 'inReplyTo', 'references', 'contentType', 'returnPath', 'deliveredTo', 'xOriginalTo', 'listUnsubscribe'];

  return (
    <div className="reader">
      <div className="reader-head">
        <div className="reader-titlebar">
          {onBack && <IconBtn title="返回" onClick={onBack}><ChevronLeft size={16} /></IconBtn>}
          <div className="r-subject" title={m?.subject}>{m?.subject || '（无主题）'}</div>
          {m && <div className="r-actions">
            <IconBtn title={m.read ? '标为未读' : '标为已读'} onClick={() => doRead(!m.read)}><Mail size={15} /></IconBtn>
            <IconBtn title="星标" active={m.important} onClick={() => doFlag(!m.important)}>{m.important ? <Star size={15} fill="currentColor" /> : <StarOff size={15} />}</IconBtn>
            <IconBtn title="把这封邮件发给 AI 助手（可追问）" onClick={() => {
              useStore.getState().sendMailToAI([messageId], '请阅读这封邮件：它讲了什么？需要我做什么？有没有截止时间或值得参加的信息？');
              toast('已把这封邮件发给 AI 助手', 'success');
            }}><MessageSquare size={15} /></IconBtn>
            <IconBtn title="AI 重新分类" onClick={doClassify}>{busy === 'classify' ? <Spinner /> : <Sparkles size={15} />}</IconBtn>
            <IconBtn title="生成一句话摘要" onClick={doSummarize}>{busy === 'summarize' ? <Spinner /> : <FileText size={15} />}</IconBtn>
            <IconBtn title="标记标签" onClick={(e) => setMenu({ x: e.clientX, y: e.clientY })}><Tag size={15} /></IconBtn>
          </div>}
        </div>
        {m && (
          <div className="ai-cta-row">
            <button className="btn ai-cta" onClick={askAI} title="把这封邮件交给 AI：总结要点、提取待办与截止时间">
              <MessageSquare size={15} /> 让 AI 读这封邮件
              <span className="ai-cta-sub">总结要点 · 提取待办与截止时间</span>
            </button>
            <button className={`btn ${m.done ? 'ghost' : ''} done-btn`} onClick={() => doDone(!m.done)} title="“已处理”只在本机归档（从首页隐藏），不改动邮箱的已读状态；可在首页左下角「重要已处理」找回">
              {m.done ? <><RotateCcw size={14} /> 已处理（点击取消）</> : <><CheckCircle2 size={14} /> 标记为已处理</>}
            </button>
          </div>
        )}
        {m && (
          <div className="r-meta">
            <span className="sender-avatar big" style={{ background: dotColor(m, accounts) }}>{(m.fromName || m.fromAddr || '?').charAt(0)}</span>
            <div className="r-meta-main">
              <div className="r-from">
                {m.fromName && <b>{m.fromName}</b>}
                <span className="r-addr">{m.fromAddr}</span>
                {m.important && <Chip color="#f59e0b">★ 重要</Chip>}
                <span className="cat-badge" style={{ background: M.catColor(m.category, categoryColors), color: '#fff' }}>{M.catLabel(m.category, categories)}</span>
                {/* 把「已读」（会同步回邮箱）与「已处理」（仅本机归档）两个状态分开显示 */}
                <Chip color={m.read ? '#64748b' : '#22c55e'} title={m.read ? '邮箱里的状态为已读' : '邮箱里的状态为未读'}>{m.read ? '已读' : '未读'}</Chip>
                {m.done && <Chip color="#0ea5e9" title="仅在本机归档：首页不再显示，不影响邮箱">已处理（本机归档）</Chip>}
                {(m.labels || []).map((l) => <Chip key={l} color="#8b5cf6" onClick={() => doLabel(l)} title="再次点击移除标签">{l}</Chip>)}
              </div>
              <div className="r-to dim">收件人：{(m.toList || []).join('; ') || '我'}</div>
              <div className="r-time dim">
                {fmtDate(m.dateMs, { full: true })}
                {m.size > 0 && <span> · 大小 {fmtBytes(m.size)}</span>}
                {m.categoryReason && <span> · 分类依据：{m.categoryReason}</span>}
                {m.categoryModel && <span> · 引擎：{m.categoryModel}</span>}
                <button className="link-btn" onClick={() => setShowFullHeaders((v) => !v)}>{showFullHeaders ? '收起完整头' : '查看完整邮件头'}</button>
              </div>
            </div>
            <div className="r-right">
              <div className="r-account-chip" style={{ borderColor: (accounts.find((a) => a.id === m.accountId) || {}).color }}>
                <span className="acc-dot" style={{ background: (accounts.find((a) => a.id === m.accountId) || {}).color }} />
                {m.accountName || ''}
              </div>
            </div>
          </div>
        )}
        {showFullHeaders && m?.headers && (
          <div className="r-headers">
            {headerKeys.filter((k) => m.headers[k]).map((k) => (
              <div key={k}><span className="dim">{k}:</span> <code>{String(m.headers[k]).slice(0, 400)}</code></div>
            ))}
          </div>
        )}
      </div>

      <div className="reader-body-scroll">
        {loading && (
          <div className="list-loading">
            <Spinner /> 正在加载正文{draft ? '（信封信息已显示，正文抓取中…）' : '（首次打开可能需要连接邮箱抓取正文）…'}
          </div>
        )}

        {m && m.aiSummary && (
          <div className="ai-summary-box" style={{ borderColor: M.catColor(m.category, categoryColors) }}>
            <Sparkles size={14} /> <b>一句话摘要：</b>
            <span>{m.aiSummary}</span>
            <span className="dim">（{m.aiSummaryModel === 'local' ? '本地关键词提取' : `AI · ${m.aiSummaryModel}`}）</span>
          </div>
        )}

        {fetchError && (
          <div className="fetch-error">
            <Info size={14} />
            <div>
              <b>正文获取失败：</b>{fetchError}
              <div className="dim">可能是网络或邮箱服务器暂时不可用。</div>
            </div>
            {/*
 * 这是魔法数字竞态（时序一变就点了没反应），且 timer 无清理——
 * 用户快速切走邮件后它仍会执行，把旧邮件强行弹回来。
 * selectMessage 内部本就会递增 msgVersion，直接调用即可触发重取。
 */}
            <button className="mini-btn" onClick={() => store.selectMessage(messageId)}><RotateCcw size={12} /> 重试</button>
          </div>
        )}

        {hasRemote && !showRemote && (
          <div className="remote-bar">
            <ImageIcon size={13} />
            此邮件包含远程图片（可能用于追踪阅读）。为保护隐私默认不加载。
            <button className="mini-btn" onClick={() => setShowRemote(true)}><ImageIcon size={12} /> 加载远程图片</button>
          </div>
        )}

        {!loading && !fetchError && m && (
          <div className="r-body" ref={bodyRef}>
            {m.bodyHtml && !fetchError ? (
              <div className="r-html" dangerouslySetInnerHTML={{ __html: html }} />
            ) : m.bodyText ? (
              <pre className="r-text">{m.bodyText}</pre>
            ) : (
              <Empty text="该邮件没有可显示的正文（或正文较大已省略）" icon={<FileText size={26} />} />
            )}
          </div>
        )}

        {!loading && m && visibleAtts.length > 0 && (
          <div className="att-list">
            <div className="sec-title"><Paperclip size={13} /> 附件（{visibleAtts.length}）</div>
            {visibleAtts.map((a) => {
              const isImg = (a.mime || '').startsWith('image/');
              const isPdf = a.mime === 'application/pdf';
              const isText = /^text\/|json|xml/.test(a.mime || '');
              const big = a.size > MAX_INLINE_IMAGE_MB * 1048576;
              return (
                <div className="att-chip" key={a.id}>
                  {isImg && !big ? <img className="att-thumb" src={attUrl(a.id)} alt="" loading="lazy" onClick={() => setPreview(a)} />
                    : <FileText size={20} className="att-ic" style={{ color: M.catColor(a.group === 'image' ? 'other' : 'course', categoryColors) }} />}
                  <div className="att-info">
                    <div className="att-name" title={a.filename}>{a.filename}</div>
                    <div className="att-meta dim">{fmtBytes(a.size)} · {a.mime}</div>
                  </div>
                  <div className="att-actions">
                    {(isImg || isPdf || isText) && !big && <IconBtn title="预览" onClick={() => setPreview(a)}><ExternalLink size={13} /></IconBtn>}
                    <IconBtn title="下载" onClick={() => downloadAttachment(a.id, a.filename).catch((e) => toast(e.message, 'error'))}><Download size={13} /></IconBtn>
                    <IconBtn title="保存到本地文件夹" onClick={() => saveAtt(a)}><Save size={13} /></IconBtn>
                  </div>
                </div>
              );
            })}
            {!fetchError && <div className="att-foot dim">大附件提示：超过 {MAX_INLINE_IMAGE_MB}MB 的图片附件默认仅提供下载，避免占用过多存储。</div>}
          </div>
        )}

        {/* 忽略状态可见 + 可恢复，避免用户点过一次"忽略"后无法回退 */}
        {!loading && m && datesIgnored && (
          <div className="date-cands">
            <div className="sec-title">
              <CalendarPlus size={13} /> 已忽略识别到的时间
              <button className="mini-btn" disabled={busy === 'dates'} onClick={restoreDates}>
                {busy === 'dates' ? <Spinner /> : <RotateCcw size={12} />} 恢复识别
              </button>
            </div>
            <div className="dim">这封邮件识别出的时间已被忽略，不会再出现在首页「临近截止」与日历建议里。</div>
          </div>
        )}

        {!loading && m && dates.length > 0 && (
          <div className="date-cands">
            <div className="sec-title">
              <CalendarPlus size={13} /> 识别到的日程时间（{dates.length}）
              <span className="date-src">{dates[0]?.source === 'ai' ? 'AI 提取' : '规则识别'}</span>
              <button className="mini-btn primary-mini" disabled={busy === 'dates'} onClick={addAllDates}>
                {busy === 'dates' ? <Spinner /> : <CalendarPlus size={12} />} 全部加入日历
              </button>
              <button className="mini-btn" disabled={busy === 'dates'} onClick={ignoreDates} title="识别有误？忽略这封邮件的所有时间，不再出现在首页「临近截止」与日历建议里">
                <X size={12} /> 忽略
              </button>
            </div>
            {dates.map((c, i) => (
              <div key={i} className="date-cand" onClick={() => setAddingEvent(c)}>
                <span className="date-cand-icon"><Clock size={13} /></span>
                <div>
                  <div><b>{dayLabel(c.ms)}</b> · {fmtDate(c.ms, { full: true })}
                    <span className={`date-conf ${c.confidence === 'high' || c.source === 'ai' ? 'high' : 'mid'}`}>
                      {c.source === 'ai' ? 'AI' : (c.confidence === 'high' ? '高置信' : '参考')}
                    </span>
                  </div>
                  <div className="dim">「{c.context}」{c.type === 'due' ? ' · 疑似截止/提交' : c.type === 'exam' ? ' · 疑似考试' : c.type === 'event' ? ' · 疑似活动' : ''}</div>
                </div>
                <button className="mini-btn" onClick={(e) => { e.stopPropagation(); setAddingEvent(c); }}>加入日历</button>
              </div>
            ))}
          </div>
        )}

        {!loading && events.length > 0 && (
          <div className="evt-of-msg">
            <div className="sec-title"><CalendarPlus size={13} /> 已加入日历的事件</div>
            {events.map((ev) => (
              <div className="evt-item" key={ev.id}>
                <span className="evt-dot" style={{ background: ev.color }} />
                <div>
                  <b>{ev.title}</b>
                  <div className="dim">{fmtDate(ev.startMs, { full: true })}</div>
                </div>
                <IconBtn danger title="删除该事件" onClick={() => setAsk({
                  title: '删除日程',
                  body: `确定删除日程「${ev.title}」吗？\n${fmtDate(ev.startMs, { full: true })}\n对应的提醒会一并删除，且无法撤销。`,
                  danger: true, confirmText: '删除',
                  onOk: async () => {
                    try { await api.del(`/api/events/${ev.id}`); toast('已删除', 'success'); setEvents((l) => l.filter((x) => x.id !== ev.id)); }
                    catch (e) { toast(e.message, 'error'); }
                  },
                })}>
                  <X size={13} />
                </IconBtn>
              </div>
            ))}
          </div>
        )}
      </div>

      <PopMenu
        open={!!menu}
        onClose={() => setMenu(null)}
        pos={{ left: Math.min(menu?.x || 0, window.innerWidth - 200), top: Math.min(menu?.y || 0, window.innerHeight - 320) }}
        items={menu && m ? [
          { label: m.read ? '标记为未读' : '标记为已读', icon: <Mail size={13} />, onClick: () => doRead(!m.read) },
          { label: m.important ? '取消星标' : '加星标', icon: <Star size={13} />, onClick: () => doFlag(!m.important) },
          { divider: true },
          { label: '添加标签…', icon: <Tag size={13} />, onClick: () => { setMenu(null); setLabelOpen(true); } },
        ] : []}
      />
      {addingEvent && m && <AddEventModal candidate={addingEvent} msg={m} onClose={() => setAddingEvent(null)} onAdded={(ev) => { setEvents((l) => [...l, ev]); toast('已加入内置日历', 'success'); }} />}
      {/* 用主题化 Modal 替代 window.prompt（原生弹窗与暗色主题割裂、无法定制按钮） */}
      {labelOpen && <LabelInputModal
        onClose={() => setLabelOpen(false)}
        onSubmit={(name) => { doLabel(name); setLabelOpen(false); }}
      />}
      {preview && <FileViewer att={preview} onClose={() => setPreview(null)} />}
      <ConfirmDialog req={ask} onClose={() => setAsk(null)} />
    </div>
  );
}

function AddEventModal({ candidate, msg, onClose, onAdded }) {
  const [title, setTitle] = useState(shortTitle(msg.subject, candidate));
  const [allDay, setAllDay] = useState(!candidate.time);
  const [remind, setRemind] = useState('-1440,-120');
  const [endOffsetH, setEndOffsetH] = useState(1);
  const [busy, setBusy] = useState(false);
  const startMs = candidate.ms;
  const remindOpts = [
    { v: '', label: '不提醒' },
    { v: '-120', label: '提前 2 小时' },
    { v: '-1440', label: '提前 1 天' },
    { v: '-1440,-120', label: '提前 1 天 + 当天提前 2 小时' },
  ];
  const submit = async () => {
    setBusy(true);
    try {
      const r = await api.post('/api/events', {
        title, startMs, allDay,
        endMs: allDay ? startMs + 3600000 : startMs + endOffsetH * 3600000,
        messageId: msg.id, source: 'auto', color: '#8b5cf6',
        remindOffsets: remind ? remind.split(',').map(Number) : [],
        note: `来自邮件：「${msg.subject?.slice(0, 60) || ''}」\n识别片段：${candidate.context}`,
      });
      onAdded(r.event); onClose();
    } catch (e) {
      useStore.getState().toast(e.message, 'error');
    } finally { setBusy(false); }
  };
  return (
    <Modal title="加入内置日历" onClose={onClose} footer={(
      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>取消</button>
        <button className="btn primary" disabled={!title.trim() || busy} onClick={submit}>{busy ? <Spinner /> : '确定添加'}</button>
      </div>
    )}>
      <div className="ev-form">
        <input className="inp" value={title} onChange={(e) => setTitle(e.target.value)} />
        <div className="ev-date dim">{fmtDate(startMs, { full: true })}</div>
        <label className="check-row"><input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} /> 全天事件（忽略识别出的具体时间）</label>
        {!allDay && (
          <select className="sel" value={endOffsetH} onChange={(e) => setEndOffsetH(Number(e.target.value))}>
            <option value={0}>时长：0 小时</option>
            <option value={1}>时长：1 小时</option><option value={2}>时长：2 小时</option>
            <option value={4}>时长：4 小时</option>
          </select>
        )}
        <div className="field-label">提醒</div>
        <div className="seg">
          {remindOpts.map((o) => (
            <button key={o.v} className={`seg-btn small${remind === o.v ? ' active' : ''}`} onClick={() => setRemind(o.v)}>{o.label}</button>
          ))}
        </div>
        <div className="dim">识别原文：{candidate.context}</div>
      </div>
    </Modal>
  );
}

function shortTitle(subject, c) {
  const base = (subject || '').replace(/^(【[^】]+】|回复[:：]?\s*|FW[:：]?\s*|转发[:：]?\s*)/i, '').slice(0, 30);
  if (c.type === 'due') return `${base}（截止）`;
  if (c.type === 'exam') return `${base}（考试）`;
  return base;
}

/** 标签输入弹窗，替代 window.prompt */
function LabelInputModal({ onClose, onSubmit }) {
  const [text, setText] = useState('');
  const submit = () => { const v = text.trim(); if (v) onSubmit(v); };
  return (
    <Modal title="添加标签" onClose={onClose} footer={(
      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>取消</button>
        <button className="btn primary" disabled={!text.trim()} onClick={submit}>添加</button>
      </div>
    )}>
      <div className="ev-form">
        <input
          className="inp"
          autoFocus
          placeholder="如：课程、助教、奖学金…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }}
        />
        <div className="dim">标签只保存在本机，不会同步回邮箱服务器。</div>
      </div>
    </Modal>
  );
}

export function dotColor(m, accounts) {
  const acc = (accounts || []).find((a) => a.id === m.accountId);
  if (acc?.color) return acc.color;
  let h = 0;
  const s = String(m.fromAddr || m.fromName || m.id);
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return `hsl(${h}, 55%, 45%)`;
}
