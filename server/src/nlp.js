// NLP：从邮件文本中识别日期 / 截止时间（中英文规则式，无外部依赖）
import { stripHtml } from './util.js';

const WEEKDAY_CN = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '天': 7, '日': 7, '末': 7 };
const WEEKDAY_EN = { monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2, wednesday: 3, wed: 3, thursday: 4, thu: 4, thur: 4, friday: 5, fri: 5, saturday: 6, sat: 6, sunday: 7, sun: 7 };
const MONTHS_EN = { january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4, may: 5, june: 6, jun: 6, july: 7, jul: 7, august: 8, aug: 8, september: 9, sep: 9, sept: 9, october: 10, oct: 10, november: 11, nov: 11, december: 12, dec: 12 };

export const d = (ms) => new Date(ms);
export const startOfDay = (dt) => { const x = new Date(dt); x.setHours(0, 0, 0, 0); return x; };
export const dayMs = 86400000;

function relWeekdayToMs(weekdayNum, weeksAhead = 0) {
  const now = new Date();
  const today = now.getDay() || 7; // 1..7（周一..周日）
  let diff = weekdayNum - today + weeksAhead * 7;
  // 本周内的过去工作日 → 推到下周
  if (weeksAhead === 0 && diff < 0) diff += 7;
  if (weeksAhead === 0 && diff === 0) diff = 7; // 「周一」若今天正好周一，视为下周一
  const target = startOfDay(Date.now());
  target.setDate(target.getDate() + diff);
  return target.getTime();
}

function toLocalMs(year, month, day, hour = 0, minute = 0) {
  const x = new Date(year, month - 1, day, hour, minute, 0, 0);
  return x.getTime();
}

/** 文本中出现的中文/英文月份名 */
function matchMonthName(text, idx) {
  // 形如 "3月" / "March 5" / "5 March"
  const cn = text.slice(idx).match(/^(\d{1,2})\s*月/);
  if (cn) return { month: Number(cn[1]), len: cn[0].length };
  const en = text.slice(idx).toLowerCase().match(/^(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)/);
  if (en) return { month: MONTHS_EN[en[1]], len: en[0].length };
  return null;
}

