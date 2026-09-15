// 一次性迁移：把数据库 setting.ai 里的**明文 API Key** 搬到 server/.env，并清空数据库里的明文。
//
// 背景：旧版把 AI Key 以明文存在 mailview.db 的 setting 表里（AI 分类/摘要用），
//       而 README 却声称"密钥仅本机加密保存"——实际只有 IMAP 密码走了 AES 加密。
//       迁移后密钥统一由 .env 托管，数据库里不再留明文。
//
// 用法：
//   node dev/migrate-keys-to-env.mjs            # 预演，只报告不修改
//   node dev/migrate-keys-to-env.mjs --apply    # 真正执行
//
// 执行前请先关掉正在运行的邮件查看器（避免与服务的写操作互相干扰），并先自行备份 data 目录。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { parseEnv, providerEnvName } from '../server/src/env.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const DB_FILE = path.join(ROOT, 'server', 'data', 'mailview.db');
const ENV_FILE = path.join(ROOT, 'server', '.env');

const APPLY = process.argv.includes('--apply');

if (!fs.existsSync(DB_FILE)) {
  console.error(`找不到数据库：${DB_FILE}`);
  process.exit(1);
}

// 读取 .env 中已有的键（不注入 process.env，纯做对照）
const envVars = fs.existsSync(ENV_FILE) ? parseEnv(fs.readFileSync(ENV_FILE, 'utf8')) : {};
const envHas = (name) => {
  const v = envVars[providerEnvName(name)];
  if (v && String(v).trim()) return true;
  const g = envVars.AI_API_KEY;
  return !!(g && String(g).trim());
};
const mask = (s) => {
  const v = String(s || '');
  if (!v) return '';
  if (v.length <= 8) return '****';
  return `${v.slice(0, 4)}${'*'.repeat(8)}${v.slice(-4)}`;
};

const db = new DatabaseSync(DB_FILE);
const row = db.prepare("SELECT value FROM setting WHERE key = 'ai'").get();
if (!row) {
  console.log('setting 表中没有 ai 配置，无需迁移。');
  db.close();
  process.exit(0);
}

const ai = JSON.parse(row.value);
const providers = ai.providers || {};
const toClear = [];   // 数据库里要清空的
const missing = [];   // 数据库里有、但 .env 里还没有的

for (const [name, p] of Object.entries(providers)) {
  const dbKey = String(p?.apiKey == null ? '' : p.apiKey);
  if (!dbKey.trim()) continue;
  if (envHas(name)) toClear.push({ name, preview: mask(dbKey.trim()) });
  else missing.push({ name, key: dbKey.trim() });
}

console.log(`\n数据库位置：${DB_FILE}`);
console.log(`.env 位置：  ${fs.existsSync(ENV_FILE) ? ENV_FILE : '（不存在）'}\n`);

if (toClear.length) {
  console.log('以下服务商的明文 Key 已在 .env 中提供，将从数据库清空：');
  for (const t of toClear) console.log(`  · ${t.name.padEnd(12)} ${t.preview}`);
} else {
  console.log('没有「已在 .env 中提供」的明文 Key 需要清空。');
}

if (missing.length) {
  console.log('\n以下服务商的 Key 只存在于数据库，.env 里还没有。');
  console.log('请先把下面这行加到 server/.env，再重新运行本脚本：\n');
  for (const m of missing) console.log(`  ${providerEnvName(m.name)}=${m.key}`);
}

if (!APPLY) {
  console.log('\n（预演模式，未做任何修改。确认无误后加 --apply 执行）');
  db.close();
  process.exit(0);
}

if (!toClear.length) {
  console.log('\n没有需要清空的项，未做修改。');
  db.close();
  process.exit(0);
}

// 备份一份 ai 配置，便于回滚
const backupFile = path.join(ROOT, '.tmp', `ai-setting-backup-${Date.now()}.json`);
fs.mkdirSync(path.dirname(backupFile), { recursive: true });
fs.writeFileSync(backupFile, JSON.stringify(ai, null, 2), 'utf8');

for (const t of toClear) providers[t.name].apiKey = '';
db.prepare("UPDATE setting SET value = ? WHERE key = 'ai'").run(JSON.stringify(ai));
db.close();

console.log(`\n已清空 ${toClear.length} 个服务商在数据库中的明文 Key。`);
console.log(`原 ai 配置已备份到：${backupFile}`);
console.log('请重启邮件查看器使改动生效。');
