// MIME 分组一致性验证：util.js 与 store.js 两套判定必须完全一致
// 用法：node dev/verify-mime-group.mjs
import { mimeGroup, MIME_GROUP } from '../server/src/util.js';
import { mimeGroupName } from '../server/src/store.js';

const cases = [
  'application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/avif',
  'application/zip', 'application/x-rar-compressed', 'text/calendar', 'application/ics',
  'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/csv', 'text/tab-separated-values', 'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint', 'text/rtf', 'application/rtf',
  'text/html', 'text/css', 'text/plain', 'application/json', 'application/xml',
  'text/javascript', 'application/x-sh', 'application/x-httpd-php',
  'audio/mpeg', 'video/mp4', 'application/octet-stream', '', null, undefined,
];

let mismatch = 0;
console.log('mime'.padEnd(72), 'util'.padEnd(10), 'store'.padEnd(10), '一致');
for (const m of cases) {
  const a = mimeGroup(m);
  const b = mimeGroupName(m);
  const same = a === b;
  if (!same) mismatch++;
  console.log(String(m).padEnd(72), String(a).padEnd(10), String(b).padEnd(10), same ? 'OK' : 'FAIL');
}

console.log('\n--- 断言 ---');
console.log('两套实现不一致数量：', mismatch, mismatch === 0 ? 'PASS' : 'FAIL');
const hasCode = 'code' in MIME_GROUP;
console.log("MIME_GROUP 是否仍含 'code' 组：", hasCode, hasCode ? 'FAIL' : 'PASS');
const htmlOk = mimeGroup('text/html') === 'text';
console.log('text/html 归入 text 组（而非 code）：', htmlOk, htmlOk ? 'PASS' : 'FAIL');
console.log('分组键：', Object.keys(MIME_GROUP).join(', '));

process.exit(mismatch === 0 && !hasCode && htmlOk ? 0 : 1);
