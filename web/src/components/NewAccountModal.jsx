// 添加账户向导：本机 Outlook 桌面 / IMAP 两种数据源
import React, { useState } from 'react';
import { RefreshCw, Server, Mailbox, AlertTriangle } from 'lucide-react';
import { Modal, Field, Spinner } from './common.jsx';
import { useStore } from '../store.js';
import { api } from '../api.js';

export default function NewAccountModal() {
  const { newAccountOpen, setNewAccountOpen, presets, toast, refreshStatus, selectAccount, setView } = useStore();
  const [kind, setKind] = useState('imap');         // imap（云端直连，推荐） | outlook（仅经典版桌面）
  const [busy, setBusy] = useState(false);
  const [probing, setProbing] = useState(false);
  const [outlook, setOutlook] = useState({ accounts: [], error: '', probed: false, picked: '' });
  const [form, setForm] = useState({ name: '', email: '', password: '', username: '', preset: 0, host: '', port: 993, ssl: true, allowInsecureTls: false });
  const [testRes, setTestRes] = useState(null);

  if (!newAccountOpen) return null;
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const preset = presets?.hostPresets?.[form.preset] || {};

  /**
   * 表单里的端口 / SSL 始终以用户输入为准。
   * 选择预设时把预设值写进表单（pickPreset），之后不再被预设覆盖。
   */
  const pickPreset = (idx) => {
    const p = presets?.hostPresets?.[idx] || {};
    setForm((f) => ({ ...f, preset: idx, host: p.host || f.host, port: Number(p.port) || 993, ssl: p.ssl !== false }));
    setTestRes(null);
  };
  const serverFromForm = () => ({
    email: form.email.trim(), username: form.username.trim() || form.email.trim(),
    password: form.password, host: (form.host || preset.host || '').trim(),
    port: Number(form.port) || 993, ssl: !!form.ssl,
    allowInsecureTls: !!form.allowInsecureTls,
  });

  /* ---------- Outlook 桌面 ---------- */
  const probeOutlook = async () => {
    setProbing(true);
    setOutlook((o) => ({ ...o, error: '' }));
    try {
      const r = await api.get('/api/outlook/status');
      if (!r.ok) throw new Error(r.error || '无法连接本机 Outlook');
      const accs = r.accounts || [];
      if (!accs.length) throw new Error('Outlook 中还没有任何邮箱账号，请先在 Outlook 桌面客户端添加邮箱并完成首次同步');
      setOutlook({ accounts: accs, error: '', probed: true, picked: accs[0].smtp || accs[0].displayName || '' });
    } catch (e) {
      setOutlook({ accounts: [], error: e.message, probed: true, picked: '' });
    } finally { setProbing(false); }
  };

  const create = async () => {
    setBusy(true);
    try {
      let createdId = '';
      if (kind === 'outlook') {
        if (!outlook.probed || !outlook.accounts.length) await probeOutlook();
        if (!outlook.accounts.length) throw new Error(outlook.error || '未检测到 Outlook 账号');
        const acc = outlook.accounts.find((x) => (x.smtp || x.displayName) === outlook.picked) || outlook.accounts[0];
        const createdName = form.name.trim() || acc.displayName || (acc.smtp || '').split('@')[0] || 'Outlook 邮箱';
        const r = await api.post('/api/accounts', { kind: 'outlook-local', email: acc.smtp || '', name: createdName });
        createdId = r.account.id;
        toast(`已添加 Outlook 账户：${r.account.name}`, 'success');
      } else {
        if (!form.email.trim() || !form.password) { toast('请填写邮箱地址与应用密码', 'error'); return; }
        const svr = serverFromForm();
        if (!svr.host) { toast('请选择或填写服务器地址', 'error'); return; }
        const r = await api.post('/api/accounts', { kind: 'imap', name: form.name.trim() || form.email.split('@')[0], ...svr });
        createdId = r.account.id;
        toast(`已添加 IMAP 账户：${r.account.name}`, 'success');
      }
      setNewAccountOpen(false);
      // POST /api/accounts 内部已完成首轮同步 + 正文预取，
      // 这里不再重复 api.sync()（Outlook COM 首轮遍历很慢，重复会翻倍等待）。
      await refreshStatus(true);
      selectAccount(createdId);
      setView('mail');
      const st = await api.status().catch(() => null);
      const mine = st?.accounts?.find((a) => a.id === createdId);
      if (mine?.syncError) toast(`首轮同步有警告：${mine.syncError}`, 'error');
    } catch (e) {
      toast(e.message, 'error');
    } finally { setBusy(false); }
  };

  const doTest = async () => {
    setTestRes(null);
    try {
      const r = await api.post('/api/accounts/test', serverFromForm());
      setTestRes({ ok: r.connected, folders: r.folders || [], error: r.error || '' });
    } catch (e) { setTestRes({ ok: false, error: e.message }); }
  };

  return (
    <Modal title="添加邮箱账户" onClose={() => setNewAccountOpen(false)} wide footer={(
      <div className="modal-actions">
        <button className="btn ghost" onClick={() => setNewAccountOpen(false)}>取消</button>
        <button className="btn primary" onClick={create} disabled={busy}>
          {busy ? <Spinner size={14} /> : null} 保存并开始同步
        </button>
      </div>
    )}>
      <div className="seg">
        <button className={`seg-btn${kind === 'imap' ? ' active' : ''}`} onClick={() => setKind('imap')}>
          <Server size={14} /> IMAP 云端直连（推荐 · 新版 Outlook 请选这项）
        </button>
        <button className={`seg-btn${kind === 'outlook' ? ' active' : ''}`} onClick={() => { setKind('outlook'); setTestRes(null); }}>
          <Mailbox size={14} /> 经典 Outlook 桌面（仅支持旧版 classic）
        </button>
      </div>

      {kind === 'outlook' ? (
        <div className="outlook-wizard">
          <p className="note">
            <b>注意：此项只支持「经典 Outlook（classic）」。</b>若你平时用的是<b>新版 Outlook</b>
            （任务栏里 1.2026.x 版本），新版不提供 COM 自动化接口，无法在这里读取——请切换回
            「IMAP 云端直连」，只需一个应用密码即可把同一邮箱（如 you@outlook.com）同步进查看器，
            并与新版 Outlook 互相同步。
          </p>
          <p className="note">经典版模式：直接读取经典 Outlook 桌面已同步的邮件，无需邮箱密码。若你的本机装有经典版并已登录，可在下方检测。</p>
          <div className="modal-actions start-row">
            <button className="btn primary" onClick={probeOutlook} disabled={probing || busy}>
              {probing ? <Spinner size={14} /> : <RefreshCw size={14} />} {outlook.probed ? '重新检测本机 Outlook 账号' : '检测本机经典 Outlook 账号'}
            </button>
          </div>
          {outlook.error && <div className="err-text block"><AlertTriangle size={13} /> {outlook.error}</div>}
          {outlook.accounts.length > 0 && (
            <>
              <div className="account-pick-list">
                {outlook.accounts.map((a) => {
                  const id = a.smtp || a.displayName || a.userName || String(Math.random());
                  return (
                    <label key={id} className={`pick-card${outlook.picked === id ? ' on' : ''}`}>
                      <input type="radio" name="ol-acc" checked={outlook.picked === id} onChange={() => setOutlook((o) => ({ ...o, picked: id }))} />
                      <div>
                        <b>{a.displayName || a.userName || '(未命名账号)'}</b>
                        <div className="dim">{a.smtp || '（未显示邮箱地址）'}</div>
                      </div>
                    </label>
                  );
                })}
              </div>
              <Field label="此账户在查看器中的显示名称（可选）">
                <input className="inp" placeholder="例如：学校 Outlook" value={form.name} onChange={(e) => set('name', e.target.value)} />
              </Field>
            </>
          )}
          <ul className="wizard-tips">
            <li>只有“经典 Outlook”会出现在此列表；如果你没装经典版或不想用它，直接用上方 IMAP 方式。</li>
            <li>添加后查看器会读取该 Outlook 账户各文件夹的信封信息入库，正文与附件后台逐封抓取。</li>
            <li>Outlook 未运行时同步会自动启动它；若你已经手动打开 Outlook，则不会关闭。</li>
            <li>在本查看器里标记已读 / 未读、加星标会写回 Outlook 桌面。</li>
          </ul>
        </div>
      ) : (
        <>
          <div className="form-grid">
            <Field label="常用名称">
              <input className="inp" placeholder="例如：学校 IMAP" value={form.name} onChange={(e) => set('name', e.target.value)} />
            </Field>
            <Field label="邮箱地址 *">
              <input className="inp" placeholder="you@example.com" value={form.email} onChange={(e) => set('email', e.target.value)} />
            </Field>
            <Field label="邮箱服务商">
              <select className="inp" value={form.preset} onChange={(e) => pickPreset(Number(e.target.value))}>
                {(presets?.hostPresets || []).map((p, i) => <option key={i} value={i}>{p.label}</option>)}
              </select>
              <div className="field-hint">{preset.note || ''}</div>
            </Field>
            <Field label="IMAP 服务器">
              <input className="inp" placeholder="outlook.office365.com" value={form.host} onChange={(e) => set('host', e.target.value)} />
            </Field>
            <Field label="端口" hint="以你填写的值为准（993=SSL，143=STARTTLS/明文）">
              <input className="inp" type="number" value={form.port} onChange={(e) => set('port', Number(e.target.value))} />
            </Field>
            <Field label="登录用户名（可选）">
              <input className="inp" placeholder="一般与邮箱相同" value={form.username} onChange={(e) => set('username', e.target.value)} />
            </Field>
            <Field label="密码 / 应用专用密码 *">
              <input className="inp" type="password" placeholder="Outlook.com 应用密码 / QQ 授权码" value={form.password} onChange={(e) => set('password', e.target.value)} />
              <div className="field-hint">Outlook.com：先生成「应用密码」再填入（两步验证→高级安全选项→应用密码，16 位）；QQ 填授权码。具体步骤见《使用指南》第 4 节。新版 Outlook 用户请用此项。</div>
            </Field>
            <Field label="">
              <label className="check-row"><input type="checkbox" checked={form.ssl} onChange={(e) => set('ssl', e.target.checked)} /> 使用 SSL/TLS 加密（默认端口 993）</label>
              <label className="check-row"><input type="checkbox" checked={form.allowInsecureTls} onChange={(e) => set('allowInsecureTls', e.target.checked)} /> 允许不校验 TLS 证书（仅自签名服务器时使用，有安全风险）</label>
            </Field>
          </div>
          <div className="modal-actions">
            <button className="btn ghost" onClick={doTest}><RefreshCw size={14} /> 测试连接</button>
            {testRes && (
              testRes.ok
                ? <span className="ok-text">✓ 连接成功，检测到 {testRes.folders.length} 个文件夹</span>
                : <span className="err-text">✗ 连接失败：{testRes.error}</span>
            )}
          </div>
        </>
      )}
    </Modal>
  );
}
