// 智能收件箱：多账户统一收件箱 + 分类 + 标签过滤
import React, { useEffect, useRef, useState } from 'react';
import { Sparkles, Layers, Tag } from 'lucide-react';
import { useStore, M } from '../store.js';
import { api } from '../api.js';
import MailListView from '../components/MailListView.jsx';
import ReaderPane from '../components/ReaderPane.jsx';

const CATS = ['course', 'assignment', 'grade', 'club', 'system', 'promo', 'spam', 'personal'];

export default function SmartView() {
  const { accounts, status, categories, categoryColors, messageId, closeMessage } = useStore();
  // 统一收件箱默认汇总全部账户（而不是只勾主账户）
  const [selected, setSelected] = useState(() => accounts.map((a) => a.id));
  // 账户列表加载晚于首渲染时补全默认选择
  // 只补一次。原先以 selected.length === 0 判定"尚未初始化"，无法区分
  // "用户主动点了取消全选"，于是状态轮询更新 accounts 引用后会把清空的选择重新填成全选，
  // 用户会发现自己的选择被撤销、列表突然重新加载全部账户。
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current || !accounts.length) return;
    seededRef.current = true;
    setSelected((s) => (s.length ? s : accounts.map((a) => a.id)));
  }, [accounts]);
  const [cats, setCats] = useState([]);
  const [labels, setLabels] = useState([]);        // [{name,count}]
  const [selLabels, setSelLabels] = useState([]);
  const catUnread = status?.catUnread || {};

  // 未勾选任何账户 → 明确提示“未选择账户”，不再悄悄查第一个账户
  const accountIds = selected;
  const selectedKey = accountIds.join(',');

  // 拉取所选账户的标签清单
  useEffect(() => {
    if (!accountIds.length) { setLabels([]); return; }
    let dead = false;
    api.get(`/api/labels?accountId=${encodeURIComponent(accountIds.join(','))}`)
      .then((r) => { if (!dead) setLabels(r.labels || []); })
      .catch(() => { if (!dead) setLabels([]); });
    return () => { dead = true; };
  }, [selectedKey, status]);

  const toggleAcc = (id) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const toggleCat = (c) => setCats((s) => (s.includes(c) ? s.filter((x) => x !== c) : [...s, c]));
  const toggleLabel = (name) => setSelLabels((s) => (s.includes(name) ? s.filter((x) => x !== name) : [...s, name]));
  const clearAll = () => { setCats([]); setSelLabels([]); };

  return (
    <div className="smart-layout">
      <div className="smart-toolbar">
        <div className="smart-title-row">
          <Sparkles size={15} />
          <b>统一收件箱</b>
          <span className="dim">汇总所选账户收件箱；支持按账户 / 分类 / 标签过滤与分组</span>
        </div>
        <div className="acc-multi">
          {accounts.map((a) => (
            <button key={a.id} className={`acc-chip${selected.includes(a.id) ? ' on' : ''}`}
              style={selected.includes(a.id) ? { borderColor: a.color, background: `${a.color}22` } : undefined}
              onClick={() => toggleAcc(a.id)}>
              <span className="acc-dot" style={{ background: a.color }} />
              {a.name}
              {a.unreadTotal > 0 && <span className="acc-unread">{a.unreadTotal}</span>}
            </button>
          ))}
          {!accounts.length && <span className="dim">请先在「邮箱 → 添加账户」创建账户</span>}
          {accounts.length > 0 && (
            <button className="link-btn" onClick={() => setSelected(selected.length === accounts.length ? [] : accounts.map((a) => a.id))}>
              {selected.length === accounts.length ? '取消全选' : '全选账户'}
            </button>
          )}
        </div>
        {!selected.length && accounts.length > 0 && (
          <div className="smart-warn">未选择任何账户 —— 请至少勾选一个账户（默认已全选），否则列表为空。</div>
        )}
        <div className="cat-multi">
          <Layers size={13} />
          {CATS.map((c) => (
            <button key={c} className={`catchip${cats.includes(c) ? ' on' : ''}`}
              style={cats.includes(c) ? { background: M.catColor(c, categoryColors) } : undefined}
              onClick={() => toggleCat(c)}>
              {M.catLabel(c, categories)}
              {catUnread[c] ? <span className="chip-unread">{catUnread[c]}</span> : null}
            </button>
          ))}
        </div>
        {labels.length > 0 && (
          <div className="cat-multi">
            <Tag size={13} />
            {labels.map((lb) => (
              <button key={lb.name} className={`catchip label-chip${selLabels.includes(lb.name) ? ' on' : ''}`}
                onClick={() => toggleLabel(lb.name)}>
                {lb.name}
                <span className="chip-unread">{lb.count}</span>
              </button>
            ))}
          </div>
        )}
        {(cats.length > 0 || selLabels.length > 0) && (
          <div className="cat-multi">
            <button className="link-btn" onClick={clearAll}>清除全部筛选</button>
          </div>
        )}
      </div>
      <div className={`smart-content${messageId ? ' has-reader' : ''}`}>
        <MailListView
          title={selLabels.length ? `按标签：${selLabels.join('、')}` : '统一收件箱'}
          queryBase={{ accountIds, unified: true, folder: 'INBOX', category: cats, label: selLabels }}
          groupDefault="account"
        />
        {messageId ? <ReaderPane onBack={closeMessage} /> : <div className="reader-placeholder" />}
      </div>
    </div>
  );
}
