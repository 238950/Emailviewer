// 通用小工具
import crypto from 'node:crypto';

export const uid = () => crypto.randomUUID();

export const now = () => Date.now();

export const safeJson = (v, fb = null) => {
  try { return JSON.parse(v); } catch { return fb; }
};

export const toJson = (v) => JSON.stringify(v);

/** 截断字符串 */
export const trunc = (s, n = 200) => {
  if (!s) return '';
  return s.length > n ? s.slice(0, n) + '…' : s;
};

/** 规范化邮箱地址字段（mailparser 结构 -> 字符串列表） */
export const addrList = (arr) => {
  if (!Array.isArray(arr)) return [];
  return arr.map((a) => (a && (a.address || a.text)) || '').filter(Boolean);
};

export const addrText = (arr) => {
  if (!Array.isArray(arr)) return '';
  return arr.map((a) => {
    if (!a) return '';
    const name = a.name;
    const address = a.address || a.text || '';
    if (name && name !== address) return `${name} <${address}>`;
    return address || name || '';
  }).filter(Boolean).join('; ');
};

/** 判断是否为“草稿箱”类文件夹（默认隐藏且不同步，可在设置 → 外观 开启） */
export function isDraftFolderName(name) {
  const last = String(name || '').split(/[\\/]/).filter(Boolean).pop() || String(name || '');
  return /^drafts?$/i.test(last) || last.includes('草稿') || /draft/i.test(last);
}

/** 把文件夹名转为友好的中文名 */
export const prettyFolder = (name) => {
  const upper = String(name || '').toUpperCase();
  if (upper === 'INBOX') return '收件箱';
  const map = {
    SENT: '已发送', DRAFTS: '草稿', TRASH: '已删除', JUNK: '垃圾邮件', SPAM: '垃圾邮件',
    ARCHIVE: '归档', ARCHIVES: '归档', IMPORTANT: '重要', FLAGGED: '已加星标',
    '[GMAIL]/ALL MAIL': '全部邮件', '[GMAIL]/SENT MAIL': '已发送',
    '[GMAIL]/SPAM': '垃圾邮件', '[GMAIL]/TRASH': '已删除', '[GMAIL]/IMPORTANT': '重要',
    'JUNK EMAIL': '垃圾邮件', 'DELETED ITEMS': '已删除', 'SENT ITEMS': '已发送',
    'OUTBOX': '发件箱'
  };
  if (map[upper]) return map[upper];
  return name;
};

/**
 * MIME 大类定义 —— 全项目唯一来源（单一事实源）。
 *
 * 附件分组在三个地方被消费，历史上 util.js 与 store.js 各有一份定义且不一致
 * （util 有 code 组、把 text/html 归入 code；store 无 code 组、把 html 归入 text），
 * 导致「附件库按类型筛选」与「过滤规则的 attachment_group 匹配」对同一附件
 * 可能得出不同分组名。现统一在此处定义，store.js 与 rules.js 均从此导入。
 *
 * 注意：text/html、text/css、application/json 等归入 text 组而非 code，
 * 因为它们在邮件场景下基本都是正文/富文本残留，而非用户要下载的「代码文件」。
 */
export const MIME_GROUP = {
  document: [
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.oasis.opendocument.text',
    'application/rtf', 'text/rtf',
  ],
  table: [
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.oasis.opendocument.spreadsheet',
    'text/csv', 'text/tab-separated-values',
  ],
  slide: [
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.oasis.opendocument.presentation',
  ],
  pdf: ['application/pdf'],
  image: [
    'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp',
    'image/svg+xml', 'image/heic', 'image/tiff', 'image/avif',
  ],
  archive: [
    'application/zip', 'application/x-zip-compressed', 'application/x-rar-compressed',
    'application/x-7z-compressed', 'application/gzip', 'application/x-tar', 'application/x-bzip2',
  ],
  calendar: ['text/calendar', 'text/x-vcalendar', 'application/ics'],
  text: [],
  other: [],
};

/** 归入 text 组的非 text/ 前缀类型（JSON/XML/JS/PHP 等） */
const TEXT_LIKE = new Set([
  'application/json', 'application/xml', 'application/javascript', 'application/x-httpd-php',
]);

/**
 * 由 MIME 类型得到附件大类名。全项目唯一实现。
 * @param {string} mime
 * @returns {string} document | table | slide | pdf | image | archive | calendar | text | audio | video | other
 */
export const mimeGroup = (mime) => {
  const m = String(mime || '').toLowerCase();
  for (const [k, list] of Object.entries(MIME_GROUP)) {
    if (list.includes(m)) return k;
  }
  if (m.startsWith('text/') || TEXT_LIKE.has(m)) return 'text';
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('audio/')) return 'audio';
  if (m.startsWith('video/')) return 'video';
  return 'other';
};

export const stripHtml = (html) => {
  if (!html) return '';
  // 极简 HTML -> 文本（服务端兜底；前端用 DOM 精确提取）
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|table|blockquote|section)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
};

