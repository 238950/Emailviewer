// 设置页：账户 / 同步 / AI / 规则 / 汇总提醒 / 存储 / 外观 / 日志
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { User, RefreshCw, Sparkles, Filter, CalendarClock, Database, Palette, ShieldCheck, Plus, Trash2, Pencil, CheckCircle2, XCircle, Loader2, Terminal, Star, FileText, Rocket, Power } from 'lucide-react';
import { useStore, M, applyTheme } from '../store.js';
import { api, fmtBytes } from '../api.js';
import { Spinner, Modal, Field, Toggle, IconBtn, ConfirmDialog } from '../components/common.jsx';
import { prettyFolder } from '../components/pretty.js';

const MASK = '••••••••';

export default function SettingsView() {
  const { settings, refreshStatus, accounts, status, toast, presets, setNewAccountOpen } = useStore();
  const [settingsLocal, setSettingsLocal] = useState(null);
  const [tab, setTab] = useState('accounts');
  const [busy, setBusy] = useState('');

  useEffect(() => { setSettingsLocal(settings); }, [settings]);

  // BUG-56：设置保存串行化。
  // 原先每次 save() 都并发发一个 PUT，busy 只用于禁用按钮、不阻止并发。
  // 快速连调多个开关时，最终落库的值取决于响应到达顺序——可能不是用户最后操作的那个。
  // 这里用 ref 记录"是否有保存在途"，在途时把最新 patch 攒起来，完成后合并再发一次，
  // 既保证顺序（最后一次操作一定最后落库），又不丢中间改动。
  const savingRef = useRef(false);
  const pendingRef = useRef(null);
  const save = async (patch, msg = '设置已保存') => {
    if (savingRef.current) {
      pendingRef.current = { ...(pendingRef.current || {}), ...patch };
      return;
    }
    savingRef.current = true;
    setBusy('save');
    try {
      let cur = patch;
      // 循环：把在途期间攒下的 patch 合并后再发，直到没有新的为止
      for (;;) {
        // eslint-disable-next-line no-await-in-loop
        const r = await api.put('/api/settings', cur);
        setSettingsLocal(r.settings);
        if (patch.syncIntervalMin != null || patch.initialSyncDays != null) { /* 服务端已生效 */ }
        if (!pendingRef.current) break;
        cur = pendingRef.current;
        pendingRef.current = null;
      }
      toast(msg, 'success');
    } catch (e) { toast(e.message, 'error'); }
    finally { savingRef.current = false; pendingRef.current = null; setBusy(''); }
  };

  if (!settingsLocal) return <div className="view-page"><Spinner /></div>;

  const TABS = [
    { k: 'accounts', label: '账户', icon: User },
    { k: 'sync', label: '同步', icon: RefreshCw },
    { k: 'ai', label: 'AI 智能', icon: Sparkles },
    { k: 'rules', label: '过滤规则', icon: Filter },
    { k: 'digest', label: '汇总提醒', icon: CalendarClock },
    { k: 'startup', label: '启动与通知', icon: Rocket },
    { k: 'storage', label: '存储', icon: Database },
    { k: 'appearance', label: '外观', icon: Palette },
    { k: 'logs', label: '日志', icon: Terminal },
  ];

  return (
    <div className="view-page settings-page">
      <div className="settings-layout">
        <aside className="settings-nav">
          <div className="settings-nav-title">设置</div>
          {TABS.map((t) => {
            const Icon = t.icon;
            return <button key={t.k} className={`settings-tab${tab === t.k ? ' active' : ''}`} onClick={() => setTab(t.k)}><Icon size={15} />{t.label}</button>;
          })}
        </aside>
        <div className="settings-content">
          {tab === 'accounts' && <AccountsTab accounts={accounts} refreshStatus={refreshStatus} toast={toast} setNewAccountOpen={setNewAccountOpen} />}
          {tab === 'sync' && <SyncTab s={settingsLocal} save={save} busy={busy} />}
          {tab === 'ai' && <AiTab toast={toast} />}
          {tab === 'rules' && <RulesTab toast={toast} accounts={accounts} categories={presets?.categories || {}} />}
          {tab === 'digest' && <DigestTab s={settingsLocal} save={save} busy={busy} toast={toast} categories={presets?.categories || {}} />}
          {tab === 'startup' && <StartupTab s={settingsLocal} toast={toast} />}
          {tab === 'storage' && <StorageTab s={settingsLocal} save={save} busy={busy} toast={toast} />}
          {tab === 'appearance' && <AppearanceTab toast={toast} />}
          {tab === 'logs' && <LogsTab />}
        </div>
      </div>
    </div>
  );
}

