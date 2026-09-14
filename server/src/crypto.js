// 本地口令加密（AES-256-GCM），密钥存于 data/secret.key（仅供防止误泄露）
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './logger.js';

const KEY_FILE = path.join(DATA_DIR, 'secret.key');

let cachedKey = null;

function getKey() {
  if (cachedKey) return cachedKey;
  if (fs.existsSync(KEY_FILE)) {
    cachedKey = fs.readFileSync(KEY_FILE, 'utf8').trim();
  } else {
    cachedKey = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(KEY_FILE, cachedKey, { mode: 0o600 });
  }
  return cachedKey;
}

export function encrypt(plain) {
  if (plain == null || plain === '') return '';
  const key = crypto.createHash('sha256').update(getKey()).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

export function decrypt(token) {
  if (!token) return '';
  try {
    const [v, ivB, tagB, dataB] = String(token).split(':');
    if (v !== 'v1') return token;
    const key = crypto.createHash('sha256').update(getKey()).digest();
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB, 'base64'));
    const dec = Buffer.concat([decipher.update(Buffer.from(dataB, 'base64')), decipher.final()]);
    return dec.toString('utf8');
  } catch {
    return '';
  }
}
