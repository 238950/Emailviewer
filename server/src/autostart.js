// 开机自启管理（Windows）：写入 HKCU\...\Run 指向 EmailViewer.exe silent（无窗口启动服务）
import path from 'node:path';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { logger } from './logger.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(here, '../..');
export const EXE_PATH = path.join(PROJECT_ROOT, 'EmailViewer.exe');
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const VALUE_NAME = 'StudentMailViewer';

const supported = process.platform === 'win32';

/** 启动命令：统一使用 EmailViewer.exe silent（无 .bat / .vbs） */
export function launcherCommand() {
  if (fs.existsSync(EXE_PATH)) return `"${EXE_PATH}" silent`;
  return '';
}

function reg(args) {
  return new Promise((resolve) => {
    execFile('reg.exe', args, { windowsHide: true }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err?.code ?? 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

const PS = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

/**
 * reg.exe 的 stdout 走控制台代码页（GBK），Node 按 UTF-8 解码会让中文路径变乱码。
 * 改用 PowerShell 读注册表并显式输出 UTF-8，保证界面显示与实际注册值一致。
 */
function readRunValueViaPowerShell() {
  return new Promise((resolve) => {
    if (!fs.existsSync(PS)) return resolve({ ok: false });
    const script = [
      '$ErrorActionPreference="SilentlyContinue"',
      `$p = Get-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name '${VALUE_NAME}'`,
      `if ($p) { [Console]::OutputEncoding=[Text.Encoding]::UTF8; $p.${VALUE_NAME} }`,
    ].join('; ');
    execFile(PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, encoding: 'utf8' }, (err, stdout) => {
        resolve(err ? { ok: false } : { ok: true, value: String(stdout || '').trim() });
      });
  });
}

/** 读取当前是否已注册开机自启 */
export async function autoStartInstalled() {
  if (!supported) return false;
  const ps = await readRunValueViaPowerShell();
  if (ps.ok && ps.value) return true;
  if (ps.ok) return false;
  const r = await reg(['query', RUN_KEY, '/v', VALUE_NAME]);
  return r.ok && r.stdout.includes(VALUE_NAME);
}

/** 当前注册的命令行（便于诊断，不敏感） */
export async function autoStartCommand() {
  if (!supported) return '';
  const ps = await readRunValueViaPowerShell();
  if (ps.ok && ps.value) return ps.value;
  const r = await reg(['query', RUN_KEY, '/v', VALUE_NAME]);
  if (!r.ok) return '';
  const m = r.stdout.match(/REG_SZ\s+(.+)\s*$/m);
  return m ? m[1].trim() : '';
}

/** 启用开机自启（写注册表，指向 EmailViewer.exe silent） */
export async function enableAutoStart() {
  if (!supported) return { ok: false, error: '仅支持 Windows' };
  const command = launcherCommand();
  if (!command) return { ok: false, error: '缺少启动器 EmailViewer.exe（请确认它仍在项目根目录）' };
  const r = await reg(['add', RUN_KEY, '/v', VALUE_NAME, '/t', 'REG_SZ', '/d', command, '/f']);
  if (!r.ok) logger.warn('autostart', `写入注册表失败：${r.stderr}`);
  else logger.info('autostart', `已启用开机自启：${command}`);
  return r.ok ? { ok: true, command } : { ok: false, error: r.stderr || 'reg add 失败' };
}

/** 关闭开机自启（删除注册表项） */
export async function disableAutoStart() {
  if (!supported) return { ok: false, error: '仅支持 Windows' };
  const r = await reg(['delete', RUN_KEY, '/v', VALUE_NAME, '/f']);
  // 不存在时 reg 返回非 0，视为已关闭
  logger.info('autostart', r.ok ? '已关闭开机自启' : '开机自启本就未启用');
  return { ok: true };
}

/** 依据设置应用自启状态 */
export async function applyAutoStart(enabled) {
  return enabled ? enableAutoStart() : disableAutoStart();
}

/** 汇总状态（设置值 + 注册表实际值） */
export async function autoStartStatus(settingEnabled) {
  const installed = await autoStartInstalled();
  return {
    supported,
    settingEnabled: !!settingEnabled,
    installed,
    command: installed ? await autoStartCommand() : '',
    exeExists: fs.existsSync(EXE_PATH),
    launcher: fs.existsSync(EXE_PATH) ? 'EmailViewer.exe' : '',
  };
}
