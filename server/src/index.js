// 邮件查看器本地服务入口：REST API + 托管前端静态资源
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import express from 'express';
import { api } from './api.js';
import { startServices } from './services.js';
import { logger, ensureDirs, PUBLIC_DIR, DATA_DIR } from './logger.js';
import { getSettings } from './settings.js';

ensureDirs();

const app = express();
app.disable('x-powered-by');
app.use('/api', api);

// 托管前端构建产物（web/dist）
if (fs.existsSync(PUBLIC_DIR)) {
  app.use(express.static(PUBLIC_DIR, { index: 'index.html', maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0 }));
  app.get(/^(?!\/api\/).*/, (req, res) => {
    const p = path.join(PUBLIC_DIR, req.path);
    if (fs.existsSync(p) && fs.statSync(p).isFile()) return;
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  });
}

// 健康路由
app.get('/', (req, res) => {
  res.type('text/plain; charset=utf-8');
  if (fs.existsSync(path.join(PUBLIC_DIR, 'index.html'))) {
    res.redirect('/index.html');
  } else {
    res.send('邮件查看器前端尚未构建：请在 web 目录执行 npm run build');
  }
});

const settings = getSettings();
// 注意：不使用通用的 PORT 环境变量（可能被宿主环境占用），使用专属 MAILVIEW_PORT
const PORT = Number(process.env.MAILVIEW_PORT || settings.port || 3869);
const HOST = process.env.HOST || '127.0.0.1';

const server = http.createServer(app);
server.listen(PORT, HOST, () => {
  logger.info('main', `邮件查看器已启动： http://${HOST}:${PORT}   (数据目录: ${DATA_DIR})`);
  console.log('\n  ✉  学生邮件查看器已启动');
  console.log(`  ➜  请在浏览器打开： http://${HOST}:${PORT}\n`);
  if (process.env.OPEN_BROWSER === '1') {
    setTimeout(() => {
      try { execFile('cmd.exe', ['/c', 'start', '', `http://${HOST}:${PORT}`]); } catch { /* 忽略 */ }
    }, 600);
  }
});
server.on('error', (e) => {
  logger.error('main', `端口 ${PORT} 启动失败：${e.message}`);
  if (e.code === 'EADDRINUSE') {
    console.error(`\n  ✗ 端口 ${PORT} 已被占用。可先关闭占用程序，或设置环境变量 PORT=其它端口再启动。\n`);
  }
  process.exit(1);
});

startServices();
