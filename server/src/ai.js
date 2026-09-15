// AI 层：OpenAI 兼容 API 通用客户端 + 邮件分类/摘要 + 关键词兜底
import './env.js';
import { apiKeyFromEnv } from './env.js';
import { getSettings, catLabel } from './settings.js';
import { MessageStore } from './store.js';
import { stripHtml, makeSnippetText, keywordSummary, trunc } from './util.js';
import { extractFromMessage } from './nlp.js';

/**
 * 解析某个服务商的可用密钥：**.env 优先，数据库配置兜底**。
 * 空白字符串（如 " "）一律视为未配置——旧版会把一个空格当成"已填 Key"。
 * @param {string} name 服务商 key（如 gateway / deepseek）
 * @param {string} dbKey 数据库里存的 apiKey
 * @returns {{key:string, source:'env'|'db'|'none'}}
 */
export function resolveApiKey(name, dbKey) {
  const fromEnv = apiKeyFromEnv(name);
  if (fromEnv) return { key: fromEnv, source: 'env' };
  const fromDb = String(dbKey == null ? '' : dbKey).trim();
  if (fromDb) return { key: fromDb, source: 'db' };
  return { key: '', source: 'none' };
}

/** 解析当前生效的 AI 提供方配置；不可用时返回 {ok:false, reason} */
export function activeProvider() {
  const s = getSettings();
  const ai = s.ai || {};
  if (!ai.enabled) return { ok: false, reason: 'AI 总开关未开启（将使用关键词规则）' };
  const p = ai.providers && ai.providers[ai.active];
  if (!p) return { ok: false, reason: '未找到服务商配置' };
  if (!p.baseUrl) return { ok: false, reason: 'Base URL 为空' };
  const { key, source } = resolveApiKey(ai.active, p.apiKey);
  if (!key) return { ok: false, reason: 'API Key 为空（请在 .env 或设置页配置）' };
  return { ok: true, name: ai.active, label: p.label, baseUrl: p.baseUrl.replace(/\/+$/, ''), model: p.model || '', apiKey: key, keySource: source };
}

/**
 * 调用 OpenAI 兼容 /chat/completions
 * @param {Array} messages [{role, content}]
 * @param {{maxTokens?:number, temperature?:number}} opts
 */
