// 应用设置与默认值
import { SettingsStore } from './store.js';

export const DEFAULT_SETTINGS = {
  // 服务端口
  port: 3869,
  // 自动同步间隔（分钟），0 表示关闭
  syncIntervalMin: 10,
  // 是否显示/同步“草稿箱”（默认隐藏：本查看器不需要草稿功能，可在设置 → 外观 打开）
  showDrafts: false,
  // 首次同步回看天数
  initialSyncDays: 30,
  // 新邮件自动获取正文的条数上限（每次同步）
  hydrateNewLimit: 60,
  // 附件缓存容量上限 MB
  attachmentCapMB: 400,
  // 自动把“杂项附件”（logo/签名图/免责声明等）移出附件主列表（可在设置 → 外观 关闭）
  junkHideAuto: true,
  // 打开邮件时是否自动标记已读（会同步回邮箱服务器，可在设置 → 外观 关闭）
  markReadOnOpen: true,
  // 附件库排序：createdAt（时间，默认）| size（大小）
  attachmentSort: 'createdAt',
  attachmentSortDir: 'desc',
  // 开机自启（Windows：写入注册表 Run，指向 start-silent.vbs 无窗口启动；可在设置 → 启动与通知 关闭）
  autoStart: true,
  // 收到新邮件时发送系统/应用内通知
  newMailNotify: true,
  // AI 配置（OpenAI 兼容通用适配）
  ai: {
    enabled: false,          // 总开关；关闭时使用关键词规则
    active: 'deepseek',      // 当前使用的服务商 preset
    autoClassify: true,
    autoSummarize: true,     // 仅对超过 300 字的正文
    providers: {
      deepseek: { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: '' },
      openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: '' },
      kimi: { label: 'Moonshot Kimi', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k', apiKey: '' },
      glm: { label: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash', apiKey: '' },
      qwen: { label: '通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', apiKey: '' },
      ollama: { label: '本地 Ollama（未安装也能配置，等装好后即用）', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b', apiKey: '' },
    },
  },
  // 分类枚举与中文名
  categories: {
    course: '课程通知', assignment: '作业提交', grade: '成绩发布', club: '社团活动',
    system: '系统提醒', promo: '营销推广', spam: '垃圾邮件', personal: '个人往来', other: '其他',
  },
  categoryColors: {
    course: '#3b82f6', assignment: '#8b5cf6', grade: '#10b981', club: '#f59e0b',
    system: '#64748b', promo: '#ef4444', spam: '#94a3b8', personal: '#06b6d4', other: '#9ca3af',
  },
  // 未读重点邮件每日汇总
  digest: {
    enabled: false,
    time: '21:00',
    // 汇总时按这些分类优先（前面的是“重点”）
    importantCategories: ['assignment', 'grade', 'course', 'club'],
    // 最早只汇总多少小时内的新到邮件（避免轰炸）
    windowHours: 30,
  },
  // 附件快速保存默认目录（默认取本机「文档/邮件附件」，不可写则退回 data/saved）
  attachmentSaveDir: '',
  autoOpenFolderAfterSave: true,
  // 界面主题偏好（light | dark | system）
  theme: 'system',
};

export function getSettings() {
  const raw = SettingsStore.all();
  return { ...DEFAULT_SETTINGS, ...raw };
}

export function updateSettings(patch) {
  const cur = getSettings();
  // 递归合并一层（ai/digest 等对象）
  const next = { ...cur };
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && cur[k] && typeof cur[k] === 'object') {
      next[k] = { ...cur[k], ...v };
    } else {
      next[k] = v;
    }
  }
  for (const [k, v] of Object.entries(next)) SettingsStore.set(k, v);
  return next;
}

/** 分类的中文名 */
export function catLabel(code) {
  const s = getSettings();
  return (s.categories && s.categories[code]) || code;
}

/** 邮件服务商预设（新建账户向导用） */
export const HOST_PRESETS = [
  { label: 'Outlook.com（个人微软账户）', host: 'outlook.office365.com', port: 993, ssl: true, note: '适用于新版 Outlook / 网页版 / 手机 Outlook 使用的同一账号。先在 account.microsoft.com/security 开启两步验证，再在「高级安全选项」生成 16 位应用密码，用它作为密码（不是网页登录密码）。无需在网页版另开 IMAP 开关。' },
  { label: 'Office 365 学校/公司邮箱', host: 'outlook.office365.com', port: 993, ssl: true, note: '组织账户若开启 IMAP 且允许应用密码即可使用；否则需找管理员，或改用 Graph 方案' },
  { label: 'QQ 邮箱', host: 'imap.qq.com', port: 993, ssl: true, note: '需在 QQ 邮箱网页版「设置→账户」开启 IMAP/SMTP 并获取授权码' },
  { label: '网易 163 邮箱', host: 'imap.163.com', port: 993, ssl: true, note: '需开启 IMAP 并获取客户端授权码' },
  { label: 'Gmail', host: 'imap.gmail.com', port: 993, ssl: true, note: '建议开启两步验证后使用应用专用密码' },
  { label: '自定义 IMAP 服务器', host: '', port: 993, ssl: true, note: '' },
];
