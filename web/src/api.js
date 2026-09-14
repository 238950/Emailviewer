// 前端 API 封装
const BASE = '';

async function req(method, path, body) {
  let res;
  try {
    res = await fetch(BASE + path, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new Error('无法连接本地服务，请确认服务已启动');
  }
  let json = null;
  try { json = await res.json(); } catch { /* */ }
  if (!json || json.ok === false) {
    throw new Error((json && json.error) || `请求失败（HTTP ${res.status}）`);
  }
  return json;
}

export const api = {
  get: (p) => req('GET', p),
  post: (p, b = {}) => req('POST', p, b),
  put: (p, b = {}) => req('PUT', p, b),
  del: (p) => req('DELETE', p),

  // —— 便捷封装 ——
  accounts: () => api.get('/api/accounts'),
  status: () => api.get('/api/status'),
  presets: () => api.get('/api/presets'),
  settings: () => api.get('/api/settings'),
  folders: (id) => api.get(`/api/accounts/${id}/folders`),
  sync: (id) => api.post(`/api/accounts/${id}/sync`),
  messages: (params) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params || {})) {
      if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) continue;
      if (Array.isArray(v)) v.forEach((x) => qs.append(k, x));
      else qs.set(k, String(v));
    }
    const s = qs.toString();
    return api.get(`/api/messages${s ? `?${s}` : ''}`);
  },
  message: (id) => api.get(`/api/messages/${id}`),
  attachments: (params) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params || {})) {
      if (v === undefined || v === null || v === '') continue;
      if (Array.isArray(v)) v.forEach((x) => qs.append(k, x));
      else qs.set(k, String(v));
    }
    const s = qs.toString();
    return api.get(`/api/attachments${s ? `?${s}` : ''}`);
  },
  attachmentGroups: () => api.get('/api/attachments/groups'),
  events: (start, end) => api.get(`/api/events?start=${start || 0}&end=${end || ''}`),
};

export function attUrl(id, mode = 'inline') {
  return `${BASE}/api/attachments/${id}/${mode}`;
}
export function downloadUrl(id) {
  return `${BASE}/api/attachments/${id}/download`;
}

/**
 * BUG-38：统一下载入口。以前用 window.open(url,'_blank') 会留下一个空白标签页；
 * 这里取回二进制后用隐藏 <a download> 触发，文件名也能正确带上。
 */
export async function downloadAttachment(id, filename) {
  const res = await fetch(downloadUrl(id));
  if (!res.ok) throw new Error(`下载失败（HTTP ${res.status}）`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || `attachment-${id}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/* 常见工具 */
export const fmtBytes = (n) => {
  if (!n && n !== 0) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0; let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
};

export const fmtDate = (ms, opts = {}) => {
  if (!ms) return '';
  const d = new Date(ms);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const p = (x) => String(x).padStart(2, '0');
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  if (sameDay && !opts.full) return hm;
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString() && !opts.full) return `昨天 ${hm}`;
  const y = d.getFullYear() === now.getFullYear() ? '' : `${d.getFullYear()}年`;
  if (opts.full) return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
  return `${y}${d.getMonth() + 1}月${d.getDate()}日`;
};

export const dayLabel = (ms) => {
  if (!ms) return '';
  const d = new Date(ms); const now = new Date();
  const start = (x) => { const t = new Date(x); t.setHours(0, 0, 0, 0); return t; };
  const diffDays = Math.round((start(d) - start(now)) / 86400000);
  if (diffDays === 0) return '今天';
  if (diffDays === -1) return '昨天';
  if (diffDays === 1) return '明天';
  if (diffDays > 1 && diffDays < 7) return `${diffDays} 天后`;
  if (diffDays < -1 && diffDays > -7) return `${-diffDays} 天前`;
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
};