/* ---------- 账户 ---------- */
function AccountsTab({ accounts, refreshStatus, toast, setNewAccountOpen }) {
  const [editing, setEditing] = useState(null);
  const [ask, setAsk] = useState(null);   // BUG-58：主题化确认弹窗
  const { selectAccount, setView } = useStore();
  const setPrimary = async (id) => {
    try { await api.post(`/api/accounts/${id}/primary`); await refreshStatus(true); toast('已设为主账户', 'success'); } catch (e) { toast(e.message, 'error'); }
  };
  const syncOne = async (id) => {
    try { await api.post(`/api/accounts/${id}/sync`); toast('同步完成', 'success'); } catch (e) { toast(e.message, 'error'); }
    refreshStatus(true);
  };
  // BUG-58：改为主题化确认弹窗（原生 confirm 在暗色下刺眼，且被浏览器抑制时会静默返回 false）
  const del = (a) => {
    setAsk({
      title: '删除账户',
      danger: true,
      confirmText: '永久删除本地数据',
      cancelText: '保留',
      body: `确定删除账户「${a.name}」？\n将一并删除：本地已同步的邮件、附件缓存文件，以及由该账户邮件生成的日历事件。\n（不会影响邮箱服务器上的真实邮件）`,
      onOk: async () => {
        try {
          const r = await api.del(`/api/accounts/${a.id}`);
          const extra = r.report ? `（邮件 ${r.report.messages} 封、附件文件 ${r.report.files} 个、日历事件 ${r.report.events} 条，释放约 ${(r.report.bytesFreed / 1048576).toFixed(1)} MB）` : '';
          toast(`账户已删除${extra}`, 'success');
          refreshStatus(true);
        } catch (e) { toast(e.message, 'error'); }
      },
    });
  };
  return (
    <div className="set-section">
      <div className="sec-head">
        <b>邮箱账户</b>
        <button className="btn primary" onClick={() => setNewAccountOpen(true)}><Plus size={14} /> 添加账户</button>
      </div>
      <div className="acc-list">
        {accounts.map((a) => (
          <div key={a.id} className="acc-row">
            <span className="acc-dot" style={{ background: a.color }} />
            <div className="acc-row-main">
              <b>{a.name}</b>
              {a.kind === 'outlook-local' && <span className="acc-outlook-tag">Outlook 桌面</span>}
              {a.kind === 'imap' && <span className="acc-imap-tag">IMAP</span>}
              {a.isPrimary && <span className="acc-primary-tag">主账户</span>}
              {!a.enabled && <span className="dim">（已停用）</span>}
              <div className="dim">
                {a.email || a.host || '—'}
                {a.kind === 'imap' ? ` · ${a.host}:${a.port}` : ' · 读取本机 Outlook'}
                {a.lastSyncAt ? ` · 上次同步 ${new Date(a.lastSyncAt).toLocaleString('zh-CN')}` : ' · 尚未同步'}
              </div>
              {a.syncError && <div className="err-text">同步错误：{a.syncError}</div>}
            </div>
            <div className="acc-row-actions">
              {!a.isPrimary && <button className="mini-btn" onClick={() => setPrimary(a.id)} title="设为主账户">设为主</button>}
              <button className="mini-btn" onClick={() => syncOne(a.id)}><RefreshCw size={12} /> 同步</button>
              <button className="mini-btn" onClick={() => setEditing(a)}><Pencil size={12} /> 编辑</button>
              <button className="mini-btn" onClick={() => { selectAccount(a.id); setView('mail'); }}>打开邮箱</button>
              <button className="mini-btn danger" onClick={() => del(a)}><Trash2 size={12} /> 删除</button>
            </div>
          </div>
        ))}
        {!accounts.length && <div className="dim">还没有账户。点击「添加账户」选择<b>本机 Outlook 桌面</b>（读取 Outlook 已同步邮件，无需密码）或 IMAP 直接连接。</div>}
      </div>
      {editing && <AccountEdit account={editing} onClose={() => setEditing(null)} toast={toast} refreshStatus={refreshStatus} />}
      <ConfirmDialog req={ask} onClose={() => setAsk(null)} />
    </div>
  );
}

function AccountEdit({ account, onClose, toast, refreshStatus }) {
  const [f, setF] = useState({
    name: account.name, email: account.email, username: account.username, host: account.host,
    port: account.port || 993, ssl: account.ssl !== false, password: '', color: account.color,
    enabled: account.enabled, allowInsecureTls: account.extra?.allowInsecureTls,
  });
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const submit = async () => {
    try {
      await api.put(`/api/accounts/${account.id}`, {
        ...f, port: Number(f.port) || 993,
        password: f.password || undefined,
      });
      toast('账户已更新', 'success'); refreshStatus(true); onClose();
    } catch (e) { toast(e.message, 'error'); }
  };
  return (
    <Modal title={`编辑账户：${account.name}`} onClose={onClose} footer={(
      <div className="modal-actions"><button className="btn ghost" onClick={onClose}>取消</button><button className="btn primary" onClick={submit}>保存</button></div>
    )}>
      <div className="form-grid">
        <Field label="名称"><input className="inp" value={f.name} onChange={(e) => set('name', e.target.value)} /></Field>
        <Field label="邮箱地址（须与 Outlook 中显示一致）"><input className="inp" value={f.email} onChange={(e) => set('email', e.target.value)} disabled={account.kind === 'outlook-local'} title={account.kind === 'outlook-local' ? 'Outlook 桌面账户的邮箱由 Outlook 提供，如邮箱变更请在 Outlook 中修改后删除本账户重新添加' : ''} /></Field>
        {account.kind !== 'outlook-local' && (<>
          <Field label="IMAP 服务器"><input className="inp" value={f.host} onChange={(e) => set('host', e.target.value)} /></Field>
          <Field label="端口"><input className="inp" type="number" value={f.port} onChange={(e) => set('port', e.target.value)} /></Field>
          <Field label="用户名"><input className="inp" value={f.username} onChange={(e) => set('username', e.target.value)} /></Field>
          <Field label="密码（留空保持不变）"><input className="inp" type="password" value={f.password} onChange={(e) => set('password', e.target.value)} placeholder={account.hasPassword ? MASK : '未设置'} /></Field>
        </>)}
        <Field label="显示颜色"><input className="inp color-inp" type="color" value={f.color} onChange={(e) => set('color', e.target.value)} /></Field>
        <Field label="">
          <div className="stack">
            {account.kind === 'outlook-local' && <span className="dim note">Outlook 桌面账户：邮箱账号、服务器与密码均由本机 Outlook 管理，这里仅可修改显示名称、颜色与启用状态。</span>}
            {account.kind !== 'outlook-local' && <label className="check-row"><input type="checkbox" checked={f.ssl} onChange={(e) => set('ssl', e.target.checked)} /> SSL/TLS</label>}
            <label className="check-row"><input type="checkbox" checked={f.enabled} onChange={(e) => set('enabled', e.target.checked)} /> 启用（参与自动同步）</label>
            {account.kind !== 'outlook-local' && <label className="check-row"><input type="checkbox" checked={!!f.allowInsecureTls} onChange={(e) => set('allowInsecureTls', e.target.checked)} /> 允许不校验 TLS 证书（自签名服务器）</label>}
          </div>
        </Field>
      </div>
    </Modal>
  );
}

