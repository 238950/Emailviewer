// 邮件列表核心组件（邮箱视图 / 智能收件箱 / 分类视图复用）
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Search, Paperclip, Star, StarOff, CheckCheck, ArrowDown, ArrowUp, ChevronLeft, ChevronRight, MoreVertical, Tag, SlidersHorizontal, Inbox, Clock, X } from 'lucide-react';
import { useStore, M } from '../store.js';
import { api, fmtDate, dayLabel } from '../api.js';
import { Spinner, Empty, PopMenu, Modal } from './common.jsx';

const CATEGORY_LIST = ['course', 'assignment', 'grade', 'club', 'system', 'promo', 'spam', 'personal', 'other'];
const SORTS = [
  { k: 'date', label: '按时间' }, { k: 'from', label: '按发件人' }, { k: 'subject', label: '按主题' },
  { k: 'read', label: '按未读' }, { k: 'size', label: '按大小' },
];

export default function MailListView({ title, queryBase = {}, onPick, emptyHint, groupDefault = 'date' }) {
  const store = useStore();
  const { categories, categoryColors, toast, bumpList, listKey, msgVersion } = store;
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const [group, setGroup] = useState(groupDefault);
  const [sort, setSort] = useState('date');
  const [dir, setDir] = useState('desc');
  const [quick, setQuick] = useState('');     // unread | attach | star
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState({ q: '', from: '', bodyQ: '', fromDate: '' });
  const [catSel, setCatSel] = useState([]);
  const [labelSel, setLabelSel] = useState([]);
  const [attType, setAttType] = useState('');
  const [menuMsg, setMenuMsg] = useState(null);
  const [labelModal, setLabelModal] = useState(null); // {msg, labels}
  const searchTimer = useRef(null);

  // 组装查询（依赖用标量，queryBase 仅在其 JSON 变化时重算）
  const qbKey = JSON.stringify(queryBase);
  const builtQuery = useMemo(() => {
    const base = qbKey ? JSON.parse(qbKey) : {};
    const q = { ...base, sort, dir, page, pageSize: 80 };
    if (quick === 'unread') q.unread = true;
    if (quick === 'attach') q.attachment = true;
    if (quick === 'star') q.important = true;
    if (catSel.length) q.category = catSel;
    if (labelSel.length) q.label = labelSel;
    if (search.q) q.q = search.q;
    if (search.from) q.from = search.from;
    if (search.bodyQ) q.bodyQ = search.bodyQ;
    if (search.fromDate) q.fromDate = new Date(Date.now() - Number(search.fromDate) * 86400000).getTime();
    if (attType) q.attachmentType = attType;
    return q;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qbKey, sort, dir, page, quick, catSel, labelSel, search.q, search.from, search.bodyQ, search.fromDate, attType, listKey, msgVersion]);

  useEffect(() => {
    setLoading(true);
    let dead = false;
    api.messages(builtQuery)
      .then((r) => { if (!dead) setData(r); })
      .catch((e) => { if (!dead) toast(e.message, 'error'); setData(null); })
      .finally(() => { if (!dead) setLoading(false); });
    return () => { dead = true; };
  }, [builtQuery]);

  // 键盘 ↑/↓（BUG-07：输入框内不劫持方向键）
  useEffect(() => {
    const h = (e) => {
      const t = e.target;
      if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return;
      if (!data || !data.list.length) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const idx = data.list.findIndex((m) => m.id === store.messageId);
        const next = idx + (e.key === 'ArrowDown' ? 1 : -1);
        if (next >= 0 && next < data.list.length) {
          e.preventDefault();
          store.selectMessage(data.list[next].id);
        }
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [data, store.messageId]);

  const grouped = useMemo(() => {
    if (!data) return [];
    const list = data.list;
    if (group === 'none') return [{ label: '', items: list }];
    const map = new Map();
    for (const m of list) {
      let key = '';
      if (group === 'date') key = dayLabel(m.dateMs);
      else if (group === 'account') key = m.accountName || '未知账户';
      else if (group === 'category') key = M.catLabel(m.category, categories);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(m);
    }
    return [...map.entries()].map(([label, items]) => ({ label, items }));
  }, [data, group, categories]);

  const toggleRead = async (m, read) => {
    try { await api.post(`/api/messages/${m.id}/read`, { read }); } catch (e) { toast(e.message, 'error'); }
    store.refreshStatus(true); bumpList();
  };
  const toggleStar = async (m, important) => {
    try { await api.post(`/api/messages/${m.id}/flag`, { important }); } catch (e) { toast(e.message, 'error'); }
    bumpList();
  };
  const addLabel = async (msg, label) => {
    try { await api.post(`/api/messages/${msg.id}/label`, { label, add: true }); toast(`已添加标签「${label}」`, 'success'); } catch (e) { toast(e.message, 'error'); }
    bumpList();
  };

  const rowsFor = (items) => items.map((m) => {
    const sel = store.messageId === m.id;
    const meta = (m.attMeta || []).filter((a) => !a.inline);
    return (
      <div key={m.id} className={`mail-row${m.read ? ' read' : ''}${sel ? ' sel' : ''}${m.important ? ' starred' : ''}`}
        onClick={() => { store.openMessage(m); store.setView(onPick?.view || store.view); }}
        onDoubleClick={() => onPick?.view && store.setView(onPick.view)}>
        <div className="row-sender" title={m.fromName || m.fromAddr || '(未知发件人)'}>
          <span className="sender-avatar" style={{ background: dotColor(m, store.accounts) }}>
            {(m.fromName || m.fromAddr || '?').charAt(0).toUpperCase()}
          </span>
          <div className="row-sender-main">
            <div className="row-line1">
              <span className="row-from">{m.fromName || m.fromAddr || '(未知)'}</span>
              <span className="row-date">{fmtDate(m.dateMs)}</span>
            </div>
            <div className="row-subject" title={m.subject}>
              <b className="subj">{m.subject || '(无主题)'}</b>
              {meta.length > 0 && <Paperclip size={11} className="clip" />}
            </div>
            <div className="row-snippet">{m.aiSummary || m.snippet || ''}</div>
          </div>
        </div>
        <div className="row-tags">
          <span className="row-unread-dot" />
          <span className="row-star" onClick={(e) => { e.stopPropagation(); toggleStar(m, !m.important); }}>
            {m.important ? <Star size={13} fill="currentColor" /> : <StarOff size={13} />}
          </span>
          {m.category !== 'other' && <span className="cat-badge" style={{ background: M.catColor(m.category, categoryColors), color: '#fff' }}>{M.catLabel(m.category, categories)}</span>}
          {(m.labels || []).slice(0, 2).map((l) => <span key={l} className="label-badge">{l}</span>)}
          <span className="row-menu-btn" onClick={(e) => { e.stopPropagation(); setMenuMsg({ msg: m, x: e.clientX, y: e.clientY }); }}>
            <MoreVertical size={13} />
          </span>
        </div>
      </div>
    );
  });

  return (
    <div className="list-pane">
      <div className="list-toolbar">
        <div className="list-title">{title}
          {data && <span className="list-count">{data.total} 封</span>}
        </div>
        <div className="quick-chips">
          {[['', '全部'], ['unread', '未读'], ['attach', '有附件'], ['star', '星标']].map(([k, lb]) => (
            <button key={k} className={`qchip${quick === k ? ' on' : ''}`} onClick={() => { setQuick(k); setPage(0); }}>{lb}</button>
          ))}
        </div>
        <div className="toolbar-right">
          <select className="sel" value={sort} onChange={(e) => { setSort(e.target.value); setPage(0); }}>
            {SORTS.map((s) => <option key={s.k} value={s.k}>{s.label}</option>)}
          </select>
          <button className="icon-btn" title="切换升/降序" onClick={() => setDir(dir === 'desc' ? 'asc' : 'desc')}>
            {dir === 'desc' ? <ArrowDown size={13} /> : <ArrowUp size={13} />}
          </button>
          <select className="sel" value={group} onChange={(e) => setGroup(e.target.value)} title="分组方式">
            <option value="date">按日期分组</option>
            <option value="account">按账户分组</option>
            <option value="category">按分类分组</option>
            <option value="none">不分组</option>
          </select>
          <button className={`icon-btn${searchOpen ? ' active' : ''}`} title="搜索与高级过滤" onClick={() => setSearchOpen((o) => !o)}>
            <Search size={14} />
          </button>
        </div>
      </div>

      {searchOpen && (
        <div className="search-panel">
          <input className="inp" placeholder="搜主题 / 发件人 / 收件人…" value={search.q}
            onChange={(e) => { setSearch((s) => ({ ...s, q: e.target.value })); clearTimeout(searchTimer.current); searchTimer.current = setTimeout(() => setPage(0), 400); }} />
          <input className="inp" placeholder="正文包含（需已抓取正文）" value={search.bodyQ}
            onChange={(e) => { setSearch((s) => ({ ...s, bodyQ: e.target.value })); clearTimeout(searchTimer.current); searchTimer.current = setTimeout(() => setPage(0), 400); }} />
          <input className="inp" placeholder="发件人含…" value={search.from}
            onChange={(e) => { setSearch((s) => ({ ...s, from: e.target.value })); clearTimeout(searchTimer.current); searchTimer.current = setTimeout(() => setPage(0), 400); }} />
          <select className="sel" value={search.fromDate} onChange={(e) => { setSearch((s) => ({ ...s, fromDate: e.target.value })); setPage(0); }}>
            <option value="">不限日期</option><option value="1">最近 24 小时</option><option value="7">最近 7 天</option>
            <option value="30">最近 30 天</option><option value="90">最近 90 天</option>
          </select>
          <select className="sel" value={attType} onChange={(e) => { setAttType(e.target.value); setPage(0); }} title="按附件类型过滤">
            <option value="">附件类型不限</option>
            <option value="image/">图片</option>
            <option value="pdf">PDF</option>
            <option value="msword">Word(.doc)</option>
            <option value="wordprocessingml">Word(.docx)</option>
            <option value="spreadsheetml">Excel(.xlsx)</option>
            <option value="presentationml">PowerPoint(.pptx)</option>
            <option value="zip">压缩包(zip)</option>
          </select>
          <div className="cat-sel">
            <SlidersHorizontal size={12} /> 分类：
            {CATEGORY_LIST.map((c) => (
              <button key={c} className={`catchip${catSel.includes(c) ? ' on' : ''}`}
                style={catSel.includes(c) ? { background: M.catColor(c, categoryColors) } : undefined}
                onClick={() => setCatSel((s) => (s.includes(c) ? s.filter((x) => x !== c) : [...s, c]))}>
                {M.catLabel(c, categories)}
              </button>
            ))}
          </div>
          {(search.q || search.bodyQ || search.from || search.fromDate || catSel.length || labelSel.length) && (
            <button className="link-btn" onClick={() => { setSearch({ q: '', from: '', bodyQ: '', fromDate: '' }); setCatSel([]); setLabelSel([]); setQuick(''); setAttType(''); setPage(0); }}>
              <X size={12} /> 清除筛选
            </button>
          )}
        </div>
      )}

      <div className="mail-list">
        {loading && !data && <div className="list-loading"><Spinner /> 加载中…</div>}
        {!loading && (!data || !data.list.length) && (
          <Empty icon={<Inbox size={32} />} text="这里没有邮件" sub="试试切换筛选条件，或点右上角「刷新」同步新邮件" />
        )}
        {grouped.map((g, gi) => (
          <div key={gi} className="mail-group">
            {g.label && <div className="group-label">{g.label}<span className="group-count">{g.items.length}</span></div>}
            {rowsFor(g.items)}
          </div>
        ))}
      </div>

      {data && data.total > 0 && (
        <div className="list-pager">
          <button className="mini-btn" disabled={page === 0} onClick={() => setPage(page - 1)}><ChevronLeft size={13} />上一页</button>
          <span>第 {page + 1} 页 / 共 {Math.ceil(data.total / data.pageSize)} 页</span>
          <button className="mini-btn" disabled={(page + 1) * data.pageSize >= data.total} onClick={() => setPage(page + 1)}>下一页<ChevronRight size={13} /></button>
        </div>
      )}

      <PopMenu
        open={!!menuMsg}
        onClose={() => setMenuMsg(null)}
        pos={{ left: Math.min(menuMsg?.x || 0, window.innerWidth - 190), top: Math.min(menuMsg?.y || 0, window.innerHeight - 240) }}
        items={menuMsg ? [
          { label: menuMsg.msg.read ? '标记为未读' : '标记为已读', icon: <CheckCheck size={13} />, onClick: () => toggleRead(menuMsg.msg, !menuMsg.msg.read) },
          { label: menuMsg.msg.important ? '取消星标' : '加星标', icon: <Star size={13} />, onClick: () => toggleStar(menuMsg.msg, !menuMsg.msg.important) },
          { divider: true },
          { label: '添加标签…', icon: <Tag size={13} />, onClick: () => setLabelModal(menuMsg.msg) },
          { divider: true },
          { label: '用 AI 重新分类', icon: <SlidersHorizontal size={13} />, onClick: async () => { try { const r = await api.post(`/api/messages/${menuMsg.msg.id}/classify`); toast(`已分类为「${M.catLabel(r.result.category, categories)}」`, 'success'); } catch (e) { toast(e.message, 'error'); } bumpList(); } },
        ] : []}
      />

      {labelModal && <LabelModal msg={labelModal} onClose={() => setLabelModal(null)} onAdd={addLabel} />}
    </div>
  );
}

function LabelModal({ msg, onClose, onAdd }) {
  const [text, setText] = useState('');
  const labels = msg.labels || [];
  return (
    <Modal title={`添加标签 — ${msg.subject?.slice(0, 24) || ''}`} onClose={onClose} footer={(
      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>关闭</button>
        <button className="btn primary" disabled={!text.trim()} onClick={() => { onAdd(msg, text.trim()); onClose(); }}>添加</button>
      </div>
    )}>
      <div className="label-editor">
        <input className="inp" autoFocus placeholder="输入新标签名，如：课程、助教、奖学金…" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && text.trim() && (onAdd(msg, text.trim()), onClose())} />
        <div className="labels-now">
          {labels.map((l) => <span key={l} className="label-badge">{l}</span>)}
          {!labels.length && <span className="dim">暂无标签</span>}
        </div>
      </div>
    </Modal>
  );
}

/** 头像颜色：优先账户色，其余按名字哈希 */
export function dotColor(m, accounts) {
  const acc = (accounts || []).find((a) => a.id === m.accountId);
  if (acc?.color) return acc.color;
  let h = 0;
  const s = String(m.fromAddr || m.fromName || m.id);
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return `hsl(${h}, 55%, 45%)`;
}
