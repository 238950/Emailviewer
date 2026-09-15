// .env 加载器（零依赖）+ API Key 解析
//
// 用途：把 API Key 等敏感配置从数据库（明文）挪到 .env 文件。
//
// 加载顺序与优先级：
//   1. 真实进程环境变量（如启动前 set AI_API_KEY_XXX=...）—— 最高，不会被文件覆盖
//   2. server/.env        —— 项目推荐位置
//   3. <项目根>/.env      —— 兜底，方便在根目录统一管理
//
// 注意：与部分第三方库不同，本加载器**不会**用文件里的值覆盖已存在的进程环境变量。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(here, '..');
const ROOT_DIR = path.resolve(SERVER_DIR, '..');

export const ENV_CANDIDATES = [
  path.join(SERVER_DIR, '.env'),
  path.join(ROOT_DIR, '.env'),
];

/** 实际成功加载到的 .env 文件绝对路径（供诊断/日志） */
export const ENV_FILES_LOADED = [];

/** 去掉值两侧引号，并处理双引号内的转义序列 */
function unquote(raw) {
  const s = String(raw).trim();
  if (s.length < 2) return s;
  const q = s[0];
  if (q !== '"' && q !== "'") return s;
  if (!s.endsWith(q)) return s;
  const inner = s.slice(1, -1);
  if (q === "'") return inner; // 单引号：原样保留
  return inner
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}

/** 解析 .env 文本为键值对 */
export function parseEnv(src) {
  const out = {};
  for (const rawLine of String(src).split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice(7).trim(); // 兼容 shell 写法
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let val = line.slice(eq + 1).trim();
    // 未加引号时，允许行尾用 " # 注释" 的形式写注释
    if (!/^["']/.test(val)) {
      const h = val.indexOf(' #');
      if (h >= 0) val = val.slice(0, h).trim();
    }
    out[key] = unquote(val);
  }
  return out;
}

for (const file of ENV_CANDIDATES) {
  try {
    if (!fs.existsSync(file)) continue;
    const parsed = parseEnv(fs.readFileSync(file, 'utf8'));
    for (const [k, v] of Object.entries(parsed)) {
      // 真实环境变量优先：已存在就不覆盖
      if (process.env[k] === undefined) process.env[k] = v;
    }
    ENV_FILES_LOADED.push(file);
  } catch {
    /* 单个文件读取失败不影响启动 */
  }
}

/** 服务商名 → 专属环境变量名：gateway → AI_API_KEY_GATEWAY */
export function providerEnvName(name) {
  return `AI_API_KEY_${String(name || '').toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
}

/**
 * 从环境变量取服务商密钥。
 * 优先取专属变量（AI_API_KEY_GATEWAY），没有则退回通用变量（AI_API_KEY）。
 * 空白字符串一律视为「未配置」。
 */
export function apiKeyFromEnv(providerName) {
  const specific = process.env[providerEnvName(providerName)];
  if (specific && specific.trim()) return specific.trim();
  const generic = process.env.AI_API_KEY;
  if (generic && generic.trim()) return generic.trim();
  return '';
}

/** 该服务商是否由 .env 托管密钥 */
export function isKeyFromEnv(providerName) {
  return !!apiKeyFromEnv(providerName);
}