export async function chat(messages, opts = {}) {
  const p = activeProvider();
  if (!p.ok) throw new Error(p.reason);
  const body = {
    model: p.model,
    messages,
    temperature: opts.temperature ?? 0.2,
    max_tokens: opts.maxTokens ?? 1024,
    stream: false,
  };
  let res;
  try {
    res = await fetch(`${p.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${p.apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90000),
    });
  } catch (e) {
    throw new Error(`网络请求失败：${e.message}`);
  }
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.text()).slice(0, 300); } catch { /* */ }
    throw new Error(`接口返回 HTTP ${res.status}：${detail}`);
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('接口未返回内容');
  return content;
}

/** 从回复中尽量稳健地解析 JSON */
export function extractJson(content) {
  const text = String(content || '').trim();
  try { return JSON.parse(text); } catch { /* fallthrough */ }
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) {
    try { return JSON.parse(fence[1].trim()); } catch { /* fallthrough */ }
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch { /* fallthrough */ }
  }
  throw new Error('无法解析 AI 返回的 JSON');
}

export const CATEGORY_KEYS = ['course', 'assignment', 'grade', 'club', 'system', 'promo', 'spam', 'personal', 'other'];

/** 取消息正文文本 */
export function msgText(m) {
  let t = m.bodyText;
  if (!t && m.bodyHtml) t = stripHtml(m.bodyHtml);
  return (t || '').replace(/\s+/g, ' ').trim();
}

/* ---------------- 关键词兜底分类 ---------------- */
const KEYWORDS = {
  grade: [
    { kw: ['成绩', '分数', '绩点', 'GPA', '成绩单', '考试结果', '已公布', '查询成绩', 'grade', 'score', 'mark release', 'midterm'], w: 3 },
  ],
  assignment: [
    { kw: ['作业', '提交', '截止', 'DDL', 'deadline', 'due date', 'assignment', 'homework', '实验报告', '结课论文', '小组作业', '签到提交', '提交截止', '上传'], w: 3 },
  ],
  course: [
    { kw: ['课程', '课件', '讲义', '上课', '调课', '停课', '助教', '任课老师', 'lecture', 'syllabus', 'course', '本周课程', '答疑', 'class', '课前预习', '课堂'], w: 2 },
  ],
  club: [
    { kw: ['社团', '学生会', '招新', '活动报名', '志愿', '晚会', '讲座', '社团活动', '素拓', '文体', '比赛报名', '志愿者招募', 'club', 'volunteer', 'activity'], w: 2 },
  ],
  system: [
    { kw: ['验证码', '系统通知', '账户安全', '登录提醒', '邮箱管理员', '安全警报', '密码重置', 'two-factor', 'verification code', 'security alert', '找回密码'], w: 3 },
  ],
  promo: [
    { kw: ['优惠', '促销', '折扣', '限时', '特惠', '订阅', '会员', '推广', '广告', 'unsubscribe', 'discount', 'promotion', 'offer', 'sale', '推荐'], w: 2 },
  ],
  spam: [
    { kw: ['中奖', '彩票', '博彩', '兼职日结', '刷单', '贷款', '高薪招聘无门槛', 'viagra', 'casino', 'lottery', 'bitcoin赠', '加qq群领'], w: 4 },
  ],
  personal: [
    { kw: ['你好', '好久不见', '同学聚会', '私聊', '回个电话', '见一面', '你上次', '我们聊聊'], w: 1 },
  ],
};

function matchKws(text, kws) {
  const low = String(text || '').toLowerCase();
  let score = 0; let hit = '';
  for (const { kw, w } of kws) {
    for (const k of kw) {
      if (low.includes(k.toLowerCase())) { score += w; if (!hit) hit = k; }
    }
  }
  return { score, hit };
}

/** 本地关键词分类（无 AI / 失败兜底），返回 {category, reason} */
export function classifyByKeywords(m) {
  const subject = m.subject || '';
  const from = `${m.fromName || ''} ${m.fromAddr || ''}`;
  const body = msgText(m);
  const best = { cat: 'other', score: 0, hit: '' };
  for (const [cat, sets] of Object.entries(KEYWORDS)) {
    const a = matchKws(subject, sets);   // 主题权重*2
    const b = matchKws(from, sets);
    const c = matchKws(body, sets);
    const score = a.score * 2 + b.score * 1.5 + c.score;
    if (score > best.score) best.score = score, best.cat = cat, best.hit = a.hit || b.hit || c.hit;
  }
  if (best.score <= 0) return { category: 'other', reason: '' };
  return { category: best.cat, reason: `命中关键词「${best.hit}」` };
}

/* ---------------- 一句话摘要 ---------------- */
export function summarizeLocally(m) {
  const body = msgText(m);
  const use = body.length > 200 ? keywordSummary(m.subject, body, 110) : makeSnippetText(body || m.snippet || m.subject, 110);
  return use || (m.subject ? `（无正文）${m.subject}` : '');
}

/* ---------------- AI 批处理 ---------------- */
const SYSTEM_PROMPT = `你是学生邮件分类助手。请阅读下面每一封邮件的信息（可能被截断），为每封做四件事：
1. category：从以下枚举中选一个最合适的：course(课程通知), assignment(作业提交/截止提醒), grade(成绩发布/考试结果), club(社团活动/讲座/志愿), system(系统提醒/安全/验证码), promo(营销推广/订阅), spam(垃圾/诈骗), personal(个人往来), other(其他)。
2. summary：用中文写不超过25字的一句话摘要，概括这封邮件“是什么/要做什么/截止何时”。
3. worth：0-3 整数，表示这封邮件对一名大学生“是否值得花时间阅读/参加”：3=必须处理（缴费/注册/选课/成绩/重要截止/账号安全）；2=值得参加或关注（竞赛、讲座、招募、实习/奖学金申请、社团活动、课程安排变更）；1=一般通知（可扫一眼）；0=基本可忽略（广告、促销、水印免责声明、闲聊）。
   注意：很多校园活动（ICT 竞赛、讲座、招募、志愿、workshop、比赛、奖学金）是有价值的，不要因为“像广告”就判 0，除非确实是付费推广。
4. value：不超过15字的中文理由，说明为什么值得（或为何可忽略），例如“ICT竞赛，可加履历”。
5. dates：邮件中出现的**未来**时间点数组（截止/考试/活动/报名），每项 {"date":"YYYY-MM-DD","time":"HH:mm 或空串","title":"≤18字事件名","kind":"deadline|exam|event"}；没有就给空数组 []。
   - 只输出确实出现在邮件里的时间；相对时间（如“下周一”“本周五”）请换算成具体日期；跨年请补全年份。
   - time 必须是邮件里明确写出的**当地时间**（24 小时制）；邮件没写具体时刻就填空串 ""，**不要编造时间、不要换算时区**。
只输出一个 JSON 对象：{"results":[{"id":"对应编号","category":"...","reason":"分类依据≤12字","summary":"...","worth":2,"value":"...","dates":[{"date":"2026-09-30","time":"23:59","title":"提交实验报告","kind":"deadline"}]}]}。`;

/** 无 AI 时的本地价值评分（0-3）——保证首页“推荐活动/重要邮件”在离线也可用 */
export function localWorth(m) {
  const subj = String(m.subject || '');
  const text = `${subj} ${msgText(m).slice(0, 1500)}`;
  const low = text.toLowerCase();
  const HIGH = /交学费|缴费|学费|注册|选课|退课|补考|重修|成绩|绩点|gpa|学籍|毕业|学位|报到|务必|最后期限|账号安全|异常登录|缴费截止|注册截止/;
  const ACTIVITY = /竞赛|比赛|大赛|挑战赛|hackathon|ict|创新|招募|招新|报名|奖学金|助学金|实习|招聘|宣讲|校招|讲座|论坛|workshop|seminar|志愿|社团|会议|申请|提名|交流|夏令营/;
  const LOW = /优惠|促销|折扣|限时|特惠|订阅|退订|unsubscribe|广告|中奖|彩票|贷款|刷单|水印|免责声明|disclaimer/;
  if (LOW.test(low)) return { worth: 0, reason: '广告/促销或无实质内容' };
  if (HIGH.test(text)) return { worth: 3, reason: '涉及缴费/注册/成绩等重要事务' };
  if (ACTIVITY.test(text)) return { worth: 2, reason: '校园活动/机会，可考虑参加' };
  const cat = m.category;
  if (cat === 'assignment') return { worth: 3, reason: '作业或截止提醒' };
  if (cat === 'grade') return { worth: 3, reason: '成绩相关' };
  if (cat === 'system') return { worth: 2, reason: '系统/安全提醒' };
  if (cat === 'club' || cat === 'course') return { worth: 2, reason: '校园活动或课程通知' };
  if (cat === 'promo' || cat === 'spam') return { worth: 0, reason: '推广/垃圾邮件' };
  return { worth: 1, reason: '一般通知' };
}

/**
 * 用 AI 批量分类+摘要（含本地兜底写库）。
 * 自动按 15 封/请求分块，最多处理 120 封，避免一轮过长。
 */
export async function aiClassifyBatch(msgs, { save = true } = {}) {
  const all = msgs.filter(Boolean).slice(0, 120);
  const out = [];
  for (let i = 0; i < all.length; i += 15) {
    const chunk = all.slice(i, i + 15);
    out.push(...await classifyChunk(chunk, { save }));
    if (i + 15 < all.length) await sleep(350);
  }
  return out;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function classifyChunk(batch, { save = true } = {}) {
  const catNames = getSettings().categories || {};
  const out = [];
  if (!batch.length) return out;

  const needAI = activeProvider().ok;
  let aiResults = [];
  if (needAI) {
    try {
      const items = batch.map((m) => {
        const t = msgText(m).slice(0, 1200);
        return `编号:${m.id}\n发件人:${m.fromName || m.fromAddr}\n主题:${m.subject}\n正文:${t}`;
      }).join('\n\n----------\n\n');
      const content = await chat([
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `请分类以下邮件：\n\n${items}` },
      ], { maxTokens: 1800, temperature: 0.1 });
      const json = extractJson(content);
      aiResults = (json && (json.results || json)) || [];
      if (!Array.isArray(aiResults)) aiResults = [];
    } catch (e) {
      // AI 失败 → 全部走关键词兜底
    }
  }
  const aiMap = new Map();
  for (const r of aiResults) {
    const id = Number(r?.id ?? r?.msgId);
    if (id) aiMap.set(id, r);
  }
  const provider = activeProvider();
  const aiResponded = needAI && aiMap.size > 0; // 只有接口真实返回可用结果，才视为“已尝试过 AI”
  for (const m of batch) {
    const hit = aiMap.get(m.id);
    let category = 'other', reason = '', summary = '';
    if (hit && CATEGORY_KEYS.includes(hit.category)) {
      category = hit.category;
      reason = String(hit.reason || '').slice(0, 40);
      summary = String(hit.summary || '').slice(0, 80);
    } else {
      const kw = classifyByKeywords(m);
      category = kw.category; reason = kw.reason || (hit ? 'AI 分类无效，本地兜底' : '本地关键词分类');
      summary = hit && hit.summary ? String(hit.summary).slice(0, 80) : '';
    }
    if (!summary) summary = summarizeLocally(m);
    const aiHit = !!(hit && CATEGORY_KEYS.includes(hit.category));
    // 价值判定：优先 AI 的 worth/value，缺失或本地兜底时用规则
    const local = localWorth({ ...m, category, summary });
    let worth = local.worth;
    let worthReason = local.reason;
    if (aiHit) {
      const w = Number(hit.worth);
      if (Number.isFinite(w) && w >= 0 && w <= 3) { worth = Math.round(w); worthReason = String(hit.value || '').slice(0, 40) || local.reason; }
    }
    // 日期/截止时间：优先 AI 结果，缺失时回退正则识别（两者都会写入，供日历一键安排）
    let dates = [];
    if (aiHit && Array.isArray(hit.dates)) {
      dates = hit.dates.map((d) => {
        const date = String(d?.date || '').trim();
        const time = String(d?.time || '').trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
        const ms = new Date(`${date}T${/^\d{2}:\d{2}$/.test(time) ? time : '09:00'}:00`).getTime();
        if (!Number.isFinite(ms)) return null;
        return {
          ms, title: String(d?.title || '').slice(0, 24), kind: ['deadline', 'exam', 'event'].includes(d?.kind) ? d.kind : 'event', source: 'ai',
        };
      }).filter(Boolean);
    }
    if (!dates.length) {
      // AI 未给出可用日期时，规则兜底也只接受高置信度候选
      dates = extractFromMessage(m)
        .map((c) => ({ ms: c.ms, title: String(c.context || '').slice(0, 24), kind: c.type, confidence: c.confidence, source: 'rule' }))
        .filter((c) => c.confidence === 'high')
        .slice(0, 6);
    }
    const patch = {
      category, categoryReason: reason,
      categoryModel: aiHit ? (provider.model || 'ai') : 'local',
      categoryAt: Date.now(),
      worth, worthReason,
      dates, datesAt: Date.now(),
      ai_summary: summary, ai_summary_model: aiHit ? (provider.model || 'ai') : 'local', ai_summary_at: Date.now(),
    };
    if (aiResponded) patch.ai_attempted = 1; // 仅真实 AI 尝试后置位，避免无效 Key/未接 API 时把邮件“标记为已用 AI”
    if (save) MessageStore.update(m.id, patch);
    out.push({ id: m.id, category, categoryLabel: catNames[category] || category, reason, summary, worth, worthReason, dates, model: aiHit ? provider.model : 'local' });
  }
  return out;
}

/** 单封邮件：优先 AI 一句话摘要，失败本地 */
export async function summarizeMessage(m) {
  const local = summarizeLocally(m);
  let model = 'local';
  let summary = local;
  if (activeProvider().ok) {
    try {
      const t = msgText(m);
      if (t.length > 60) {
        const content = await chat([
          { role: 'system', content: '用中文把用户给的邮件内容概括成一句话，≤30字，直接输出这句话，不要任何前缀。' },
          { role: 'user', content: `主题：${m.subject}\n正文：\n${t.slice(0, 2500)}` },
        ], { maxTokens: 200, temperature: 0.2 });
        summary = String(content).trim().replace(/^["']|["']$/g, '').slice(0, 120);
        model = activeProvider().model;
      }
    } catch { summary = local; }
  }
  MessageStore.update(m.id, { ai_summary: summary, ai_summary_model: model, ai_summary_at: Date.now() });
  return { id: m.id, summary, model };
}

/** AI 连通性测试 */
export async function testProvider(providerKey) {
  const s = getSettings();
  const ai = s.ai || {};
  const p = ai.providers && ai.providers[providerKey];
  if (!p) throw new Error('未找到该服务商配置');
  if (!p.baseUrl) throw new Error('Base URL 为空');
  // 密钥解析：.env 优先，数据库兜底；空白字符视为未配置
  const { key, source } = resolveApiKey(providerKey, p.apiKey);
  if (!key) throw new Error('API Key 为空（请在 .env 或设置页配置）');
  const saved = ai.active;
  ai.active = providerKey;
  // 直接调用底层接口，避免依赖 activeProvider 的全局开关
  const body = { model: p.model, messages: [{ role: 'user', content: '你好' }], max_tokens: 8, stream: false };
  const res = await fetch(`${String(p.baseUrl).replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45000),
  });
  if (!res.ok) {
    let d = '';
    try { d = (await res.text()).slice(0, 200); } catch { /* */ }
    throw new Error(`HTTP ${res.status} ${d}`);
  }
  const data = await res.json();
  const reply = data?.choices?.[0]?.message?.content;
  if (!reply) throw new Error('接口未返回内容');
  return { ok: true, model: p.model, reply: String(reply).slice(0, 60), keySource: source };
}

export { catLabel };
export { trunc };
