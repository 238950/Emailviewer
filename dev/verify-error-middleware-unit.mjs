// BUG-44 对照实验：证明全局错误中间件确实兜住了 async 路由抛出的异常。
// 用法：node dev/verify-error-middleware-unit.mjs
//
// 思路：起两个临时 Express 应用（一模一样，只有一个挂了错误中间件），
// 各注册一条会 throw 的 wrap(async) 路由，然后看客户端拿到什么。
// 注意：这里故意不真去测"进程退出"——那会杀掉测试进程本身；
//      改为断言"无中间件时响应不是结构化 JSON"，这与进程终止是同一个根因。

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// dev/ 目录自身没有 node_modules，express 装在 server/ 下。
// 用 createRequire 从 server 目录解析，避免为 dev 单独装一份依赖。
const here = path.dirname(fileURLToPath(import.meta.url));
const serverRequire = createRequire(path.join(here, '../server/'));
const express = serverRequire('express');

const results = [];
const record = (id, name, pass, detail = '') => {
  results.push({ id, name, pass, detail });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${id} ${name}${detail ? ` — ${detail}` : ''}`);
};

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** 与 api.js 中的实现保持一致的四参错误中间件 */
function errorMiddleware(err, req, res, next) {
  if (res.headersSent) return next(err);
  res.status(500).json({ ok: false, error: `服务器内部错误：${err?.message || '未知错误'}` });
}

function makeApp({ withMiddleware }) {
  const api = express.Router();
  api.post('/boom', wrap(async () => { throw new Error('模拟上游 AI 失败'); }));
  api.post('/safe', wrap(async (req, res) => { res.json({ ok: true }); }));
  if (withMiddleware) api.use(errorMiddleware);
  const app = express();
  app.use('/api', api);
  return app;
}

async function probe(app, path) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const port = server.address().port;
  let out;
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(4000),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON（Express 默认 HTML 错误页） */ }
    out = { status: res.status, isJson: !!json, ok: json?.ok, error: json?.error, ct: res.headers.get('content-type') || '' };
  } catch (e) {
    out = { networkError: e.name };
  }
  server.close();
  return out;
}

/* 1. 有中间件：async throw → 结构化 500 JSON */
{
  const r = await probe(makeApp({ withMiddleware: true }), '/api/boom');
  record('MW-1', '有中间件：async throw 返回结构化 500 JSON',
    r.status === 500 && r.isJson && r.ok === false,
    `HTTP ${r.status}, json=${r.isJson}, error="${r.error || ''}"`);
  record('MW-2', '有中间件：错误文案被包装且保留原因',
    typeof r.error === 'string' && r.error.includes('模拟上游 AI 失败'),
    `error="${r.error || ''}"`);
}

/* 2. 无中间件（修复前状态）：Express 默认处理器 → HTML，非结构化 */
{
  const r = await probe(makeApp({ withMiddleware: false }), '/api/boom');
  const isHtml = /text\/html/.test(r.ct);
  record('MW-3', '无中间件：响应不是结构化 JSON（复现修复前状态）',
    r.isJson !== true,
    `HTTP ${r.status}, contentType=${r.ct || '(none)'}, json=${r.isJson}`);
  record('MW-4', '无中间件：默认处理器返回 HTML 错误页',
    isHtml || r.networkError,
    isHtml ? 'contentType=text/html（Express 默认错误页）' : `networkError=${r.networkError}`);
}

/* 3. 中间件不影响正常路由 */
{
  const r = await probe(makeApp({ withMiddleware: true }), '/api/safe');
  record('MW-5', '有中间件：正常路由不受影响', r.status === 200 && r.ok === true, `HTTP ${r.status}`);
}

/* 4. headersSent 保护：响应已发出时不应二次写入（否则 ERR_HTTP_HEADERS_SENT 崩进程） */
{
  const api = express.Router();
  api.get('/half', (req, res) => { res.write('partial'); res.end(); });
  api.use(errorMiddleware);
  const app = express();
  app.use('/api', api);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const port = server.address().port;
  let survived = false;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/half`, { signal: AbortSignal.timeout(3000) });
    await res.text();
    survived = res.status === 200;
  } catch { survived = false; }
  server.close();
  record('MW-6', '中间件对已发送的响应不二次写入（headersSent 保护）', survived, survived ? '正常结束' : '出现异常');
}

const failed = results.filter((r) => !r.pass);
console.log(`\n=== 结果：${results.length - failed.length}/${results.length} 通过 ===`);
if (failed.length) {
  console.log('未通过：');
  for (const f of failed) console.log(`  - ${f.id} ${f.name}：${f.detail}`);
  process.exitCode = 1;
}