/* ---------- 同步 ---------- */
function SyncTab({ s, save, busy }) {
  const [form, setForm] = useState({ syncIntervalMin: s.syncIntervalMin, initialSyncDays: s.initialSyncDays, hydrateNewLimit: s.hydrateNewLimit });
  const set = (k, v) => setForm((x) => ({ ...x, [k]: Number(v) }));
  return (
    <div className="set-section">
      <div className="sec-head"><b>接收与同步</b></div>
      <p className="dim">按设定间隔自动同步各账户的新邮件（Outlook 桌面模式读取本机 Outlook；IMAP 模式连接服务器）。UI 每 10 秒轮询一次未读数。</p>
      <div className="form-grid">
        <Field label="自动同步间隔（分钟，0=关闭）"><select className="sel" value={form.syncIntervalMin} onChange={(e) => set('syncIntervalMin', e.target.value)}>
          {[0, 5, 10, 15, 30, 60].map((x) => <option key={x} value={x}>{x === 0 ? '关闭' : `${x} 分钟`}</option>)}
        </select></Field>
        <Field label="首轮回看天数"><select className="sel" value={form.initialSyncDays} onChange={(e) => set('initialSyncDays', e.target.value)}>
          {[7, 14, 30, 60, 90, 180].map((x) => <option key={x} value={x}>{x} 天</option>)}
        </select></Field>
        <Field label="每次同步后台抓取正文的封数（更快出摘要/附件索引）"><select className="sel" value={form.hydrateNewLimit} onChange={(e) => set('hydrateNewLimit', e.target.value)}>
          {[10, 30, 60, 100, 200].map((x) => <option key={x} value={x}>{x} 封</option>)}
        </select></Field>
      </div>
      <p className="dim note">说明：邮件列表先同步“信封”（发件人/主题/时间/附件名），正文与附件在后台逐封抓取；打开某封邮件会立即抓取该封全文。首次同步大邮箱会稍慢，属正常现象。Outlook 桌面模式读取的是 Outlook 本地已同步缓存的范围。</p>
      <button className="btn primary" disabled={busy === 'save'} onClick={() => save(form, '同步设置已保存')}>{busy === 'save' ? <Spinner /> : '保存'}</button>
    </div>
  );
}

/* ---------- AI ---------- */
const PROVIDER_ORDER = ['deepseek', 'openai', 'kimi', 'glm', 'qwen', 'ollama'];

