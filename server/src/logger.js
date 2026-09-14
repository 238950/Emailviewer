// 简单日志器：本地文件 + 控制台
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = path.resolve(here, '../data');
export const LOG_FILE = path.join(DATA_DIR, 'server.log');
export const ATTACH_DIR = path.join(DATA_DIR, 'attachments');
export const SAVED_DIR = path.join(DATA_DIR, 'saved');
export const PUBLIC_DIR = path.resolve(here, '../../web/dist');

export function ensureDirs() {
  for (const d of [DATA_DIR, ATTACH_DIR, SAVED_DIR]) fs.mkdirSync(d, { recursive: true });
}

function writeLog(line) {
  try {
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch { /* ignore */ }
}

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

function log(level, scope, ...args) {
  const ts = new Date().toISOString();
  const msg = args.map((a) => (typeof a === 'string' ? a : safeStr(a))).join(' ');
  const line = `[${ts}] [${level.toUpperCase()}] [${scope}] ${msg}`;
  if (LEVELS[level] >= LEVELS.info) console[level === 'debug' ? 'log' : level](line);
  writeLog(line);
}

function safeStr(o) {
  try { return JSON.stringify(o); } catch { return String(o); }
}

export const logger = {
  debug: (s, ...a) => log('debug', s, ...a),
  info: (s, ...a) => log('info', s, ...a),
  warn: (s, ...a) => log('warn', s, ...a),
  error: (s, ...a) => log('error', s, ...a),
};
