// 内置日历：月视图 + 事件管理 + 到期提醒 + ICS 导出
import React, { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Plus, CalendarPlus, Download, Trash2, Clock, FileText, Sparkles } from 'lucide-react';
import { useStore } from '../store.js';
import { api, fmtDate, dayLabel } from '../api.js';
import { Spinner, Modal, IconBtn, Empty, ConfirmDialog } from '../components/common.jsx';

const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
const MONTHS = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];

export default function CalendarView() {
  const { toast } = useStore();
  const [ym, setYm] = useState(() => { const d = new Date(); return { y: d.getFullYear(), m: d.getMonth() }; });
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [newOpen, setNewOpen] = useState(false);
  const [sel, setSel] = useState(null); // 选中事件查看
  const [autoBusy, setAutoBusy] = useState(false);
  const [ask, setAsk] = useState(null);   // 待确认的危险操作（删除日程）

  // range 的 useMemo 必须声明在 autoFromMail 之前。
  // 虽然事件触发时 range 已初始化、不会真的报错，但这属于 TDZ 易碎写法：
  // 若将来有人在渲染期间调用它（或在 effect 里提前引用），会直接崩溃。
  // 把声明顺序理顺，消除隐患。
  const range = useMemo(() => {
    const start = new Date(ym.y, ym.m, 1);
    const end = new Date(ym.y, ym.m + 1, 1);
    return { start: start.getTime(), end: end.getTime() };
  }, [ym]);

  /** 让 AI/规则识别出的邮件时间一键进日历（自动去重） */
  const autoFromMail = async () => {
    setAutoBusy(true);
    try {
      const r = await api.post('/api/calendar/auto-from-mail', { days: 21, limit: 60 });
      const ev = await api.events(range.start - 5 * 86400000, range.end + 5 * 86400000);
      setEvents(ev.events || []);
      const rest = Math.max(0, (r.candidates || 0) - (r.created || 0) - (r.skipped || 0));
      toast(r.created
        ? `已从邮件安排 ${r.created} 个事件${r.skipped ? `（跳过已存在 ${r.skipped}）` : ''}${rest ? `；还有 ${rest} 个候选，可再点一次` : ''}`
        : `没有新的时间可安排${r.skipped ? `（${r.skipped} 个已存在）` : '（请先让 AI 分类或打开邮件抓取正文）'}`, r.created ? 'success' : 'info');
    } catch (e) { toast(e.message, 'error'); } finally { setAutoBusy(false); }
  };

  useEffect(() => {
    setLoading(true);
    api.events(range.start - 5 * 86400000, range.end + 5 * 86400000)
      .then((r) => { setEvents(r.events || []); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [range]);

  // 计算格子（末尾补齐空位，最后一行也完整）
  const cells = useMemo(() => {
    const first = new Date(ym.y, ym.m, 1);
    const lead = first.getDay(); // 前面补位
    const daysIn = new Date(ym.y, ym.m + 1, 0).getDate();
    const out = [];
    for (let i = 0; i < lead; i++) out.push(null);
    for (let d = 1; d <= daysIn; d++) {
      const dayStart = new Date(ym.y, ym.m, d).getTime();
      const evs = events.filter((e) => e.startMs < dayStart + 86400000 && e.endMs >= dayStart);
      out.push({ day: d, evs, ms: dayStart, today: sameDay(dayStart) });
    }
    while (out.length % 7 !== 0) out.push(null);   // 补满最后一周
    return out;
  }, [events, ym]);

  const move = (dm) => {
    const d = new Date(ym.y, ym.m + dm, 1);
    setYm({ y: d.getFullYear(), m: d.getMonth() });
  };

  const remove = async (id) => {
    try { await api.del(`/api/events/${id}`); setEvents((l) => l.filter((x) => x.id !== id)); setSel(null); toast('事件已删除', 'success'); } catch (e) { toast(e.message, 'error'); }
  };

  /**
   * 删除日程前先确认。
   * 事件及其提醒一并消失且无法撤销；而设置页删除账户等危险操作是有确认弹窗的，
   * 同一产品里两套标准不一致。这里统一走已有的 ConfirmDialog。
   */
  const askRemove = (ev) => setAsk({
    title: '删除日程',
    body: `确定删除日程「${ev.title}」吗？\n${fmtDate(ev.startMs, { full: true })}\n对应的提醒会一并删除，且无法撤销。`,
    danger: true,
    confirmText: '删除',
    onOk: () => remove(ev.id),
  });

  /** 按 RFC 5545 生成 .ics（含 DTSTAMP、转义、75 字节折行、全天事件用 VALUE=DATE） */
  const buildIcs = (ev) => {
    const pad = (n) => String(n).padStart(2, '0');
    const utcStamp = (ms) => {
      const d = new Date(ms);
      return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
    };
    const localStamp = (ms) => {
      const d = new Date(ms);
      return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    };
    const dateOnly = (ms) => {
      const d = new Date(ms);
      return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
    };
    // 转义：反斜杠、分号、逗号、换行（RFC 5545 §3.3.11）
    const esc = (s) => String(s == null ? '' : s)
      .replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
    // 折行：每行不超过 75 字节（UTF-8），续行以空格开头
    const fold = (line) => {
      const enc = new TextEncoder();
      if (enc.encode(line).length <= 74) return line;
      let out = '';
      let cur = '';
      for (const ch of line) {
        if (enc.encode(cur + ch).length > 74) { out += `${cur}\r\n `; cur = ch; }
        else cur += ch;
      }
      return out + cur;
    };
    const startLine = ev.allDay
      ? `DTSTART;VALUE=DATE:${dateOnly(ev.startMs)}`
      : `DTSTART:${localStamp(ev.startMs)}`;
    const endLine = ev.allDay
      ? `DTEND;VALUE=DATE:${dateOnly(ev.startMs + 86400000)}`
      : `DTEND:${localStamp(ev.allDay ? ev.startMs + 86400000 : ev.endMs)}`;
    const lines = [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'CALSCALE:GREGORIAN', 'PRODID:-//MailViewer//邮件查看器//CN',
      'BEGIN:VEVENT',
      `UID:${esc(ev.id)}@mailviewer`,
      `DTSTAMP:${utcStamp(Date.now())}`,           // RFC 5545 必需字段
      `CREATED:${utcStamp(ev.createdAt || Date.now())}`,
      startLine, endLine,
      `SUMMARY:${esc(ev.title)}`,
      ev.note ? `DESCRIPTION:${esc(ev.note)}` : '',
      `CATEGORIES:${esc(ev.source === 'auto' ? '来自邮件' : '手动创建')}`,
      'END:VEVENT', 'END:VCALENDAR', '',
    ].filter(Boolean);
    return lines.map(fold).join('\r\n');
  };

  const exportIcs = (ev) => {
    const ics = buildIcs(ev);
    const blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${String(ev.title || 'event').slice(0, 20).replace(/[\\/:*?"<>|]/g, '_')}.ics`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  };

  return (
    <div className="view-page cal-page">
      <div className="page-head">
        <b>内置日历</b>
        <span className="dim">AI 会从邮件里识别截止 / 考试 / 活动时间，可一键批量安排；支持导出 .ics</span>
        <div className="page-head-right">
          <button className="btn ghost" disabled={autoBusy} onClick={autoFromMail} title="扫描邮件（AI/规则识别的时间）并批量创建事件，自动跳过重复">
            {autoBusy ? <Spinner size={14} /> : <Sparkles size={14} />} 从邮件智能安排
          </button>
          <button className="btn primary" onClick={() => setNewOpen(true)}><Plus size={14} /> 新建事件</button>
        </div>
      </div>

      <div className="cal-toolbar">
        <button className="icon-btn" onClick={() => move(-1)}><ChevronLeft size={16} /></button>
        <button className="btn ghost" onClick={() => { const d = new Date(); setYm({ y: d.getFullYear(), m: d.getMonth() }); }}>今天</button>
        <b className="cal-ym">{ym.y} 年 {MONTHS[ym.m]}</b>
        <button className="icon-btn" onClick={() => move(1)}><ChevronRight size={16} /></button>
      </div>

      {loading ? <div className="list-loading"><Spinner /> 加载日历…</div> : (
        <div className="cal-grid">
          {WEEK.map((w) => <div key={w} className="cal-week">{w}</div>)}
          {cells.map((c, i) => (
            <div key={i} className={`cal-cell${c?.today ? ' today' : ''}${c?.day == null ? ' blank' : ''}`}>
              {c && (
                <>
                  <div className="cal-day">{c.day}</div>
                  {c.evs.slice(0, 3).map((ev) => (
                    <div key={ev.id} className="cal-evt" style={{ background: `${ev.color}33`, borderLeft: `3px solid ${ev.color}` }} onClick={() => setSel(ev)}>
                      <Clock size={9} /> {fmtDate(ev.startMs)} {ev.title.slice(0, 12)}
                    </div>
                  ))}
                  {c.evs.length > 3 && <div className="cal-more">+{c.evs.length - 3}</div>}
                </>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="upcoming-list">
        <div className="sec-title">近期日程与提醒</div>
        {events.filter((e) => e.endMs >= Date.now()).sort((a, b) => a.startMs - b.startMs).slice(0, 12).map((ev) => (
          <div key={ev.id} className="upc-item">
            <span className="evt-dot" style={{ background: ev.color }} />
            <div className="upc-main">
              <b>{ev.title}</b>
              <div className="dim">{fmtDate(ev.startMs, { full: true })} {ev.source === 'auto' ? '（从邮件自动识别）' : ''} {dayLabel(ev.startMs)}</div>
            </div>
            <div className="upc-actions">
              <IconBtn title="导出 .ics 到其它日历" onClick={() => exportIcs(ev)}><Download size={13} /></IconBtn>
              <IconBtn danger title="删除" onClick={() => askRemove(ev)}><Trash2 size={13} /></IconBtn>
            </div>
          </div>
        ))}
        {!events.filter((e) => e.endMs >= Date.now()).length && <Empty icon={<CalendarPlus size={26} />} text="暂无日程" sub="打开邮件时在底部「检测到的时间」点“加入日历”即可创建" />}
      </div>

      {newOpen && <EventForm onClose={() => setNewOpen(false)} onCreated={(ev) => { setEvents((l) => [...l, ev]); setNewOpen(false); toast('事件已创建', 'success'); }} />}
      {sel && <EventDetail ev={sel} onClose={() => setSel(null)} onDelete={() => askRemove(sel)} onExport={() => exportIcs(sel)} />}
      <ConfirmDialog req={ask} onClose={() => setAsk(null)} />
    </div>
  );
}

function sameDay(ms) {
  const a = new Date(ms); const b = new Date();
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function EventForm({ onClose, onCreated }) {
  const { toast } = useStore();
  const [title, setTitle] = useState('');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [time, setTime] = useState('09:00');
  const [allDay, setAllDay] = useState(false);
  const [durH, setDurH] = useState(1);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!title.trim()) { toast('请输入标题', 'error'); return; }
    setBusy(true);
    try {
      const startMs = new Date(`${date}T${time || '09:00'}`).getTime();
      const ev = await api.post('/api/events', {
        title: title.trim(), startMs,
        endMs: allDay ? startMs + 3600000 : startMs + durH * 3600000,
        allDay, note, color: '#e07b39', source: 'manual',
        remindOffsets: [],
      });
      onCreated(ev.event);
    } catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  };

  return (
    <Modal title="新建日历事件" onClose={onClose} footer={(
      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>取消</button>
        <button className="btn primary" onClick={submit} disabled={busy}>{busy ? <Spinner /> : '创建'}</button>
      </div>
    )}>
      <div className="form-grid">
        <label className="field span2"><span className="field-label">标题 *</span>
          <input className="inp" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="如：操作系统作业截止 / 组会" autoFocus />
        </label>
        <label className="field"><span className="field-label">日期</span><input className="inp" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
        <label className="field"><span className="field-label">时间</span><input className="inp" type="time" value={time} onChange={(e) => setTime(e.target.value)} disabled={allDay} /></label>
        <label className="check-row span2"><input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} /> 全天事件</label>
        <label className="field span2"><span className="field-label">备注</span>
          <textarea className="inp" rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="可选：补充说明（从邮件加入时会自动带上识别片段）" />
        </label>
      </div>
    </Modal>
  );
}

function EventDetail({ ev, onClose, onDelete, onExport }) {
  return (
    <Modal title="事件详情" onClose={onClose} footer={(
      <div className="modal-actions">
        <button className="btn ghost" onClick={onExport}><Download size={13} /> 导出 .ics</button>
        <button className="btn danger" onClick={onDelete}><Trash2 size={13} /> 删除</button>
        <button className="btn primary" onClick={onClose}>关闭</button>
      </div>
    )}>
      <div className="ev-detail">
        <div className="ev-detail-title"><span className="evt-dot big" style={{ background: ev.color }} />{ev.title}</div>
        <div className="dim"><CalendarPlus size={12} /> {fmtDate(ev.startMs, { full: true })} → {fmtDate(ev.endMs, { full: true })}</div>
        {ev.remindOffsets?.length > 0 && (
          <div className="dim"><Clock size={12} /> 提醒：{ev.remindOffsets.map((o) => o < 0 ? `${-o / 60} 小时前` : `${o / 60} 小时后`).join('、')}</div>
        )}
        {ev.note && <pre className="ev-note">{ev.note}</pre>}
        {ev.source === 'auto' && <div className="dim">来源：邮件自动识别</div>}
        {ev.messageId ? <a className="link-btn" href="#" onClick={(e) => { e.preventDefault(); useStore.getState().selectMessage(ev.messageId); useStore.getState().setView('mail'); onClose(); }}><FileText size={12} /> 打开来源邮件</a> : null}
      </div>
    </Modal>
  );
}
