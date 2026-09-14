// Outlook 桌面数据源桥接：通过 COM 自动化读取本机 Outlook 已同步的邮件
// （只读 + 已读/星标写回；不做发送）。依赖：本机安装并登录过 Outlook 桌面客户端。
// 实现：把参数化的 PowerShell 脚本写入 data/ps，用 powershell.exe 执行，输出 JSONL。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { logger, DATA_DIR } from './logger.js';
import { AccountStore, FolderStore, MessageStore, run } from './store.js';
import { getSettings } from './settings.js';
import { addrText, mimeGroup, now, isDraftFolderName } from './util.js';

const PS_DIR = path.join(DATA_DIR, 'ps');
const TMP_DIR = path.join(DATA_DIR, 'ps', 'tmp');
const PS_EXE = process.env.POWERSHELL_EXE || 'powershell.exe';
const FOLDER_CAP_PER_RUN = 1200;

export function ensurePsDirs() {
  fs.mkdirSync(PS_DIR, { recursive: true });
  fs.mkdirSync(TMP_DIR, { recursive: true });
}

/* ---------- 低层执行（高优先级插队：打开邮件/写回状态优先于后台预取/同步） ---------- */
const psJobs = { high: [], low: [] };
let runningPs = false;
let activePid = null;
export function psBusy() { return activePid != null; }

function pumpPs() {
  if (runningPs) return;
  const job = psJobs.high.shift() || psJobs.low.shift();
  if (!job) return;
  runningPs = true;
  job.run().catch(() => {}).finally(() => {
    runningPs = false;
    pumpPs();
  });
}

async function runPsScript(body, timeoutMs = 200000, opts = {}) {
  ensurePsDirs();
  const file = path.join(PS_DIR, `${Date.now()}-${Math.floor(Math.random() * 1e6)}.ps1`);
  fs.writeFileSync(file, '\uFEFF' + body, 'utf8'); // BOM 保证 PS5 按 UTF-8 解析
  const exec = () => new Promise((resolve, reject) => {
    const child = spawn(PS_EXE, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    activePid = child.pid;
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    child.stderr.on('data', (d) => { err += d.toString('utf8'); });
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* */ }
      reject(new Error('Outlook COM 操作超时（请确认 Outlook 已启动且没有阻塞的弹窗）'));
    }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); reject(new Error(`无法启动 PowerShell：${e.message}`)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      activePid = null;
      if (code !== 0) {
        const tail = err.trim().split('\n').slice(-4).join(' | ');
        reject(new Error(tail || `PowerShell 退出码 ${code}`));
      } else resolve(out);
    });
  });
  const promise = new Promise((resolve, reject) => {
    psJobs[opts.high ? 'high' : 'low'].push({ run: () => exec().then(resolve, reject) });
    pumpPs();
  });
  try { return await promise; } finally { try { fs.unlinkSync(file); } catch { /* */ } }
}

function parseJsonLines(out) {
  return out.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('JSON>>'))
    .map((l) => { try { return JSON.parse(l.slice(6)); } catch { return null; } }).filter(Boolean);
}

