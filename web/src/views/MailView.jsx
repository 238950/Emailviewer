// 邮箱视图：账户文件夹 | 邮件列表 | 阅读窗格
import React from 'react';
import FolderColumn from '../components/FolderColumn.jsx';
import MailListView from '../components/MailListView.jsx';
import ReaderPane from '../components/ReaderPane.jsx';
import { useStore } from '../store.js';
import { displayName } from '../components/pretty.js';

export default function MailView() {
  const { accountId, folder, accounts, messageId, closeMessage } = useStore();
  const acc = accounts.find((a) => a.id === accountId);
  const title = acc ? `${acc.name} · ${displayName(folder)}` : '统一收件箱';
  return (
    <div className={`mail-layout${messageId ? ' has-reader' : ''}`}>
      <FolderColumn />
      <MailListView
        title={title}
        queryBase={{ accountIds: accountId ? [accountId] : [], folder: accountId ? folder : 'INBOX' }}
      />
      <ReaderPane onBack={closeMessage} />
    </div>
  );
}