function AiTab({ toast }) {
  const [cfg, setCfg] = useState(null);
  const [testing, setTesting] = useState('');
  const [saving, setSaving] = useState(false);
  const [ask, setAsk] = useState(null);     // BUG-58：主题化确认弹窗
  const [typedKeys, setTypedKeys] = useState({});
  const [models, setModels] = useState({});            // providerKey -> [模型名]
  const [loadingModels, setLoadingModels] = useState({});
  const load = () => api.get('/api/ai/config').then((r) => setCfg(r.ai)).catch((e) => toast(e.message, 'error'));
  useEffect(() => { load(); }, []);

  const save = async (silent = false, explicit = null) => {
    setSaving(true);
    try {
      const r = await api.put('/api/ai/config', explicit || cfg);
      setCfg(r.ai);
      setTypedKeys({});
      if (!silent) toast('AI 配置已保存', 'success');
      return true;
    } catch (e) { toast(e.message, 'error'); return false; }
    finally { setSaving(false); }
  };
  /** BUG-36：开关/服务商这类开关改动立即落库，不必再滚到底部点保存 */
  const saveNow = async (patch) => {
    const next = { ...cfg, ...patch };
    setCfg(next);
    await save(true, next);
  };
  const test = async (key) => {
    if (!await save(true)) return;           // 先把当前（含新填 Key）保存，再按已存配置测试
    setTesting(key);
    try {
      const r = await api.post('/api/ai/test', { provider: key });
      toast(r.ok ? `连接成功：${r.reply || r.model}` : `失败：${r.error}`, r.ok ? 'success' : 'error');
    } catch (e) { toast(e.message, 'error'); } finally { setTesting(''); }
  };
  const setKeyInput = (k, v) => {
    setTypedKeys((t) => ({ ...t, [k]: v }));
    setCfg((c) => ({ ...c, providers: { ...c.providers, [k]: { ...c.providers[k], apiKey: v } } }));
  };
  const setModel = (k, model) => {
    setCfg((c) => ({ ...c, providers: { ...c.providers, [k]: { ...c.providers[k], model } } }));
  };
  /** 自动获取该服务商的模型列表（先保存以便使用最新 Key/BaseURL） */
  const loadModels = async (k) => {
    if (!await save(true)) return;
    setLoadingModels((s) => ({ ...s, [k]: true }));
    try {
      const r = await api.post('/api/ai/models', { provider: k });
      if (r.ok) {
        setModels((s) => ({ ...s, [k]: r.models || [] }));
        toast(`已获取 ${r.models?.length || 0} 个可用模型，可在下拉中选择`, 'success');
      } else {
        toast(`获取模型失败：${r.error}`, 'error');
      }
    } catch (e) { toast(e.message, 'error'); } finally { setLoadingModels((s) => ({ ...s, [k]: false })); }
  };
  const [customOpen, setCustomOpen] = useState(false);
  const [custom, setCustom] = useState({ name: '', baseUrl: '', model: '', apiKey: '' });
  const addCustom = () => {
    if (!custom.name.trim() || !custom.baseUrl.trim() || !custom.model.trim()) { toast('自定义服务商需填写 名称 / Base URL / 模型', 'error'); return; }
    const key = `custom-${Date.now().toString(36)}`;
    setCfg((c) => ({
      ...c,
      active: key,
      providers: {
        ...c.providers,
        [key]: { label: custom.name.trim(), baseUrl: custom.baseUrl.trim(), model: custom.model.trim(), apiKey: custom.apiKey.trim() },
      },
    }));
    setCustomOpen(false);
    setCustom({ name: '', baseUrl: '', model: '', apiKey: '' });
    toast('已添加自定义服务商，点“保存 AI 配置”生效', 'success');
  };

  /** 删除某个 AI 服务商模块（传 null 给服务端表示删除） */
  const removeProvider = (k) => {                 // BUG-58：主题化确认弹窗
    const label = cfg?.providers?.[k]?.label || k;
    setAsk({
      title: '删除服务商',
      danger: true,
      confirmText: '删除',
      body: `删除服务商「${label}」？已保存的该服务商 Key 也会一并移除。`,
      onOk: async () => {
        const left = { ...(cfg.providers || {}) };
        delete left[k];
        const newActive = cfg.active === k ? (Object.keys(left)[0] || '') : cfg.active;
        setCfg((c) => ({ ...c, active: newActive }));
        try {
          const r = await api.put('/api/ai/config', { providers: { [k]: null }, active: newActive || undefined });
          setCfg(r.ai);
          toast(`已删除服务商「${label}」`, 'success');
        } catch (e) { toast(e.message, 'error'); load(); }
      },
    });
  };

  /** 恢复内置服务商列表（保留已填写 Key） */
  const resetProviders = () => {                  // BUG-58：主题化确认弹窗
    setAsk({
      title: '恢复内置服务商列表',
      confirmText: '恢复',
      body: '恢复内置服务商列表？（已填写的 Key 会保留）',
      onOk: async () => {
        try {
          const r = await api.put('/api/ai/config', { resetProviders: true });
          setCfg(r.ai);
          toast('已恢复内置服务商列表', 'success');
        } catch (e) { toast(e.message, 'error'); }
      },
    });
  };

  if (!cfg) return <div className="set-section"><Spinner /></div>;
  const provOrder = [...PROVIDER_ORDER, ...Object.keys(cfg.providers || {}).filter((k) => !PROVIDER_ORDER.includes(k))];
  const activeP = cfg.providers[cfg.active];
  const aiReady = !!(cfg.enabled && activeP && activeP.hasKey && activeP.baseUrl);
  const engineText = aiReady
    ? `当前引擎：${activeP.label}（${activeP.model}，Key ${activeP.keyPreview || ''}）——新邮件正在自动 AI 分类/摘要`
    : cfg.enabled && activeP && activeP.baseUrl && !activeP.hasKey
      ? `已启用但「${cfg.active}」尚未配置有效 Key —— 分类与摘要将使用本地关键词规则（不会调用任何外部接口）`
      : cfg.enabled && !cfg.providers[cfg.active] ? '服务商配置缺失' : '当前未启用 AI —— 邮件分类/摘要使用本地关键词规则，不调用任何外部接口';

  return (
    <div className="set-section">
      <div className="sec-head"><b>AI 智能（分类 / 一句话摘要）</b></div>
      <p className="dim">兼容任意「OpenAI 兼容」接口：填 Base URL + API Key + 模型名。内置 DeepSeek / OpenAI / Kimi / 智谱GLM / 通义千问 / 本地 Ollama 预设。
        <b>未启用或未配置有效 Key 时，只会使用本地关键词规则，绝不调用外部接口。</b></p>

      <div className={`ai-banner ${aiReady ? 'on' : 'off'}`}>
        <span className={`ai-dot ${aiReady ? 'on' : ''}`} />
        {engineText}
        {aiReady && <button className="mini-btn danger" onClick={async () => { await saveNow({ enabled: false }); toast('AI 已停用，分类将回退本地关键词', 'success'); }}>立即停用</button>}
      </div>

      <div className="stack">
        <Toggle checked={!!cfg.enabled} onChange={(v) => saveNow({ enabled: v })} label="启用 AI（开启后新邮件自动尝试 AI 分类）——改动立即保存" />
        <Toggle checked={!!cfg.autoClassify} onChange={(v) => saveNow({ autoClassify: v })} label="自动对已下载邮件执行 AI 分类——改动立即保存" />
        <Toggle checked={!!cfg.autoSummarize} onChange={(v) => saveNow({ autoSummarize: v })} label="长邮件自动生成一句话摘要——改动立即保存" />
      </div>

      <div className="field-label">默认使用服务商（切换后立即生效）</div>
      <select className="sel" value={cfg.active} onChange={(e) => saveNow({ active: e.target.value })}>
        {Object.entries(cfg.providers || {}).map(([k, p]) => <option key={k} value={k}>{p.label}（{k}）{p.hasKey ? ' ✓' : ''}</option>)}
      </select>

      <div className="ai-providers">
        {provOrder.filter((k) => cfg.providers[k]).map((k) => {
          const p = cfg.providers[k];
          return (
            <div key={k} className={`ai-prov${cfg.active === k ? ' active' : ''}`}>
              <div className="ai-prov-head">
                <b>{p.label}</b>
                <span className="dim">{p.model}</span>
                <div className="ai-prov-actions">
                  <button className="mini-btn" onClick={() => test(k)}>{testing === k ? <Loader2 size={12} className="spin" /> : <ShieldCheck size={12} />} 测试</button>
                  {p.hasKey && <span className="ok-text"><CheckCircle2 size={11} /> 已配置 <code className="key-mask">{p.keyPreview}</code></span>}
                  {p.apiKey && !p.hasKey && <span className="dim">（新 Key 待保存）</span>}
                  <button className="mini-btn danger" title="删除该服务商模块" onClick={() => removeProvider(k)}><Trash2 size={12} /> 删除</button>
                </div>
              </div>
              <div className="ai-prov-fields">
                <input className="inp" placeholder="Base URL（OpenAI 兼容）" value={p.baseUrl} onChange={(e) => setCfg((c) => ({ ...c, providers: { ...c.providers, [k]: { ...c.providers[k], baseUrl: e.target.value } } }))} />
                <div className="model-picker">
                  <input
                    className="inp"
                    placeholder="模型名（可从列表选择，也可直接输入自定义）"
                    value={p.model}
                    onChange={(e) => setModel(k, e.target.value)}
                  />
                  <div className="model-picker-actions">
                    <button className="mini-btn" onClick={() => loadModels(k)} disabled={!!loadingModels[k]} title="调用该服务商的 /models 获取可用模型">
                      {loadingModels[k] ? <Loader2 size={12} className="spin" /> : <RefreshCw size={12} />} 获取模型列表
                    </button>
                    {(models[k] || []).length > 0 && (
                      <select
                        className="sel"
                        value={(models[k] || []).includes(p.model) ? p.model : '__custom__'}
                        onChange={(e) => { if (e.target.value !== '__custom__') setModel(k, e.target.value); }}
                      >
                        <option value="__custom__">自定义…（{models[k].length} 个可选）</option>
                        {models[k].map((m) => <option key={m} value={m}>{m}</option>)}
                      </select>
                    )}
                  </div>
                </div>
                <input
                  className="inp"
                  type="password"
                  autoComplete="new-password"
                  placeholder={p.hasKey ? '' : 'API Key'}
                  value={typedKeys[k] || ''}
                  onChange={(e) => setKeyInput(k, e.target.value)}
                  title={p.hasKey ? '已配置密钥；输入新值将替换（留空则保持不变）' : '粘贴 API Key'}
                />
              </div>
              {k === 'ollama' && <div className="dim hint">Ollama：本机装好 Ollama 并拉取模型后，Base URL 填 http://127.0.0.1:11434/v1，Key 可留空。</div>}
            </div>
          );
        })}
      </div>
      <div className="modal-actions start-row">
        <button className="btn ghost" onClick={() => setCustomOpen(true)}><Plus size={13} /> 添加自定义 OpenAI 兼容服务商</button>
        <button className="btn ghost" onClick={resetProviders} title="恢复 DeepSeek / OpenAI / Kimi / GLM / 通义 / Ollama 预设（保留已填 Key）"><RefreshCw size={13} /> 恢复内置服务商</button>
        <button className="btn primary" disabled={saving} onClick={() => save(false)}>{saving ? <Spinner /> : '保存 AI 配置'}</button>
      </div>
      {customOpen && (
        <Modal title="添加自定义 OpenAI 兼容服务商" onClose={() => setCustomOpen(false)} footer={(
          <div className="modal-actions">
            <button className="btn ghost" onClick={() => setCustomOpen(false)}>取消</button>
            <button className="btn primary" onClick={addCustom}>添加并设为当前服务商</button>
          </div>
        )}>
          <div className="form-grid">
            <Field label="名称（如：我的中转 / SiliconFlow）">
              <input className="inp" value={custom.name} onChange={(e) => setCustom((c) => ({ ...c, name: e.target.value }))} placeholder="显示用名称" />
            </Field>
            <Field label="Base URL（OpenAI 兼容，常以 /v1 结尾）">
              <input className="inp" value={custom.baseUrl} onChange={(e) => setCustom((c) => ({ ...c, baseUrl: e.target.value }))} placeholder="https://host/v1" />
            </Field>
            <Field label="模型名">
              <input className="inp" value={custom.model} onChange={(e) => setCustom((c) => ({ ...c, model: e.target.value }))} placeholder="如 qwen3.8-max-0902" />
            </Field>
            <Field label="API Key（可选，本地加密保存）">
              <input className="inp" type="password" autoComplete="new-password" value={custom.apiKey} onChange={(e) => setCustom((c) => ({ ...c, apiKey: e.target.value }))} placeholder="sk-…" />
            </Field>
          </div>
        </Modal>
      )}
      <ConfirmDialog req={ask} onClose={() => setAsk(null)} />
    </div>
  );
}

/* ---------- 过滤规则 ---------- */
const RULE_FIELDS = [
  { v: 'from_contains', l: '发件人包含' }, { v: 'from_is', l: '发件人是' },
  { v: 'subject_contains', l: '主题包含' }, { v: 'to_contains', l: '收件人包含' },
  { v: 'cc_contains', l: '抄送包含' }, { v: 'body_contains', l: '正文包含' },
  { v: 'any_contains', l: '任意位置包含' },
  { v: 'has_attachment', l: '有附件' }, { v: 'attachment_group', l: '附件类型是' },
  { v: 'folder_is', l: '所在文件夹' }, { v: 'account_is', l: '账户' }, { v: 'unread', l: '未读' },
];

function RulesTab({ toast, accounts, categories }) {
  const [rules, setRules] = useState(null);
  const [editing, setEditing] = useState(null); // null | {} 新增 | rule
  const [applying, setApplying] = useState(false);
  const [ask, setAsk] = useState(null);         // BUG-58：主题化确认弹窗
  const load = () => api.get('/api/rules').then((r) => setRules(r.rules)).catch((e) => toast(e.message, 'error'));
  useEffect(() => { load(); }, []);
  const toggleRule = async (r) => {
    try { await api.put(`/api/rules/${r.id}`, { enabled: !r.enabled }); toast(r.enabled ? '已停用' : '已启用', 'success'); load(); } catch (e) { toast(e.message, 'error'); }
  };
  const del = (id) => {                          // BUG-58：主题化确认弹窗
    setAsk({
      title: '删除过滤规则',
      danger: true,
      confirmText: '删除',
      body: '删除这条规则？（已应用到此前的标签/分类不会被撤销）',
      onOk: async () => {
        try { await api.del(`/api/rules/${id}`); load(); } catch (e) { toast(e.message, 'error'); }
      },
    });
  };
  const apply = async () => {
    setApplying(true);
    try {
      const r = await api.post('/api/rules/apply');
      toast(`已扫描 ${r.scanned} 封，变更 ${r.changed} 封`, 'success');
    } catch (e) { toast(e.message, 'error'); } finally { setApplying(false); }
  };
  if (!rules) return <div className="set-section"><Spinner /></div>;
  return (
    <div className="set-section">
      <div className="sec-head">
        <b>高级过滤规则</b>
        <div>
          <button className="btn ghost" onClick={apply} disabled={applying}>{applying ? <Spinner /> : <RefreshCw size={13} />} 应用到已下载邮件</button>
          <button className="btn primary" onClick={() => setEditing({})}><Plus size={13} /> 新建规则</button>
        </div>
      </div>
      <p className="dim">示例：来自「某课程助教」的邮件自动打上「课程」标签并归类为课程通知；主题含「成绩」自动标记重要。规则可含正文匹配（需邮件正文已抓取）。</p>
      {rules.map((r) => (
        <div key={r.id} className={`rule-card${r.enabled ? '' : ' disabled'}`}>
          <div className="rule-card-main">
            <b>{r.name || '（未命名规则）'}</b>
            <div className="dim">{describeRule(r, categories, accounts)}</div>
          </div>
          <div className="rule-card-actions">
            <Toggle checked={r.enabled} onChange={() => toggleRule(r)} />
            <button className="mini-btn" onClick={() => setEditing(r)}><Pencil size={12} /></button>
            <button className="mini-btn danger" onClick={() => del(r.id)}><Trash2 size={12} /></button>
          </div>
        </div>
      ))}
      {!rules.length && <div className="dim">还没有规则。点击右上「新建规则」体验自动分类/打标签。</div>}
      {editing !== null && <RuleEdit rule={editing} accounts={accounts} categories={categories} onClose={() => setEditing(null)} onSaved={() => { load(); setEditing(null); }} toast={toast} />}
      <ConfirmDialog req={ask} onClose={() => setAsk(null)} />
    </div>
  );
}

function describeRule(r, categories, accounts) {
  const conds = (r.match || []).map((c) => {
    const f = RULE_FIELDS.find((x) => x.v === c.field);
    const lbl = f ? f.l : c.field;
    if (['has_attachment', 'unread'].includes(c.field)) return lbl;
    let v = c.value;
    if (c.field === 'account_is') v = (accounts.find((a) => a.id === v) || {}).name || v;
    if (c.field === 'attachment_group') v = groupLabel(v);
    return `${lbl}「${v}」`;
  }).join(' 且 ');
  const acts = [];
  if (r.action?.labels?.length) acts.push(`标签 ${r.action.labels.join('、')}`);
  if (r.action?.category) acts.push(`归类「${categories[r.action.category] || r.action.category}」`);
  if (r.action?.markRead === true) acts.push('标记已读');
  if (r.action?.important === true) acts.push('加星');
  return `如果：${conds || '（无条件）'} → ${acts.join('，') || '无动作'}`;
}

const groupLabel = (k) => ({ pdf: 'PDF', document: '文档', table: '表格', image: '图片', archive: '压缩包', slide: '幻灯片', calendar: '日历', text: '文本', other: '其他' }[k] || k);

function RuleEdit({ rule, accounts, categories, onClose, onSaved, toast }) {
  const isNew = !rule.id;
  const [name, setName] = useState(rule.name || '');
  const [conds, setConds] = useState((rule.match || []).length ? rule.match.map((c) => ({ ...c })) : [{ field: 'from_contains', value: '' }]);
  const [labels, setLabels] = useState((rule.action?.labels || []).join(','));
  const [category, setCategory] = useState(rule.action?.category || '');
  const [markRead, setMarkRead] = useState(rule.action?.markRead == null ? '' : (rule.action.markRead ? 'read' : 'unread'));
  const [important, setImportant] = useState(rule.action?.important == null ? '' : (rule.action.important ? 'on' : 'off'));

  const setC = (i, patch) => setConds((list) => list.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const save = async () => {
    const clean = conds.filter((c) => ['has_attachment', 'unread'].includes(c.field) || (c.value || '').trim()).map((c) => ({
      field: c.field, value: ['has_attachment', 'unread'].includes(c.field) ? '' : c.value.trim(),
    }));
    const action = {
      labels: labels.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
      category: category || undefined,
      markRead: markRead === 'read' ? true : markRead === 'unread' ? false : undefined,
      important: important === 'on' ? true : important === 'off' ? false : undefined,
    };
    const body = { name: name.trim() || `新规则 ${Date.now() % 1000}`, match: clean, action };
    try {
      if (isNew) await api.post('/api/rules', body);
      else await api.put(`/api/rules/${rule.id}`, body);
      toast('规则已保存', 'success');
      onSaved();
    } catch (e) { toast(e.message, 'error'); }
  };
  return (
    <Modal title={isNew ? '新建过滤规则' : '编辑过滤规则'} onClose={onClose} wide footer={(
      <div className="modal-actions"><button className="btn ghost" onClick={onClose}>取消</button><button className="btn primary" onClick={save}>保存规则</button></div>
    )}>
      <div className="form-grid">
        <Field label="规则名称"><input className="inp" value={name} placeholder="例如：来自某课程助教的邮件自动标记" onChange={(e) => setName(e.target.value)} /></Field>
      </div>
      <div className="field-label">满足以下所有条件（AND）</div>
      {conds.map((c, i) => (
        <div key={i} className="rule-cond">
          <select className="sel" value={c.field} onChange={(e) => setC(i, { field: e.target.value, value: '' })}>
            {RULE_FIELDS.map((f) => <option key={f.v} value={f.v}>{f.l}</option>)}
          </select>
          {!['has_attachment', 'unread'].includes(c.field) && (
            c.field === 'account_is'
              ? <select className="sel" value={c.value} onChange={(e) => setC(i, { value: e.target.value })}>
                  <option value="">选择账户…</option>
                  {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              : c.field === 'attachment_group'
                ? <select className="sel" value={c.value} onChange={(e) => setC(i, { value: e.target.value })}>
                    <option value="">选择类型…</option>
                    {['pdf', 'document', 'table', 'image', 'archive', 'slide', 'calendar', 'text', 'other'].map((g) => <option key={g} value={g}>{groupLabel(g)}</option>)}
                  </select>
                : c.field === 'folder_is'
                  ? <input className="inp" value={c.value} placeholder="如 INBOX / 课程" onChange={(e) => setC(i, { value: e.target.value })} />
                  : <input className="inp" value={c.value} placeholder="关键词…" onChange={(e) => setC(i, { value: e.target.value })} />
          )}
          <div className="rule-cond-actions">
            {conds.length > 1 && <button className="mini-btn danger" onClick={() => setConds((l) => l.filter((_, j) => j !== i))}>删除</button>}
            {i === conds.length - 1 && <button className="mini-btn" onClick={() => setConds((l) => [...l, { field: 'from_contains', value: '' }])}>＋ 条件</button>}
          </div>
        </div>
      ))}
      <div className="field-label">执行动作</div>
      <div className="form-grid">
        <Field label="添加标签（逗号分隔）"><input className="inp" value={labels} placeholder="如：课程, 助教通知" onChange={(e) => setLabels(e.target.value)} /></Field>
        <Field label="归类为（可选）">
          <select className="sel" value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">（不强制分类）</option>
            {Object.entries(categories).map(([k, lb]) => <option key={k} value={k}>{lb}</option>)}
          </select>
        </Field>
        <Field label="已读状态">
          <select className="sel" value={markRead} onChange={(e) => setMarkRead(e.target.value)}>
            <option value="">不处理</option><option value="read">标记已读</option><option value="unread">标记未读</option>
          </select>
        </Field>
        <Field label="星标">
          <select className="sel" value={important} onChange={(e) => setImportant(e.target.value)}>
            <option value="">不处理</option><option value="on">加星标</option><option value="off">取消星标</option>
          </select>
        </Field>
      </div>
    </Modal>
  );
}

/* ---------- 每日汇总 ---------- */
function DigestTab({ s, save, busy, toast, categories }) {
  const [form, setForm] = useState({ ...s.digest });
  const set = (k, v) => setForm((x) => ({ ...x, [k]: v }));
  const cats = Object.entries(categories);
  const genNow = async () => {
    try {
      await save({ digest: form }, '汇总设置已保存');   // 先保存，保证“立即生成”用的是当前窗口设置
      const r = await api.post('/api/digest/now');
      // BUG-39：提示文案跟随实际 windowHours 设置，不再硬编码 30 小时
      if (r.digest) toast(`已生成今日汇总：${r.digest.count} 封重点未读（窗口 ${form.windowHours} 小时）`, 'success');
      else toast(`当前没有符合条件（各账户收件箱中最近 ${form.windowHours} 小时内、未读、重点分类）的邮件`, 'info');
    } catch (e) { toast(e.message, 'error'); }
  };
  return (
    <div className="set-section">
      <div className="sec-head"><b>提醒与每日汇总</b></div>
      <p className="dim">每天固定时间把各账户收件箱里「未读的重点邮件」（作业、成绩、课程、社团）汇总提醒；邮件中识别的日期也可设提醒并进入内置日历（邮箱/日历页查看）。</p>
      <div className="stack">
        <Toggle checked={!!form.enabled} onChange={(v) => set('enabled', v)} label="启用每日重点邮件汇总" />
      </div>
      <div className="form-grid">
        <Field label="汇总时间"><input className="inp" type="time" value={form.time} onChange={(e) => set('time', e.target.value)} /></Field>
        <Field label="只看最近（小时）新到"><select className="sel" value={form.windowHours} onChange={(e) => set('windowHours', Number(e.target.value))}>
          {[12, 24, 30, 48, 72].map((h) => <option key={h} value={h}>{h} 小时</option>)}
        </select></Field>
      </div>
      <div className="field-label">重点分类（未读即汇总）</div>
      <div className="cat-multi">
        {cats.map(([k, lb]) => (
          <button key={k} className={`catchip${(form.importantCategories || []).includes(k) ? ' on' : ''}`}
            onClick={() => set('importantCategories', (form.importantCategories || []).includes(k)
              ? (form.importantCategories || []).filter((x) => x !== k)
              : [...(form.importantCategories || []), k])}>
            {lb}
          </button>
        ))}
      </div>
      <div className="modal-actions">
        <button className="btn primary" disabled={busy === 'save'} onClick={() => save({ digest: form }, '汇总提醒设置已保存')}>{busy === 'save' ? <Spinner /> : '保存'}</button>
        <button className="btn ghost" onClick={genNow}>立即生成一次汇总（调试用）</button>
      </div>
    </div>
  );
}

/* ---------- 存储 ---------- */
function StorageTab({ s, save, busy, toast }) {
  const [st, setSt] = useState(null);
  const [dir, setDir] = useState(s.attachmentSaveDir || '');
  const [ask, setAsk] = useState(null);        // BUG-58：主题化确认弹窗
  const load = () => api.get('/api/storage').then(setSt).catch(() => {});
  useEffect(() => { load(); }, []);
  const testDir = async () => {
    try {
      const r = await api.post('/api/settings/save-dir-test', { dir });
      if (r.writable) { toast('目录可写 ✓', 'success'); save({ attachmentSaveDir: dir }, '默认保存目录已更新'); load(); }
    } catch (e) { toast(e.message, 'error'); }
  };
  const cleanup = () => {                       // BUG-58：主题化确认弹窗
    setAsk({
      title: '清理附件缓存',
      danger: true,
      confirmText: '清空缓存',
      body: '将删除全部本地缓存的附件文件（邮件正文不受影响）。之后打开相关邮件会自动重新抓取附件。继续？',
      onOk: async () => {
        try {
          const r = await api.post('/api/storage/purge-cache');
          toast(`已清空缓存（删除 ${r.removed} 个文件）`, 'success');
          load();
        } catch (e) { toast(e.message, 'error'); }
      },
    });
  };
  if (!st) return <div className="set-section"><Spinner /></div>;
  const pct = st.capBytes ? Math.min(100, (st.used / st.capBytes) * 100) : 0;
  return (
    <div className="set-section">
      <div className="sec-head"><b>附件存储</b></div>
      <div className="stack">
        <div className="field-label">缓存占用（{fmtBytes(st.used)} / {fmtBytes(st.capBytes)}）</div>
        <div className="bar"><div className="bar-fill" style={{ width: `${pct}%`, background: pct > 85 ? '#ef4444' : '#4f8cff' }} /></div>
        <div className="dim">后台会在超过上限后自动清理最早缓存的附件；删除附件文件不影响邮件正文。共 {st.files} 个文件。</div>
      </div>
      <div className="form-grid">
        <Field label="缓存上限（MB）"><select className="sel" value={s.attachmentCapMB} onChange={(e) => save({ attachmentCapMB: Number(e.target.value) }, '上限已更新')}>
          {[100, 200, 400, 800, 1600, 3200].map((x) => <option key={x} value={x}>{x} MB</option>)}
        </select></Field>
        <Field label="「保存到本地文件夹」默认目录（绝对路径）" hint={'例：C:\\Users\\你的名字\\Documents\\邮件附件'}>
          <div className="inline-flex">
            <input className="inp" value={dir} onChange={(e) => setDir(e.target.value)} placeholder="留空则保存到服务端 data/saved" />
            <button className="btn ghost" onClick={testDir}>测试并保存</button>
          </div>
        </Field>
      </div>
      <div className="modal-actions">
        <button className="btn ghost danger" onClick={cleanup}>立即清理超额缓存</button>
      </div>
      <ConfirmDialog req={ask} onClose={() => setAsk(null)} />
    </div>
  );
}

/* ---------- 外观 ---------- */
function AppearanceTab({ toast }) {
  const { theme, setTheme, settings, refreshStatus } = useStore();
  const options = [['dark', '深色模式'], ['light', '浅色模式'], ['system', '跟随系统']];
  const showDrafts = !!settings?.showDrafts;
  const markReadOnOpen = settings?.markReadOnOpen !== false;   // 默认开启，可在设置里关掉（BUG-23）
  const junkHideAuto = settings?.junkHideAuto !== false;
  const put = async (patch, msg) => {
    try {
      const r = await api.put('/api/settings', patch);
      useStore.setState({ settings: r.settings });
      if (msg) toast(msg, 'success');
      void refreshStatus;
    } catch (e) { toast(e.message, 'error'); }
  };
  const saveShowDrafts = (v) => put({ showDrafts: v },
    v ? '已显示草稿箱（并恢复同步草稿文件夹）' : '已隐藏草稿箱（同步时也会跳过）');
  return (
    <div className="set-section">
      <div className="sec-head"><b>外观</b></div>
      <div className="seg">
        {options.map(([k, lb]) => (
          <button key={k} className={`seg-btn${theme === k ? ' active' : ''}`} onClick={() => setTheme(k)}><Palette size={13} />{lb}</button>
        ))}
      </div>
      <div className="dim note">深色模式降低夜间观看亮度，保护视力。选择立即全局生效，并写回服务端设置（换浏览器也记得住）。</div>

      <div className="field-label">文件夹显示</div>
      <div className="stack">
        <Toggle checked={showDrafts} onChange={saveShowDrafts} label="在邮箱界面显示“草稿箱”" />
      </div>
      <div className="dim note">本查看器不提供写信功能，因此草稿箱默认隐藏（同步时也会跳过，省时省资源）。需要时打开此开关即可。</div>

      <div className="field-label">阅读行为（只读定位相关）</div>
      <div className="stack">
        <Toggle checked={markReadOnOpen} onChange={(v) => put({ markReadOnOpen: v },
          v ? '打开邮件会自动标记为已读（并同步回邮箱服务器）' : '已改为“只查看”：打开邮件不再改动邮箱的未读状态')}
          label="打开邮件时自动标记为已读（会同步回邮箱服务器）" />
        <Toggle checked={junkHideAuto} onChange={(v) => put({ junkHideAuto: v },
          v ? '“杂项附件”将自动从附件主列表隐藏' : '已关闭自动归类：所有附件都显示在主列表')}
          label="自动把疑似杂项附件（logo、签名图、免责声明等）移出主列表" />
      </div>
      <div className="dim note">关闭“打开即已读”后，阅读邮件不会影响你手机/网页邮箱里的未读状态；需要时仍可在列表里右键手动标记已读。</div>
    </div>
  );
}

/* ---------- 启动与通知 ---------- */
function StartupTab({ s, toast }) {
  const [st, setSt] = useState(null);
  const [busyKey, setBusyKey] = useState('');
  const notify = !!s?.newMailNotify;

  const loadStatus = () => api.get('/api/autostart').then(setSt).catch((e) => toast(e.message, 'error'));
  useEffect(() => { loadStatus(); }, []);

  const toggleAutoStart = async (enabled) => {
    setBusyKey('auto');
    try {
      const r = await api.put('/api/autostart', { enabled });
      setSt(r);
      const sr = await api.get('/api/settings');
      useStore.setState({ settings: sr.settings });
      if (enabled && !r.installed) toast(`未注册成功：${r.applyResult?.error || '请检查权限'}`, 'error');
      else toast(enabled ? '已开启开机自启（静默后台启动）' : '已关闭开机自启', 'success');
    } catch (e) { toast(e.message, 'error'); }
    finally { setBusyKey(''); }
  };

  const toggleNotify = async (v) => {
    setBusyKey('notify');
    try {
      const r = await api.put('/api/settings', { newMailNotify: v });
      useStore.setState({ settings: r.settings });
      toast(v ? '已开启新邮件通知' : '已关闭新邮件通知', 'success');
    } catch (e) { toast(e.message, 'error'); }
    finally { setBusyKey(''); }
  };

  if (!st) return <div className="set-section"><Spinner /></div>;
  return (
    <div className="set-section">
      <div className="sec-head"><b>启动与通知</b></div>

      <div className="field-label">开机自启</div>
      <div className="stack">
        <Toggle checked={!!st.settingEnabled} onChange={toggleAutoStart} label="开机后自动在后台启动邮件查看器（无窗口，不打扰使用）" />
      </div>
      <div className={`ai-banner ${st.installed ? 'on' : 'off'}`} style={{ marginTop: 6 }}>
        <span className={`ai-dot ${st.installed ? 'on' : ''}`} />
        {!st.supported ? '当前系统不是 Windows，暂不支持开机自启'
          : st.installed ? '已注册到系统启动项（HKCU\\...\\Run → StudentMailViewer）'
            : st.settingEnabled ? '设置已开启，但注册表项尚未成功写入（可重开开关重试）' : '未注册开机自启'}
        {st.supported && (
          <button className="mini-btn" onClick={() => loadStatus()}><RefreshCw size={12} /> 重新检测</button>
        )}
      </div>
      {st.installed && st.command && <div className="dim note">启动命令：<code>{st.command}</code></div>}
      {!st.exeExists && <div className="err-text">缺少启动器 EmailViewer.exe（项目根目录），开机自启无法工作；请从发布包中恢复该文件。</div>}
      <div className="dim note">
        说明：开机自启会让 <code>EmailViewer.exe silent</code>（无窗口）在后台启动本地服务；浏览器不需要常开，
        想看邮件时运行 <code>EmailViewer.exe</code>（或直接打开 http://127.0.0.1:3869）。
        停止服务运行 <code>EmailViewer.exe stop</code>，查看运行状态运行 <code>EmailViewer.exe status</code>，
        需要调试日志时运行 <code>EmailViewer.exe debug</code>。服务日志在 <code>server\data\server.log</code>。
      </div>

      <div className="field-label">新邮件通知</div>
      <div className="stack">
        <Toggle checked={notify} onChange={toggleNotify} label={busyKey === 'notify' ? '保存中…' : '收到新邮件时弹出系统通知与提醒中心提示'} />
      </div>
      <div className="dim note">通知会在同步发现新邮件后产生；点击通知可直接打开最新一封邮件。若系统未显示通知，请在 Windows「设置 → 系统 → 通知」中允许浏览器通知。</div>
    </div>
  );
}

/* ---------- 日志 ---------- */
function LogsTab() {
  const [logs, setLogs] = useState('');
  const load = () => api.get('/api/logs?tail=150').then((r) => setLogs(r.logs)).catch(() => {});
  useEffect(() => { load(); }, []);
  return (
    <div className="set-section">
      <div className="sec-head">
        <b>运行日志</b>
        <button className="mini-btn" onClick={load}><RefreshCw size={12} /> 刷新</button>
      </div>
      <pre className="log-view">{logs || '暂无日志'}</pre>
    </div>
  );
}