const esc = (s) => String(s ?? '').replace(/'/g, "''");
const extToMime = (ext) => ({
  '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
  '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.txt': 'text/plain', '.csv': 'text/csv', '.ics': 'text/calendar',
  '.zip': 'application/zip', '.rar': 'application/x-rar-compressed', '.7z': 'application/x-7z-compressed',
  '.json': 'application/json', '.xml': 'application/xml',
}[ext] || 'application/octet-stream');

const HEAD = `$ErrorActionPreference='Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$__wasRunning = ([System.Diagnostics.Process]::GetProcessesByName('OUTLOOK')).Count -gt 0
function Get-Ol { return ,(New-Object -ComObject Outlook.Application) }
`;
const FOOT = `} finally { if(-not $__wasRunning){ try { $ol.Quit() } catch {} } }`;

/** 按 SmtpAddress / DisplayName 定位 Outlook.Account */
function resolver(email, name) {
  return `$__target=$null
foreach($__a in $ol.Session.Accounts){
  if($__a.SmtpAddress -ieq '${esc(email)}' -or $__a.DisplayName -ieq '${esc(name)}'){ $__target=$__a; break }
}
if(-not $__target){ throw ('Outlook 中找不到账号: ' + '${esc(name || email)}。请先在 Outlook 客户端中添加该邮箱并完成首次同步') }
$__store = $__target.DeliveryStore
`;
}

/* ============ 1) 可用性 + 账号清单（会短暂拉起 Outlook，成功后自动退出） ============ */
export async function outlookAccounts() {
  const script = `${HEAD}
try {
  $ol = Get-Ol
  $ns = $ol.GetNamespace('MAPI')
  $list = @()
  foreach($__a in $ns.Accounts){
    $list += [pscustomobject]@{ displayName=[string]$__a.DisplayName; smtp=[string]$__a.SmtpAddress; userName=[string]$__a.UserName }
  }
  $out = @{ ok=$true; running=$false; defaultEmail=''; accounts=@($list) }
  if($list.Count -eq 0){
    $def = $ns.GetDefaultFolder(6)
    $out.accounts = @([pscustomobject]@{ displayName=[string]$def.Store.DisplayName; smtp=''; userName='' })
  }
  Write-Output ('JSON>>' + ($out | ConvertTo-Json -Compress -Depth 6))
${FOOT}
`;
  try {
    const out = await runPsScript(script, 240000);
    return parseJsonLines(out)[0] || { ok: false, accounts: [] };
  } catch (e) {
    return { ok: false, error: e.message, accounts: [] };
  }
}

/* ============ 2) 某账号的文件夹清单（含 EntryID/StoreID） ============ */
export async function outlookFolders(email, name) {
  const script = `${HEAD}
try {
  $ol = Get-Ol
  $ns = $ol.GetNamespace('MAPI')
${resolver(email, name)}
  $arr = New-Object System.Collections.ArrayList
  function Walk-Folder($__f, $__depth){
    if($__depth -gt 4){ return }
    try {
      [void]$arr.Add([pscustomobject]@{
        name=[string]$__f.Name
        path=[string]$__f.FolderPath
        entryId=[string]$__f.EntryID
        storeId=[string]$__f.StoreID
        itemCount=[int]0
      })
      foreach($__sf in $__f.Folders){ Walk-Folder $__sf ($__depth + 1) }
    } catch {}
  }
  Walk-Folder $__store.GetRootFolder() 0
  $out = @{ ok=$true; storeId=[string]$__store.EntryID; folders=@($arr.ToArray()) }
  Write-Output ('JSON>>' + ($out | ConvertTo-Json -Compress -Depth 8))
${FOOT}
`;
  const out = await runPsScript(script, 220000);
  return parseJsonLines(out)[0] || { ok: false, folders: [] };
}

/* ============ 3) 增量信封同步 ============ */
/** 返回信封数组（不含正文与附件内容） */
export async function outlookEnvelopes(account, folderRow, sinceMs) {
  const fl = (folderRow.flags && typeof folderRow.flags === 'object' ? folderRow.flags : {}) || {};
  if (!fl.entryId) throw new Error('文件夹缺少 Outlook EntryID（请重新同步该账户）');
  const since = new Date(sinceMs).toISOString();
  const script = `${HEAD}
try {
  $ol = Get-Ol
  $ns = $ol.GetNamespace('MAPI')
${resolver(account.email, account.name)}
  $__folder = $null
  if('${esc(fl.storeId || '')}'){ $__folder = $ns.GetFolderFromID('${esc(fl.entryId)}', '${esc(fl.storeId)}') }
  else { $__folder = $ns.GetFolderFromID('${esc(fl.entryId)}') }
  $__items = $__folder.Items
  try { $__items.Sort('[ReceivedTime]', $true) } catch {}
  $__sinceD = [datetime]::Parse('${since}')
  $__total = $__items.Count
  $__emit = 0
  for($i=1; $i -le $__total; $i++){
    $__it = $__items.Item($i)
    if($__it.Class -ne 43){ continue }
    try { if($__it.ReceivedTime -lt $__sinceD){ break } } catch {}
    $__att = @()
    try {
      foreach($__a in $__it.Attachments){
        $__sz = 0L
        try { $__sz = [long]$__a.Size } catch {}
        $__att += [pscustomobject]@{ name=[string]$__a.FileName; size=$__sz }
      }
    } catch {}
    $o = [pscustomobject]@{
      entryId=[string]$__it.EntryID
      subject=[string]$__it.Subject
      fromName=[string]$__it.SenderName
      fromAddr=[string]$__it.SenderEmailAddress
      dateMs=[long]([DateTimeOffset]$__it.ReceivedTime.ToUniversalTime()).ToUnixTimeMilliseconds()
      size=[long]$__it.Size
      unread=[bool]$__it.UnRead
      important=($__it.FlagStatus -eq 1)
      categories=[string]$__it.Categories
      atts=@($__att)
    }
    Write-Output ('JSON>>' + ($o | ConvertTo-Json -Compress -Depth 5))
    $__emit++
    if($__emit -ge ${FOLDER_CAP_PER_RUN}){ break }
  }
${FOOT}
`;
  const out = await runPsScript(script, 240000);
  return parseJsonLines(out);
}

/* ============ 4) 单封正文 + 附件内容 ============ */
export async function outlookMessageParts(account, entryId) {
  const tmp = fs.mkdtempSync(path.join(TMP_DIR, 'att-'));
  try {
    const script = `${HEAD}
try {
  $ol = Get-Ol
  $ns = $ol.GetNamespace('MAPI')
  $__it = $ns.GetItemFromID('${esc(entryId)}')
  if($__it.Class -ne 43){ throw '该 EntryID 不是邮件项' }
  $__saved = @()
  $__i = 0
  foreach($__a in $__it.Attachments){
    $__i++
    $__fn = ($__i.ToString() + '_' + [System.IO.Path]::GetFileName([string]$__a.FileName))
    try { $__a.SaveAsFile((Join-Path '${esc(tmp)}' $__fn)) } catch { continue }
    # BUG-04 修复：读取内嵌图片的 Content-ID（PR_ATTACH_CONTENT_ID = 0x3712001E），
    # 否则正文里的 src="cid:xxx" 无法与附件对应，会显示裂图。
    $__cid = ''
    try { $__cid = [string]$__a.PropertyAccessor.GetProperty('http://schemas.microsoft.com/mapi/proptag/0x3712001E') } catch { $__cid = '' }
    $__saved += [pscustomobject]@{ name=[string]$__a.FileName; file=$__fn; cid=$__cid }
  }
  $out = [pscustomobject]@{
    ok=$true
    subject=[string]$__it.Subject
    text=[string]$__it.Body
    html=[string]$__it.HTMLBody
    atts=@($__saved)
  }
  Write-Output ('JSON>>' + ($out | ConvertTo-Json -Compress -Depth 6))
${FOOT}
`;
    const out = await runPsScript(script, 220000, { high: true });
    const row = parseJsonLines(out)[0];
    if (!row || !row.ok) throw new Error('Outlook 未返回邮件正文');
    const attachments = (row.atts || []).map((a) => {
      const safe = String(a.file).replace(/[\\/:*?"<>|]/g, '_');
      const file = path.join(tmp, safe);
      if (!fs.existsSync(file)) return null;
      const mime = extToMime(path.extname(a.name || '').toLowerCase());
      const cid = String(a.cid || '').trim().replace(/^<|>$/g, '');
      // 有 Content-ID 说明是正文内嵌图片（inline），无则是普通附件
      return {
        filename: a.name, contentType: mime, size: fs.statSync(file).size,
        content: fs.readFileSync(file),
        disposition: cid ? 'inline' : 'attachment',
        contentId: cid,
      };
    }).filter(Boolean);
    return { text: row.text || '', html: row.html || '', headers: {}, attachments };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
  }
}

/* ============ 5) 已读/星标写回 ============ */
export async function outlookSetFlags(account, entryId, { read, important }) {
  const script = `${HEAD}
try {
  $ol = Get-Ol
  $ns = $ol.GetNamespace('MAPI')
  $__it = $ns.GetItemFromID('${esc(entryId)}')
  if($__it.Class -ne 43){ throw '该 EntryID 不是邮件项' }
  ${read !== undefined ? `try { $__it.UnRead = ${read ? '$false' : '$true'}; $__it.Save() } catch { throw ('已读状态写入失败: ' + $_.Exception.Message) }` : ''}
  ${important !== undefined ? `try { $__it.FlagStatus = ${important ? '1' : '0'}; $__it.Save() } catch { throw ('星标写入失败: ' + $_.Exception.Message) }` : ''}
  Write-Output 'JSON>>{"ok":true}'
${FOOT}
`;
  await runPsScript(script, 120000, { high: true });
}

/* ============ 工具 ============ */
export function entryIdToUid(entryId) {
  let c = 0xffffffff;
  const buf = Buffer.from(String(entryId || ''));
  for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
  return (c ^ 0xffffffff) >>> 0;
}

export function guessAttMeta(atts) {
  return (atts || []).map((a) => {
    const mime = extToMime(path.extname(a.name || '').toLowerCase());
    return { filename: a.name, mime, size: a.size || 0, group: mimeGroup(mime), disposition: 'attachment' };
  });
}

/* ============ 6) Outlook 账户同步入库（信封 → message 表） ============ */
/** 系统级“非邮件”文件夹（跳过它们，避免目录噪音与无谓轮询）。中英文常见名。 */
const SYSTEM_TOP = new Set([
  'conversation action settings', 'externalcontacts', 'rss 源', 'rss feeds', 'yammer 根目录', 'yammer root',
  '任务', 'tasks', '便笺', 'notes', '发件箱', 'outbox', '同步问题', 'sync issues',
  '快速步骤设置', 'quick step settings', '文件', 'files', '日历', 'calendar',
  '日记', 'journal', '联系人', 'contacts', 'people', '对话历史记录', 'conversation history',
  '小组聊天', 'team chat', 'feeds', 'inbound', 'outbound', 'suggested contacts', 'voice mail',
  'social activity', 'to do', '待办', 'search folders', '搜索结果',
]);

/** 判断 Outlook FolderPath 是否为系统/非邮件文件夹（跳过）。路径形如 \accountRoot\顶层\子层… */
export function isSystemFolderPath(fpath) {
  const segs = String(fpath || '').split('\\').map((s) => s.trim()).filter(Boolean);
  if (segs.length <= 1) return true; // 账户根本身
  if (SYSTEM_TOP.has(segs[1].toLowerCase())) return true;
  for (const s of segs.slice(1)) {
    const low = s.toLowerCase();
    if (low.includes('sync issues') || low.includes('同步问题')) return true;
    if (low === 'outbox' || low === '发件箱') return true;
  }
  return false;
}

export async function syncOutlookAccount(account) {
  ensurePsDirs();
  const s = getSettings();
  const summary = { folders: 0, newMessages: 0, errors: [] };

  // a) 发现文件夹（过滤系统目录）
  const disc = await outlookFolders(account.email, account.name);
  if (!disc.ok) throw new Error('无法读取 Outlook 文件夹：' + (disc.error || '未知错误'));
  const existing = FolderStore.list(account.id);
  const existingSet = new Set(existing.map((f) => f.name));
  const keep = new Set();
  for (const f of (disc.folders || [])) {
    // 名称取路径，保证唯一（显示层再美化）
    const fname = String(f.path || f.name || '');
    if (!fname || isSystemFolderPath(fname)) continue;
    if (!s.showDrafts && isDraftFolderName(fname)) continue; // 草稿箱默认不同步（设置可开）
    keep.add(fname);
    if (existingSet.has(fname)) continue; // 已有文件夹保留其同步断点
    existingSet.add(fname);
    FolderStore.upsert({
      accountId: account.id, name: fname, delim: '\\', flags: { outlook: true, entryId: f.entryId, storeId: f.storeId },
      subscribed: 1, total: 0, unread: 0, syncedAt: 0,
    });
  }
  // 清理本地已消失/已不再同步的空目录（仍含邮件的行保留）
  for (const ex of existing) {
    if (!keep.has(ex.name) && (ex.total || 0) === 0) {
      run('DELETE FROM folder WHERE account_id=? AND name=?', [account.id, ex.name]);
    }
  }
  summary.folders = (disc.folders || []).filter((f) => !isSystemFolderPath(String(f.path || f.name || ''))).length;

  // b) 逐文件夹增量同步信封
  const cutoffFallback = Date.now() - (Number(s.initialSyncDays) || 30) * 86400000;
  for (const f of FolderStore.list(account.id)) {
    try {
      const flags = (f.flags && typeof f.flags === 'object') ? f.flags : {};
      if (!flags.entryId) continue;
      const prevCutoff = typeof flags.cutoff === 'number' ? flags.cutoff : 0;
      const since = prevCutoff ? prevCutoff - 3600 * 1000 : cutoffFallback;
      const envs = await outlookEnvelopes(account, f, since);
      let inserted = 0;
      let oldest = since;
      for (const ev of envs) {
        const uid = entryIdToUid(ev.entryId);
        const flagsArr = ev.unread ? [] : ['\\Seen'];
        const labels = String(ev.categories || '').split(/[,;，;]/).map((x) => x.trim()).filter(Boolean).slice(0, 8);
        const rec = MessageStore.insertEnvelope({
          accountId: account.id, folder: f.name, uid,
          msgId: ev.entryId, subject: (ev.subject || '').slice(0, 1000),
          fromAddr: ev.fromAddr || '', fromName: ev.fromName || '',
          toList: [], ccList: [],
          dateMs: ev.dateMs || Date.now(), receivedMs: ev.dateMs || Date.now(),
          size: ev.size || 0, flags: flagsArr,
          read: !ev.unread, important: !!ev.important,
          hasAttachments: (ev.atts || []).length > 0,
          attMeta: guessAttMeta(ev.atts),
          labels,
        });
        if (rec.inserted) inserted++;
        // 状态同步：若 Outlook 侧已读/星标变化（含外部修改），回写本地
        const cur = rec.msg || MessageStore.byUid(account.id, f.name, uid);
        if (cur && (cur.read !== !ev.unread || cur.important !== !!ev.important)) {
          MessageStore.update(cur.id, { read: !ev.unread, important: !!ev.important, categoryReason: cur.categoryReason });
        }
        if (ev.dateMs < oldest) oldest = ev.dateMs;
      }
      summary.newMessages += inserted;
      // 断点续传标记：若因单次上限中断则从“最旧已处理”处继续，否则推进到当前
      const complete = envs.length < FOLDER_CAP_PER_RUN;
      const newCutoff = complete ? Date.now() : oldest;
      const un = MessageStore.unreadByFolder(account.id).find((r) => r.folder === f.name);
      const localTotal = MessageStore.query({ accountIds: [account.id], folder: f.name, pageSize: 1 }).total;
      FolderStore.upsert({
        accountId: account.id, name: f.name, delim: '\\',
        flags: { ...flags, cutoff: newCutoff },
        subscribed: 1, total: localTotal, unread: un ? un.unread : 0, syncedAt: Date.now(),
      });
      logger.info('outlook', `同步 ${account.name} / ${f.name}：信封 ${envs.length}，新增 ${inserted}`);
    } catch (e) {
      logger.warn('outlook', `文件夹 ${f.name} 同步失败：${e.message}`);
      summary.errors.push(`${f.name}: ${e.message}`);
    }
  }
  AccountStore.update(account.id, { lastSyncAt: now(), syncState: summary, syncError: summary.errors.length ? summary.errors.join('; ') : '' });
  return summary;
}

export { addrText };
