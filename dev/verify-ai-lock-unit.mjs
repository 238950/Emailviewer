// BUG-46 并发锁单元验证（离线，不依赖服务、不产生任何 AI 调用费用）
// 用法：node dev/verify-ai-lock-unit.mjs
//
// 为什么单独写单元测试：
//   HTTP 层面测锁要依赖"两次请求恰好重叠"的时序，而空账户分支在微秒级就返回，
//   并发窗口极难稳定捕捉；直接用真实账户又会打用户付费的 AI 端点。
//   这里直接 import 锁实现，对它做确定性的行为断言。

import { claimAi, releaseAi, aiInFlightSnapshot } from '../server/src/api.js';

const results = [];
const record = (id, name, pass, detail = '') => {
  results.push({ id, name, pass, detail });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${id} ${name}${detail ? ` — ${detail}` : ''}`);
};

/* 1. 首次占位成功 */
{
  const got = claimAi('classify', 'msg-1');
  record('LOCK-1', '首次 claim 成功返回 true', got === true, `返回 ${got}`);
}

/* 2. 同键第二次必须被拒 */
{
  const got = claimAi('classify', 'msg-1');
  record('LOCK-2', '同键重复 claim 返回 false（互斥生效）', got === false, `返回 ${got}`);
}

/* 3. 释放后可再次占用 */
{
  releaseAi('classify', 'msg-1');
  const got = claimAi('classify', 'msg-1');
  record('LOCK-3', 'release 后可重新 claim（无永久占用）', got === true, `返回 ${got}`);
  releaseAi('classify', 'msg-1');
}

/* 4. 不同 kind 的同名 key 互不干扰 */
{
  const a = claimAi('classify', 'msg-2');
  const b = claimAi('summarize', 'msg-2');
  record('LOCK-4', '不同 kind 之间互不影响', a === true && b === true, `classify=${a}, summarize=${b}`);
  releaseAi('classify', 'msg-2');
  releaseAi('summarize', 'msg-2');
}

/* 5. 不同 key 互不干扰（并行处理多封邮件是允许的） */
{
  const a = claimAi('classify', 'msg-A');
  const b = claimAi('classify', 'msg-B');
  const c = claimAi('classify', 'msg-C');
  record('LOCK-5', '不同邮件可并行分类（锁粒度是 messageId 而非全局）',
    a && b && c, `A=${a}, B=${b}, C=${c}`);
  releaseAi('classify', 'msg-A');
  releaseAi('classify', 'msg-B');
  releaseAi('classify', 'msg-C');
}

/* 6. 快照内容准确 */
{
  claimAi('classify', 'snap-1');
  claimAi('summarize', 'snap-2');
  const snap = aiInFlightSnapshot();
  const keys = snap.map((x) => x.key).sort();
  record('LOCK-6', '快照包含全部在途键且带时间戳',
    keys.length === 2 && keys[0] === 'classify:snap-1' && keys[1] === 'summarize:snap-2'
    && snap.every((x) => Number.isFinite(x.since) && Number.isFinite(x.ms)),
    `keys=[${keys.join(', ')}]`);
  releaseAi('classify', 'snap-1');
  releaseAi('summarize', 'snap-2');
}

/* 7. 全释放后快照为空（模拟 finally 全覆盖的场景） */
{
  const snap = aiInFlightSnapshot();
  record('LOCK-7', '全部释放后快照为空（无锁泄漏）', snap.length === 0, `残留 ${snap.length} 条`);
}

/* 8. 模拟并发：100 次同键争抢，恰好 1 次成功 */
{
  let success = 0;
  const holders = [];
  for (let i = 0; i < 100; i++) {
    if (claimAi('classify', 'race')) { success++; holders.push(i); }
  }
  record('LOCK-8', '100 次同键争抢仅 1 次获得执行权',
    success === 1, `成功 ${success} 次（第 ${holders.join(',')} 次）`);
  releaseAi('classify', 'race');
}

/* 9. 获取-释放循环 200 次仍可正常工作（验证 Map 无累积） */
{
  let okCount = 0;
  for (let i = 0; i < 200; i++) {
    if (claimAi('classify', 'loop')) { okCount++; releaseAi('classify', 'loop'); }
  }
  const residual = aiInFlightSnapshot().length;
  record('LOCK-9', '200 轮获取/释放后无残留（Map 不累积）',
    okCount === 200 && residual === 0, `成功 ${okCount}/200，残留 ${residual}`);
}

const failed = results.filter((r) => !r.pass);
console.log(`\n=== 结果：${results.length - failed.length}/${results.length} 通过 ===`);
if (failed.length) {
  console.log('未通过：');
  for (const f of failed) console.log(`  - ${f.id} ${f.name}：${f.detail}`);
  process.exitCode = 1;
}