/** 生成单行摘要（无 AI 时的兜底：取第一段有信息量的句子） */
export function makeSnippetText(text, max = 180) {
  if (!text) return '';
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  if (clean.length <= max) return clean;
  // 尝试在句号/问号/感叹号后截断
  const cut = clean.slice(0, max);
  const m = cut.match(/^[\s\S]{0,180}?[。！？!?；;]/);
  if (m) return m[0];
  return cut + '…';
}

/** 简单关键词权重摘要（长邮件无 AI 时）：返回主题相关句 + 关键词 */
export function keywordSummary(subject, text, maxLen = 120) {
  const stop = new Set(['的', '了', '和', '是', '在', '我', '你', '他', '她', '它', '这', '那', '与', '及', '或', '并', '等', '对', '从', '到', '将', '请', '为', '于', '您', '们', '一个', '我们', '你们', '可以', '需要', '进行', 'the', 'a', 'an', 'and', 'or', 'to', 'of', 'in', 'for', 'with', 'on', 'at', 'is', 'are', 'be', 'please']);
  const words = (text || '').match(/[\u4e00-\u9fff]{2,6}|[A-Za-z][A-Za-z0-9_-]{3,}|[\u4e00-\u9fff]?[A-Za-z]{2,}/g) || [];
  const freq = {};
  for (const w of words) {
    const k = w.toLowerCase();
    if (stop.has(k)) continue;
    if (/^\d+$/.test(k)) continue;
    freq[k] = (freq[k] || 0) + 1;
  }
  const top = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([w]) => w);
  const first = makeSnippetText(text, maxLen);
  const head = (subject ? `主题「${subject}」；` : '') + first;
  if (!top.length) return head;
  return head + (head.length < 200 ? `  关键词：${top.join('、')}` : '');
}

/* ============ 附件“杂项/水印免责声明”识别（用于附件库自动归类） ============ */
const JUNK_FILE_PATTERNS = [
  /^image(00)?\d+\.(png|jpg|jpeg|gif|bmp)$/i,           // image001.png 等签名/水印小图
  /^(picture|pic)\d*\.(png|jpg|jpeg|gif|bmp)$/i,
  /^logo\d*\.(png|jpg|jpeg|gif|svg)$/i,
  /^(signature|banner|footer|header|background|bg)-?\w*\.(png|jpg|jpeg|gif|svg)$/i,
];
const JUNK_FILENAME_HINT = [
  'disclaimer', 'watermark', 'confidential', 'privilege', '免责声明', '保密声明', '水印',
  '电邮免责', '邮箱免责', 'email footer', 'mail footer', 'email disclaimer', 'e-mail footer',
  'footer note', 'footer-disclaimer', 'signature', 'electronic signature', '签名图',
  'untitled', 'unnamed', 'image of', 'notice strip', 'generated message', 'auto-footer',
  'this email and any', 'this message is', 'powered by', 'promotional watermark',
];

/**
 * 判断附件是否为“水印/免责声明/签名/小图标”类杂项。
 * 归入附件库的“杂项”虚拟文件夹并从主列表默认隐藏，减少噪音。
 */
export function isJunkAttachment(filename, mime, size) {
  const fn = String(filename || '').trim();
  const low = fn.toLowerCase();
  const mt = String(mime || '').toLowerCase();
  const sz = Number(size) || 0;

  // 明显的通用文件题名/LOGO 小图（image001…、logo、signature…）
  if (JUNK_FILE_PATTERNS.some((re) => re.test(fn))) return true;

  // 文件名包含免责声明/水印等关键词 → 无论格式
  if (JUNK_FILENAME_HINT.some((h) => low.includes(h))) return true;

  // 常见情形：无实义扩展名 + 超小体积 + 文件名本身像占位
  const ext = (fn.match(/\.([a-z0-9]{1,6})$/i) || [])[1];
  if (!ext) return false;
  const pure = low.replace(/\.[a-z0-9]+$/, '').trim();
  const looksPlaceholder = /^(email|mail|attachment|attach|file|document|new|test|untitled|scanned|scan)[-_ ]?\d*$/.test(pure)
    || /^(\d{3,})\s*$/.test(pure);
  if (mt.startsWith('text/') && sz > 0 && sz < 600 && looksPlaceholder) return true;

  // 纯文本水印/免责声明常见内容（文件名不含关键词但正文是免责声明）
  if (mt === 'text/plain' && sz > 0 && sz < 4000) {
    const shortName = fn.length < 30;
    if (shortName && /^(免责|watermark|disclaimer|notice|read.?me|声明|隐私|版权|copyright)/i.test(pure)) return true;
  }
  return false;
}

/** 分类说明（给 UI 用） */
export function junkAttachmentReason(filename, mime, size) {
  if (!isJunkAttachment(filename, mime, size)) return '';
  const fn = String(filename || '').toLowerCase();
  if (JUNK_FILENAME_HINT.some((h) => fn.includes(h))) return '含免责声明/水印等关键词';
  if (fn.startsWith('image') || fn.startsWith('logo') || fn.startsWith('pic') || fn.startsWith('signature')) return '签名/水印/小图标';
  return '疑似占位/水印文本';
}
