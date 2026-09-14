// AI 助手（Chatbox）：与邮件对话；AI 未配置时自动降级为本地邮件检索
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Sparkles, Send, Trash2, Paperclip, X, Bot, Search, Loader2, MessageSquare } from 'lucide-react';
import { useStore, M } from '../store.js';
import { api, fmtDate } from '../api.js';
import { Empty } from '../components/common.jsx';

const HISTORY_KEY = 'mailviewer.chat.history';
const PRESETS = [
  { label: '总结附带邮件', text: '请用 3 条以内要点总结我附带的邮件，并指出需要我做什么。' },
  { label: '提取截止时间', text: '从附带的邮件中提取所有截止时间/考试/活动时间，按时间排序输出清单。' },
  { label: '重要邮件排序', text: '按重要性给附带的邮件排序，并说明理由（每条不超过一句）。' },
  { label: '未读重点有哪些', text: '我最近的未读重点邮件里有哪些需要注意的？' },
];

const loadHistory = () => {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); } catch { return []; }
};

export default function ChatView() {
  const { messageId, messageDraft, accounts, selectMessage, setView, toast, categories, chatSeed } = useStore();
  const [msgs, setMsgs] = useState(loadHistory);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [ctx, setCtx] = useState(() => (messageId ? [messageId] : []));
  const [scope, setScope] = useState('auto');        // selected | auto | unread
  const [mode, setMode] = useState('ai');           // 最近一次回复的模式
  const [engine, setEngine] = useState('');
  const listRef = useRef(null);

  useEffect(() => { localStorage.setItem(HISTORY_KEY, JSON.stringify(msgs.slice(-40))); }, [msgs]);
  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [msgs, sending]);

  // 从邮箱点进来时，自动带上当前选中的邮件
  useEffect(() => {
    if (messageId) setCtx((c) => (c.includes(messageId) ? c : [...c, messageId]));
  }, [messageId]);

  const send = async (text, overrideIds, overrideScope) => {
    const content = (text ?? input).trim();
    if (!content || sending) return;
    const useIds = overrideIds || ctx;
    const useScope = overrideScope || (useIds.length ? 'selected' : scope);
    const history = [...msgs, { role: 'user', content }];
    setMsgs(history);
    setInput('');
    setSending(true);
    try {
      const r = await api.post('/api/ai/chat', {
        messages: history.map((m) => ({ role: m.role, content: m.content })),
        emailIds: useIds,
        scope: useScope,
      });
      if (r.mode === 'ai') {
        setMsgs((l) => [...l, { role: 'assistant', content: r.reply, mode: 'ai', engine: r.engine, sources: r.sources || [], usedMails: r.usedMails }]);
      } else if (r.mode === 'search') {
        setMsgs((l) => [...l, { role: 'assistant', content: r.reply, mode: 'search', results: r.results || [], note: r.note, sources: r.sources || [] }]);
      } else {
        setMsgs((l) => [...l, { role: 'assistant', content: `出错了：${r.error}`, mode: 'error' }]);
      }
      setMode(r.mode); setEngine(r.engine || '');
    } catch (e) {
      setMsgs((l) => [...l, { role: 'assistant', content: `请求失败：${e.message}`, mode: 'error' }]);
      toast(e.message, 'error');
    } finally { setSending(false); }
  };

  // “把这封邮件发给 AI 助手” → 自动带入该邮件并提问
  useEffect(() => {
    if (!chatSeed) return;
    const seed = useStore.getState().consumeChatSeed();
    if (!seed) return;
    setCtx(seed.emailIds);
    setScope('selected');
    if (seed.prompt) send(seed.prompt, seed.emailIds, 'selected');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatSeed]);

  const clear = () => { setMsgs([]); toast('对话已清空', 'success'); };

  return (
    <div className="chat-page">
      <div className="chat-head">
        <Sparkles size={16} />
        <b>AI 助手</b>
        <span className="dim">就你的邮件提问：总结、找截止时间、按重要性排序…（只读，不会发送任何邮件）</span>
        <div className="chat-head-right">
          <span className={`chat-engine ${mode === 'search' ? 'off' : ''}`}>
            {mode === 'search' ? '本地检索模式（未启用 AI）' : engine ? `引擎：${engine}` : '引擎：随设置'}
          </span>
          <button className="mini-btn danger" onClick={clear}><Trash2 size={12} /> 清空</button>
        </div>
      </div>

      <div className="chat-ctx">
        <Paperclip size={12} />
        {ctx.length ? (
          <>
            <span className="dim">已附带 {ctx.length} 封邮件：</span>
            {ctx.map((id) => (
              <span className="ctx-chip" key={id} title={`邮件 #${id}`}>
                #{id}{messageDraft?.id === id && messageDraft?.subject ? ` ${messageDraft.subject.slice(0, 18)}` : ''}
                <X size={11} onClick={() => setCtx((c) => c.filter((x) => x !== id))} />
              </span>
            ))}
          </>
        ) : (
          <span className="dim">未附带邮件；可在邮箱里选中邮件后回到这里，或直接提问（未配置 AI 时会自动检索本地邮件）</span>
        )}
        {messageId && !ctx.includes(messageId) && (
          <button className="mini-btn" onClick={() => setCtx((c) => [...c, messageId])}>附加当前邮件 #{messageId}</button>
        )}
        {ctx.length > 0 && <button className="mini-btn" onClick={() => setCtx([])}>清空附带</button>}
        <span className="chat-scope">
          <span className="dim">AI 读取范围：</span>
          {[['selected', '仅附带邮件'], ['auto', '自动检索相关'], ['unread', '最近未读']].map(([k, lb]) => (
            <button key={k} className={`qchip${scope === k ? ' on' : ''}`} onClick={() => setScope(k)}>{lb}</button>
          ))}
        </span>
      </div>

      <div className="chat-body" ref={listRef}>
        {!msgs.length && (
          <div className="chat-empty">
            <Empty icon={<MessageSquare size={30} />} text="开始和你的邮箱对话" sub="试试下面的快捷指令；配置 AI 后可以追问、对比多封邮件" />
            <div className="chat-presets">
              {PRESETS.map((p) => (
                <button key={p.label} className="qchip" onClick={() => send(p.text)}>{p.text}</button>
              ))}
            </div>
          </div>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={`chat-msg ${m.role === 'user' ? 'me' : 'bot'}${m.mode === 'error' ? ' err' : ''}`}>
            <div className="chat-avatar">{m.role === 'user' ? '我' : <Bot size={14} />}</div>
            <div className="chat-bubble">
              <div className="chat-text">{m.content}</div>
              {m.mode === 'search' && m.results?.length > 0 && (
                <div className="chat-results">
                  {m.results.map((r) => (
                    <div key={r.id} className="chat-result" onClick={() => { selectMessage(r.id); setView('mail'); }}>
                      <Search size={12} />
                      <div className="chat-result-main">
                        <div className="chat-result-subject">{r.subject || '(无主题)'}</div>
                        <div className="dim">{r.fromName} · {fmtDate(r.dateMs)} · {M.catLabel(r.category, categories)}{r.accountName ? ` · ${r.accountName}` : ''}</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {m.mode === 'search' && m.note && <div className="dim chat-note">{m.note}</div>}
              {m.mode === 'ai' && (
                <div className="dim chat-note">
                  由 {m.engine} 生成{m.usedMails ? ` · 读取了 ${m.usedMails} 封邮件` : ''}
                </div>
              )}
              {m.sources?.length > 0 && (
                <div className="chat-sources">
                  <span className="dim">来源：</span>
                  {m.sources.map((s) => (
                    <span className="ctx-chip" key={m.mode + s.id} title={s.subject}
                      onClick={() => { selectMessage(s.id); setView('mail'); }}>
                      #{s.id} {(s.subject || '').slice(0, 16)}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
        {sending && (
          <div className="chat-msg bot">
            <div className="chat-avatar"><Bot size={14} /></div>
            <div className="chat-bubble"><Loader2 size={14} className="spin" /> 思考中…</div>
          </div>
        )}
      </div>

      <div className="chat-input">
        <textarea
          className="inp"
          rows={2}
          placeholder="问点什么…（Enter 发送，Shift+Enter 换行）"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
        />
        <button className="btn primary" disabled={sending || !input.trim()} onClick={() => send()}>
          {sending ? <Loader2 size={14} className="spin" /> : <Send size={14} />} 发送
        </button>
      </div>
    </div>
  );
}
