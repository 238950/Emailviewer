// 全局状态（zustand）
import { create } from 'zustand';
import { api } from './api.js';

const THEME_KEY = 'mailview.theme';

export const useStore = create((set, get) => ({
  ready: false,
  bootError: '',
  accounts: [],
  status: null,
  settings: null,
  presets: null,
  categories: null,       // {categoryName -> label}
  categoryColors: null,

  view: 'home',           // home | mail | smart | chat | attach | calendar | settings
  accountId: '',          // 当前选中账户（''=统一/全部）
  folder: 'INBOX',
  expandedAccounts: [],   // 副账户展开（占用少时折叠）
  newAccountOpen: false,
  folderTree: {},         // accountId -> folders
  chatSeed: null,         // “把邮件发给 AI”：{ emailIds, prompt, ts }

  messageId: null,        // 当前打开邮件 id
  messageDraft: null,     // 列表行快照（正文未到时先展示发件人/主题，提升预览体验）
  msgVersion: 0,          // 递增以触发详情重取
  listKey: 0,             // 列表刷新信号
  query: {},              // 邮件列表过滤参数
  smartAccountIds: [],    // 智能收件箱选中的账户
  smartCategories: [],    // 智能收件箱分类过滤

  // BUG-08：初始主题跟随系统的浅/深色；本地只作“临时覆盖”，后端 settings.theme 才是持久偏好
  theme: localStorage.getItem(THEME_KEY) || 'system',
  toasts: [],
  notifications: [],
  newDigest: null,
  syncing: {},

  toast(msg, type = 'info') {
    const id = Date.now() + Math.random();
    set((s) => ({ toasts: [...s.toasts, { id, msg, type }] }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 3600);
  },

  setTheme(theme) {
    localStorage.setItem(THEME_KEY, theme);
    set({ theme });
    applyTheme(theme);
    // BUG-08：同时写回后端设置，换浏览器/清缓存后偏好仍在
    api.put('/api/settings', { theme }).catch(() => {});
  },

  async bootstrap() {
    try {
      const [presets, settings] = await Promise.all([api.presets(), api.settings()]);
      const st = await api.status().catch(() => null);
      // BUG-08：没有本地覆盖时，采用后端持久化的主题偏好
      const localTheme = localStorage.getItem(THEME_KEY);
      const theme = localTheme || (settings.settings && settings.settings.theme) || 'system';
      set({
        ready: true,
        presets,
        settings: settings.settings,
        categories: presets.categories,
        categoryColors: presets.categoryColors,
        status: st,
        accounts: st ? st.accounts : [],
        accountId: get().accountId || (st && st.accounts[0] ? st.accounts[0].id : ''),
        expandedAccounts: (st ? st.accounts : []).filter((a) => a.isPrimary).map((a) => a.id),
        theme,
        bootError: '',
      });
      applyTheme(theme);
    } catch (e) {
      set({ ready: true, bootError: e.message });
    }
  },

  async refreshStatus(silent = false) {
    try {
      const st = await api.status();
      const prev = get().status;
      // 内容未变化则不触发重渲染（避免每 10 秒全树抖动）
      if (prev && JSON.stringify(prev) === JSON.stringify(st)) return;
      set({
        status: st,
        accounts: st.accounts,
        notifications: st.notifications || [],
        newDigest: st.digest || null,
        syncing: Object.fromEntries(st.accounts.map((a) => [a.id, a.syncing])),
      });
      // 首启/选择账户默认
      if (!get().accountId && st.accounts.length) set({ accountId: st.accounts[0].id });
      void silent;
    } catch { /* 后台轮询失败忽略 */ }
  },

  selectAccount(id) {
    set({ accountId: id, folder: 'INBOX', messageId: null, messageDraft: null });
    get().bumpList();
  },
  openFolder(id, fname) {
    set({ accountId: id, folder: fname, messageId: null, messageDraft: null });
    get().bumpList();
  },
  setFolderTree(id, folders) {
    set((s) => ({ folderTree: { ...s.folderTree, [id]: folders } }));
  },
  selectMessage(id) {
    set({ messageId: id, msgVersion: get().msgVersion + 1 });
  },
  /** 从列表打开一封邮件：立即记下快照用于阅读窗格即时展示 */
  openMessage(msg) {
    set({ messageId: msg?.id ?? null, messageDraft: msg || null, msgVersion: get().msgVersion + 1 });
  },
  setMessageDraft(d) { set({ messageDraft: d }); },
  closeMessage() {
    set({ messageId: null, messageDraft: null });
  },
  setView(v) { set({ view: v }); },
  /** 把一封/多封邮件发给 AI 助手（跳到对话页并预填） */
  sendMailToAI(emailIds, prompt) {
    const ids = (Array.isArray(emailIds) ? emailIds : [emailIds]).map(Number).filter(Boolean);
    set({ chatSeed: { emailIds: ids, prompt: prompt || '', ts: Date.now() }, view: 'chat' });
  },
  consumeChatSeed() {
    const seed = get().chatSeed;
    if (seed) set({ chatSeed: null });
    return seed;
  },
  setNewAccountOpen(v) { set({ newAccountOpen: v }); },
  bumpList() { set((s) => ({ listKey: s.listKey + 1 })); },
  setQuery(patch) { set((s) => ({ query: { ...s.query, ...patch }, listKey: s.listKey + 1 })); },
  toggleExpandAccount(id) {
    set((s) => ({
      expandedAccounts: s.expandedAccounts.includes(id)
        ? s.expandedAccounts.filter((x) => x !== id)
        : [...s.expandedAccounts, id],
    }));
  },
}));

export function applyTheme(theme) {
  const mode = theme === 'system'
    ? (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : theme;
  document.documentElement.dataset.theme = mode;
  document.documentElement.style.colorScheme = mode;
}

/* 分类显示辅助 */
export const M = {
  catLabel(code, categories) {
    return (categories && categories[code]) || code || '其他';
  },
  catColor(code, colors) {
    return (colors && colors[code]) || '#9ca3af';
  },
};

export const ATTACH_GROUPS = [
  { key: 'pdf', label: 'PDF' },
  { key: 'document', label: '文档' },
  { key: 'table', label: '表格' },
  { key: 'slide', label: '幻灯片' },
  { key: 'image', label: '图片' },
  { key: 'archive', label: '压缩包' },
  { key: 'calendar', label: '日历' },
  { key: 'text', label: '文本/代码' },
  { key: 'other', label: '其他' },
];