/** 在位置 i 尝试识别日期表达式，返回 {ms, phrase, end} 或 null。relative=true 表示解析到今天之后 */
function tryParseDateAt(text, i) {
  const now = new Date();
  const rest = text.slice(i);

  // 今天/明天/后天/大后天
  const rel = rest.match(/^(今天|今日|今晚|明天|明日|明晚|后天|大后天|后天晚上)/);
  if (rel) {
    const w = rel[1];
    let add = 0;
    if (w.startsWith('明天') || w.startsWith('明日')) add = 1;
    else if (w.startsWith('后天')) add = 2;
    else if (w.startsWith('大后天')) add = 3;
    const t = startOfDay(Date.now());
    t.setDate(t.getDate() + add);
    const isEvening = w.includes('晚');
    let ms = t.getTime();
    return { ms, phrase: w, end: rel[0].length, timeHint: isEvening ? '晚' : '' };
  }

  // 下周一 / 下周五 / 周一 / 星期X / 礼拜X / 周X / next Monday / Friday（带 this/next）
  const wd = rest.match(/^(下|这|本|next|this)?\s*(周|星期|礼拜)?([一二三四五六天日])(的?[上午下午晚上]|(?:周|礼拜|星期)\s*[一二三四五六天日])?/);
  // 更简单的直接正则
  const wd2 = rest.match(/^(?:(下周|下星期|下礼拜|next week|下个礼拜|下个星期)\s*)?(?:周|星期|礼拜|周)[一二三四五六天日]/);
  const wd3 = rest.match(/^(?:(下周|下星期|next\s*week\s*)?)(monday|mon|tuesday|tue|tues|wednesday|wed|thursday|thu|thur|friday|fri|saturday|sat|sunday|sun)/i);

  let weekdayMatch = null;
  if (rest[0] === '周' || rest[0] === '礼拜' || rest.slice(0, 2) === '星期') {
    const m = rest.match(/^(周|星期|礼拜)([一二三四五六天日])/);
    if (m) weekdayMatch = { num: WEEKDAY_CN[m[2]], phrase: m[0], len: m[0].length, offset: 0 };
  } else {
    const m2 = rest.match(/^((?:下|这|本)?周)([一二三四五六天日])/);
    if (m2) weekdayMatch = { num: WEEKDAY_CN[m2[2]], phrase: m2[0], len: m2[0].length, offset: m2[1].includes('下') ? 1 : 0 };
  }
  if (!weekdayMatch && wd3) {
    const prefix = /^next\s*week/i.test(rest) ? 1 : 0;
    const m4 = rest.toLowerCase().match(/^(?:(?:next|this)\s*week\s*,\s*)?(monday|mon|tuesday|tue|tues|wednesday|wed|thursday|thu|thur|friday|fri|saturday|sat|sunday|sun)/);
    if (m4) weekdayMatch = { num: WEEKDAY_EN[m4[1]], phrase: m4[0], len: m4[0].length, offset: prefix };
  }
  if (weekdayMatch) {
    let ms = relWeekdayToMs(weekdayMatch.num, weekdayMatch.offset);
    return { ms, phrase: weekdayMatch.phrase, end: weekdayMatch.len, weekday: weekdayMatch.num };
  }

  // 今晚/今天 X 点 这类已含上面的 rel（今晚属于 rel）。处理“本周五晚”由上方 wd 分支？忽略。
  // 数字日期： 2025年3月5日 / 3月5日 / 3月5号 / 12月25日(周日) / 3.5 / 3/5 / 03-05 / 5月5日
  const num = rest.match(/^((20\d{2}|19\d{2})年)?(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?/);
  if (num) {
    const year = num[2] ? Number(num[2]) : now.getFullYear();
    const month = Number(num[3]);
    const day = Number(num[4]);
    // BUG-19：必须是真实存在的日期，且不落在更长数字串/电话号里
    if (validYmd(year, month, day) && isolated(text, i, i + num[0].length) && !inPhoneContext(text, i)) {
      let y = year;
      // 若为今年早些月份（已过），推明年（如 1月5日，现在是6月）
      if (toLocalMs(y, month, day) < startOfDay(Date.now()).getTime() && !num[2]) y += 1;
      const ms = toLocalMs(y, month, day);
      return { ms, phrase: num[0], end: num[0].length };
    }
  }
  const sl = rest.match(/^(\d{1,2})[\/\-.](\d{1,2})(?:[\/\-.](\d{2}|\d{4}))?/);
  if (sl && !/^\d{1,2}:\d{2}/.test(rest)) {
    let year = now.getFullYear(); const month = Number(sl[1]); const day = Number(sl[2]);
    if (sl[3]) {
      const y3 = Number(sl[3]);
      if (y3 > 1000) year = y3; else year = 2000 + y3;
    }
    if (validYmd(year, month, day) && isolated(text, i, i + sl[0].length) && !inPhoneContext(text, i)) {
      if (toLocalMs(year, month, day) < startOfDay(Date.now()).getTime() && !sl[3]) year += 1;
      return { ms: toLocalMs(year, month, day), phrase: sl[0], end: sl[0].length };
    }
  }
  // 英文: March 5 或 5th March / May 15th
  const enm = rest.match(/^(([A-Za-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?)/);
  if (enm) {
    const mon = MONTHS_EN[enm[2].toLowerCase()];
    if (mon && validYmd(now.getFullYear(), mon, Number(enm[3])) && isolated(text, i, i + enm[0].length)) {
      let y = now.getFullYear();
      if (toLocalMs(y, mon, Number(enm[3])) < startOfDay(Date.now()).getTime()) y += 1;
      return { ms: toLocalMs(y, mon, Number(enm[3])), phrase: enm[0], end: enm[0].length };
    }
  }
  const enm2 = rest.match(/^((\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+))/);
  if (enm2) {
    const mon = MONTHS_EN[enm2[3].toLowerCase()];
    if (mon && validYmd(now.getFullYear(), mon, Number(enm2[2])) && isolated(text, i, i + enm2[0].length)) {
      let y = now.getFullYear();
      if (toLocalMs(y, mon, Number(enm2[2])) < startOfDay(Date.now()).getTime()) y += 1;
      return { ms: toLocalMs(y, mon, Number(enm2[2])), phrase: enm2[0], end: enm2[0].length };
    }
  }
  return null;
}

/** 在日期后跟随时间，如 下午2:30 / 14:00 / 2pm / 两点半 / 上午9点 */
function tryParseTimeAt(text, i) {
  const rest = text.slice(i);
  const ampm = rest.match(/^(凌晨|清晨|早上|早晨|上午|中午|下午|傍晚|晚上|夜里|night|evening|morning|afternoon|pm|am|p\.m\.|a\.m\.)/i);
  let hourBase = null;
  let end = 0;
  const head = ampm ? ampm[0] : '';
  const rem = ampm ? text.slice(i + head.length) : rest;
  const clock = rem.match(/^(\d{1,2}):(\d{2})/);
  const clock2 = rem.match(/^(\d{1,2})\s*[点:：](\d{1,2})?\s*(分|半)?/);
  const english = rem.match(/^(\d{1,2})\s*(am|pm|a\.m\.|p\.m\.)/i);
  if (clock) {
    hourBase = Number(clock[1]); const min = Number(clock[2]);
    let h = hourBase;
    if (head && (head.includes('下午') || head.includes('傍晚') || head.includes('晚上') || /pm/i.test(head))) h = hourBase < 12 ? hourBase + 12 : hourBase;
    else if (head && (head.includes('凌晨') || head.includes('上午') || head.includes('早上') || head.includes('中午'))) h = hourBase === 12 && head.includes('中午') ? 12 : (hourBase === 12 ? 0 : hourBase);
    else if (head && head.includes('晚上') && hourBase < 12) h = hourBase + 12;
    end = head.length + clock[0].length;
    return { ms: null, h, min, phrase: head + clock[0], end };
  }
  if (clock2) {
    let h = Number(clock2[1]); let min = clock2[2] ? Number(clock2[2]) : 0;
    if (clock2[3] === '半') min = 30;
    if (head) {
      if (/(下午|傍晚|晚上|pm)/i.test(head) && h < 12) h += 12;
      if (/中午/.test(head) && h === 12) h = 12;
      if (/凌晨/.test(head) && h === 12) h = 0;
    } else if (h >= 8 && h <= 11) { /* 默认上午 */ }
    end = head.length + clock2[0].length;
    return { ms: null, h, min, phrase: head + clock2[0], end };
  }
  if (english) {
    let h = Number(english[1]);
    const ap = english[2].toLowerCase();
    if (ap.startsWith('p') && h < 12) h += 12;
    if (ap.startsWith('a') && h === 12) h = 0;
    end = head.length + english[0].length;
    return { ms: null, h, min: 0, phrase: head + english[0], end };
  }
  // 两点半 / 九点
  const cjk = rem.match(/^([一二三四五六七八九十两])\s*点\s*([一二三四五六七八九十两]+\s*分|半)?/);
  if (cjk) {
    const num = (w) => { const map = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }; return w ? map[w] || 0 : 0; };
    let h = num(cjk[1]);
    let min = 0;
    if (cjk[2] === '半') min = 30;
    else if (cjk[2]) { const mm = cjk[2].match(/([一二三四五六七八九十两]+)分/); min = mm ? num(mm[1]) : 0; }
    if (head && /(下午|傍晚|晚上|pm)/i.test(head) && h < 12) h += 12;
    end = head.length + cjk[0].length;
    return { ms: null, h, min, phrase: head + cjk[0], end };
  }
  return null;
}

const TRIGGER = {
  due: ['截止', '提交截止', '交稿截止', 'ddl', 'deadline', 'due', '须在', '务必在', '请在', '前提交', '前完成', '前交', '到期', '最后期限', '截止时间', '提交时间', '之前交'],
  exam: ['考试', '测验', 'quiz', 'exam', '期中', '期末'],
  event: ['会议', '活动', '讲座', '面试', '聚会', 'meeting', 'event', 'seminar', 'workshop', '报到', '集合'],
};
// BUG-19：删除 '日期/时间/安排/于/计划/schedule' 这类泛触发词 —— 它们几乎每句都能命中，
// 会把电话号码、编号、无意义片段都变成“日程”。

function triggerType(word) {
  const w = String(word).toLowerCase();
  if (TRIGGER.due.some((t) => w.includes(t.toLowerCase()))) return 'due';
  if (TRIGGER.exam.some((t) => w.includes(t.toLowerCase()))) return 'exam';
  if (TRIGGER.event.some((t) => w.includes(t.toLowerCase()))) return 'event';
  return null;   // 未命中明确语义词 → 不产生候选
}

const MAX_GAP = 30;        // 触发词与日期之间的最大字符距离
const HIGH_GAP = 15;       // 触发词紧邻日期（截止/考试）→ 高置信度

/** 合法日期校验：月份 1–12、日期在当月真实存在、年份在合理区间（BUG-19） */
function validYmd(y, m, day) {
  if (!(m >= 1 && m <= 12)) return false;
  if (!(day >= 1 && day <= 31)) return false;
  if (!(y >= 2000 && y <= 2100)) return false;
  const dt = new Date(y, m - 1, day);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === day;
}

/** 数字/短横线日期必须不在更长的数字串里（排除电话号、编号、区间，如 T: 3943-1526） */
function isolated(text, start, end) {
  const before = start > 0 ? text[start - 1] : '';
  const after = end < text.length ? text[end] : '';
  return !/\d/.test(before) && !/\d/.test(after);
}

/** 该位置是否处于电话/传真/编号语境 */
function inPhoneContext(text, start) {
  return /(tel|telephone|phone|fax|mobile|电话|手机|传真|编号|学号|card|账号|account|no\.)\s*[:：]?\s*$/i.test(text.slice(Math.max(0, start - 16), start));
}

/** 把扫描窗口切成句子/子句 */
function splitClauses(text) {
  return text
    .replace(/([。！？!?；;\n])/g, '$1|')
    .split('|')
    .map((s) => s.trim())
    .filter((s) => s.length >= 4);
}

/**
 * 从文本中提取日期候选。
 * @param {string} text
 * @returns {Array<{ms:number, phrase:string, time?:{h:number,min:number,phrase:string}, context:string, type:string, source:string}>}
 */
export function extractDates(text) {
  const candidates = [];
  const cleaned = String(text || '')
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/（/g, '(').replace(/）/g, ')');
  const clauses = splitClauses(cleaned);
  for (const clause of clauses) {
    // 找触发词
    const trigs = [];
    for (const [type, words] of Object.entries(TRIGGER)) {
      const low = clause.toLowerCase();
      for (const w of words) {
        let from = 0; let p;
        while ((p = low.indexOf(w.toLowerCase(), from)) >= 0) {
          trigs.push({ idx: p, type, word: w });
          from = p + w.length;
        }
      }
    }
    // 找日期
    const dates = [];
    for (let i = 0; i < clause.length; i++) {
      const t = tryParseDateAt(clause, i);
      if (t) {
        dates.push({ idx: i, ...t });
        i += Math.max(t.end - 1, 1);
      }
    }
    // 找时间
    const times = [];
    for (let i = 0; i < clause.length; i++) {
      const t = tryParseTimeAt(clause, i);
      if (t) {
        times.push({ idx: i, ...t });
        i += Math.max(t.end - 1, 1);
      }
    }
    if (!dates.length) continue;
    // BUG-19：候选必须与“明确的截止/考试/活动语义词”共现；没有触发词的一律丢弃
    for (const dt of dates) {
      const before = trigs
        .filter((tr) => tr.idx <= dt.idx + 2 && dt.idx - tr.idx <= MAX_GAP)
        .sort((a, b) => (dt.idx - a.idx) - (dt.idx - b.idx));
      const trig = before[0]
        || trigs.filter((tr) => tr.idx > dt.idx && tr.idx - (dt.idx + dt.end) <= MAX_GAP).sort((a, b) => a.idx - b.idx)[0]
        || null;
      if (!trig) continue;
      const gap = Math.abs(trig.idx - dt.idx);
      const nearTime = times
        .filter((tm) => tm.idx >= dt.idx + dt.end - 2 && tm.idx - dt.idx <= 40)
        .sort((a, b) => a.idx - b.idx)[0];
      let ms = dt.ms;
      const h = nearTime ? nearTime.h : null;
      const min = nearTime ? nearTime.min : null;
      if (h != null && dt.phrase === '今晚') { /* 晚上默认 20:00 */ }
      if (h != null && !dt.timeHint) ms = dt.ms + (h * 3600 + (min || 0) * 60) * 1000;
      const ctxFrom = Math.max(0, trig.idx - 6);
      const ctxTo = Math.min(clause.length, dt.idx + dt.end + 18);
      const context = clause.slice(ctxFrom, ctxTo);
      // 置信度：截止/考试词紧邻日期 → 高；活动词或距离较远 → 中
      const confidence = (gap <= HIGH_GAP && trig.type !== 'event') ? 'high' : 'medium';
      candidates.push({
        ms,
        dateMs: dt.ms,
        phrase: dt.phrase,
        time: nearTime ? { h, min, phrase: nearTime.phrase } : null,
        context,
        type: trig.type,
        trigger: trig.word,
        confidence,
        source: 'email',
      });
    }
  }
  // 去重（同一天同一类型只留一条，优先高置信度）
  candidates.sort((a, b) => Number(b.confidence === 'high') - Number(a.confidence === 'high'));
  const seen = new Set();
  return candidates.filter((c) => {
    const k = `${c.ms}|${c.type}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, 12);
}

/** 从邮件对象提取日期（subject + 正文） */
export function extractFromMessage(m) {
  let body = m.bodyText;
  if (!body && m.bodyHtml) body = stripHtml(m.bodyHtml);
  const text = [m.subject, body].filter(Boolean).join('\n');
  const list = extractDates(text);
  return list.map((c) => ({ ...c, messageId: m.id, subject: m.subject }));
}
