// 应用壳：引导、主题、轮询、视图路由
import React, { useEffect } from 'react';
import { useStore, applyTheme } from './store.js';
import TopBar from './components/TopBar.jsx';
import NewAccountModal from './components/NewAccountModal.jsx';
import MailView from './views/MailView.jsx';
import SmartView from './views/SmartView.jsx';
import AttachmentsView from './views/AttachmentsView.jsx';
import CalendarView from './views/CalendarView.jsx';
import SettingsView from './views/SettingsView.jsx';
import ChatView from './views/ChatView.jsx';
import HomeView from './views/HomeView.jsx';
import { Spinner } from './components/common.jsx';
import { api } from './api.js';

export default function App() {
  const { ready, bootError, view, theme, bootstrap, refreshStatus, setView } = useStore();

  useEffect(() => { applyTheme(theme); }, [theme]);

  // 深链：#view=mail|smart|…[&msg=123]（便于直接打开某视图/某封邮件）
  useEffect(() => {
    const apply = () => {
      const st = useStore.getState();
      const p = new URLSearchParams(location.hash.replace(/^#/, ''));
      const v = p.get('view');
      if (v && ['home', 'mail', 'smart', 'attach', 'calendar', 'settings', 'chat'].includes(v)) st.setView(v);
      const msg = Number(p.get('msg'));
      if (msg && st.messageId !== msg) st.selectMessage(msg);
    };
    apply();
    window.addEventListener('hashchange', apply);
    return () => window.removeEventListener('hashchange', apply);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    bootstrap();
    // 每 10 秒轮询状态（未读数/同步状态），内容无变化时不会触发重渲染
    const t1 = setInterval(() => refreshStatus(true), 10000);
    return () => { clearInterval(t1); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 引导失败必须给出明确原因和重试入口。
  // 用户看到的是"没有账户"的界面，容易误判为数据丢失。
  if (bootError) {
    return (
      <div className="boot-screen">
        <div className="boot-logo">✉</div>
        <div className="boot-title">无法连接本地服务</div>
        <div className="boot-error">{bootError}</div>
        <div className="dim">请确认邮件查看器的本地服务已启动后重试；刚开机时服务可能仍在启动中。</div>
        <button className="btn primary" onClick={() => bootstrap()}>重试</button>
      </div>
    );
  }

  if (!ready) {
    return (
      <div className="boot-screen">
        <div className="boot-logo">✉</div>
        <div className="boot-title">学生邮件查看器</div>
        <Spinner size={20} />
        <div className="dim">正在连接本地服务…</div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <TopBar />
      <main className="app-main">
        {view === 'home' && <HomeView />}
        {view === 'mail' && <MailView />}
        {view === 'smart' && <SmartView />}
        {view === 'attach' && <AttachmentsView />}
        {view === 'calendar' && <CalendarView />}
        {view === 'settings' && <SettingsView />}
        {view === 'chat' && <ChatView />}
      </main>
      <NewAccountModal />
    </div>
  );
}
