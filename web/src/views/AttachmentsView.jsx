// 附件库：按类型分组 + “杂项（水印/免责声明等）”自动归类，统一预览器
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { FileText, Download, Save, Search, Image as ImageIcon, Trash2, Inbox as InboxIcon, AlertTriangle, Eye, RotateCcw } from 'lucide-react';
import { useStore, ATTACH_GROUPS } from '../store.js';
import { api, attUrl, downloadUrl, downloadAttachment, fmtBytes, fmtDate } from '../api.js';
import { Spinner, Empty, IconBtn } from '../components/common.jsx';
import FileViewer from '../components/FileViewer.jsx';
import { dotColor } from '../components/ReaderPane.jsx';

export default function AttachmentsView() {
  const { accounts, toast, settings } = useStore();
  const [stats, setStats] = useState(null);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [selGroups, setSelGroups] = useState([]);      // 选中类型文件夹（[] = 全部）
  const [showJunk, setShowJunk] = useState(false);      // 在“全部/类型”中是否包含杂项
  const [q, setQ] = useState('');
  const [bigOnly, setBigOnly] = useState(false);
  const [page, setPage] = useState(0);
  const [preview, setPreview] = useState(null);
  const [accountSel, setAccountSel] = useState([]);
  // P2-5：批量下载进度 + 可中止
  const [dl, setDl] = useState(null);          // null | { done, total, failed, cancelled }
  const cancelDlRef = useRef(false);
  // 排序：默认按时间（最新在前），可切换按大小
  const [sortBy, setSortBy] = useState(settings?.attachmentSort === 'size' ? 'size' : 'createdAt');
  const [sortDir, setSortDir] = useState(settings?.attachmentSortDir === 'asc' ? 'asc' : 'desc');

  const accountIds = accountSel.length ? accountSel : accounts.map((a) => a.id);
  const accountKey = accountIds.join(',');

  const changeSort = (value) => {
    if (value === 'size_desc') { setSortBy('size'); setSortDir('desc'); }
    else if (value === 'size_asc') { setSortBy('size'); setSortDir('asc'); }
    else if (value === 'date_asc') { setSortBy('createdAt'); setSortDir('asc'); }
    else { setSortBy('createdAt'); setSortDir('desc'); }
    setPage(0);
    const next = value.startsWith('size') ? { attachmentSort: 'size', attachmentSortDir: value.endsWith('asc') ? 'asc' : 'desc' } : { attachmentSort: 'createdAt', attachmentSortDir: value.endsWith('asc') ? 'asc' : 'desc' };
    api.put('/api/settings', next).then((r) => useStore.setState({ settings: r.settings })).catch(() => {});
  };

  // 统计：类型分组 + 杂项数量
  useEffect(() => {
    api.get(`/api/attachments/groups${accountIds.length ? `?accountId=${encodeURIComponent(accountKey)}` : ''}`)
      .then((r) => setStats({ groups: r.groups, junk: r.junk, clean: r.clean }))
      .catch(() => setStats(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountKey, data?.total]);

  // 列表：默认排除“杂项”（除非勾选显示或专门点开杂项文件夹）
  useEffect(() => {
    setLoading(true);
    const groups = selGroups.length ? selGroups : undefined;
    api.attachments({
      q: q || undefined,
      group: groups,
      includeJunk: showJunk ? 1 : undefined,
      minSize: bigOnly ? 10 * 1048576 : undefined,
      accountId: accountIds.length !== accounts.length ? accountIds : undefined,
      sort: sortBy,
      dir: sortDir,
      page, pageSize: 60,
    }).then((r) => setData(r)).catch((e) => toast(e.message, 'error')).finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, selGroups.join(','), showJunk, bigOnly, page, accountKey, accounts.length, sortBy, sortDir]);

  const junkCount = stats?.junk?.n ?? 0;
  const cleanCount = stats?.clean?.n ?? 0;

  const save = async (att) => {
    try {
      const r = await api.post(`/api/attachments/${att.id}/save`);
      toast(`已保存：${r.savedTo}`, 'success');
    } catch (e) { toast(e.message, 'error'); }
  };

  /**
   * 不再用 window.open('_blank') 留下空白标签页，改为直接触发下载。
   *  返回 true/false 以便批量下载统计失败数（单条下载仍会 toast 具体错误）。
   */
  const download = async (att, silent = false) => {
    try { await downloadAttachment(att.id, att.filename); return true; }
    catch (e) { if (!silent) toast(e.message, 'error'); return false; }
  };

  /**
   * P2-5：批量下载当前页附件（逐个串行，浏览器会按顺序存入下载目录）。
   * 改进点：① 显示 done/total 进度并统计失败数，不再只弹一句"开始下载"；
   *         ② 提供「取消」——中止后已完成的部分保留，不丢已下到的文件。
   */
  const downloadAll = async () => {
    const list = data?.list || [];
    if (!list.length || dl) return;
    cancelDlRef.current = false;
    let failed = 0;
    setDl({ done: 0, total: list.length, failed: 0, cancelled: false });
    for (let i = 0; i < list.length; i++) {
      if (cancelDlRef.current) break;
      // 批量时静默单条 toast，避免几十条错误刷屏；最后统一汇总
      // eslint-disable-next-line no-await-in-loop
      const ok = await download(list[i], true);
      if (!ok) failed++;
      setDl({ done: i + 1, total: list.length, failed, cancelled: false });
    }
    const cancelled = cancelDlRef.current;
    setDl(null);
    cancelDlRef.current = false;
    if (cancelled) toast('已取消批量下载（已下载的文件保留）', 'info');
    else if (failed) toast(`已下载 ${list.length - failed}/${list.length} 个，${failed} 个失败`, 'error');
    else toast(`已下载全部 ${list.length} 个附件`, 'success');
  };

  const cancelDownloadAll = () => { cancelDlRef.current = true; };

  /** 手动把某条附件移出/移入“杂项”，或恢复自动判定 */
  const setJunk = async (att, junk) => {
    try {
      await api.post(`/api/attachments/${att.id}/junk`, { junk });
      toast(junk === null ? '已恢复为自动判定' : (junk ? '已归入杂项' : '已移出杂项，之后会显示在主列表'), 'success');
      setPage((p) => p);
      const r = await api.attachments({
        q: q || undefined, group: selGroups.length ? selGroups : undefined,
        includeJunk: showJunk ? 1 : undefined, minSize: bigOnly ? 10 * 1048576 : undefined,
        accountId: accountIds.length !== accounts.length ? accountIds : undefined,
        sort: sortBy, dir: sortDir, page, pageSize: 60,
      });
      setData(r);
      const st = await api.get(`/api/attachments/groups${accountIds.length ? `?accountId=${encodeURIComponent(accountKey)}` : ''}`);
      setStats({ groups: st.groups, junk: st.junk, clean: st.clean });
    } catch (e) { toast(e.message, 'error'); }
  };

  const toggleGroup = (g) => {
    setSelGroups((s) => {
      if (s.includes(g)) return s.filter((x) => x !== g);
      if (g === 'junk') return ['junk'];
      return [...s.filter((x) => x !== 'junk'), g];
    });
    setPage(0);
  };

  const canPreview = (a) => (a.mime || '').startsWith('image/') || a.mime === 'application/pdf' || /^text\/|json|xml/.test(a.mime || '');

  return (
    <div className="view-page attach-page">
      <div className="page-head">
        <b>附件库</b>
        <span className="dim">全部账户附件自动汇总，按类型分文件夹查看</span>
      </div>

      <div className="attach-tools">
        <div className="attach-groups">
          <button className={`qchip${!selGroups.length && !showJunk ? ' on' : ''}`} onClick={() => { setSelGroups([]); setPage(0); }}>
            全部{cleanCount ? ` ${cleanCount}` : ''}
          </button>
          <button className={`qchip junk-chip${selGroups.includes('junk') ? ' on' : ''}`}
            title="水印 / 免责声明 / 签名小图 / 占位文本等，默认不显示在主列表中"
            onClick={() => toggleGroup('junk')}>
            <Trash2 size={12} /> 杂项水印等{junkCount ? ` ${junkCount}` : ''}
          </button>
          {ATTACH_GROUPS.filter((g) => g.key !== 'other').map((g) => {
            const n = stats?.groups?.[g.key]?.n;
            const isOn = selGroups.includes(g.key);
            return (
              <button key={g.key} className={`qchip${isOn ? ' on' : ''}`}
                onClick={() => toggleGroup(g.key)}>
                {g.label}{n ? ` ${n}` : ''}
              </button>
            );
          })}
          <label className="check-row junk-toggle" title="勾选后，“全部”也会显示水印/免责声明等杂项附件">
            <input type="checkbox" checked={showJunk} onChange={(e) => { setShowJunk(e.target.checked); setPage(0); }} />
            在全部中显示杂项
          </label>
          {dl ? (
            <>
              <span className="dim" style={{ whiteSpace: 'nowrap' }}>
                {dl.done}/{dl.total}{dl.failed ? `（失败 ${dl.failed}）` : ''}
              </span>
              <button className="mini-btn danger" onClick={cancelDownloadAll} title="中止批量下载（已下载的文件会保留）">取消</button>
            </>
          ) : (
            <button className="mini-btn" onClick={downloadAll} disabled={!data?.list?.length}
              title="逐个下载当前页的全部附件（浏览器会依次保存到下载目录）">
              <Download size={12} /> 下载本页全部
            </button>
          )}
        </div>
        <div className="attach-filter">
          <div className="search-wrap">
            <Search size={13} />
            <input className="inp" placeholder="搜索文件名…" value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }} />
          </div>
          <label className="check-row">
            <input type="checkbox" checked={bigOnly} onChange={(e) => { setBigOnly(e.target.checked); setPage(0); }} />
            仅看大附件（&gt;10MB）
          </label>
          <label className="check-row sort-row">
            排序：
            <select className="sel" value={`${sortBy === 'size' ? 'size' : 'date'}_${sortDir}`} onChange={(e) => changeSort(e.target.value)}>
              <option value="date_desc">时间（最新在前）</option>
              <option value="date_asc">时间（最早在前）</option>
              <option value="size_desc">大小（从大到小）</option>
              <option value="size_asc">大小（从小到大）</option>
            </select>
          </label>
        </div>
      </div>

      <div className="attach-stats dim">
        当前显示 {data?.total ?? 0} 个附件
        {junkCount > 0 && !showJunk && !selGroups.includes('junk') && (
          <span className="warn-inline">
            <AlertTriangle size={11} /> 另有 {junkCount} 个“杂项（水印/免责声明等）”已自动归入上方文件夹，默认不显示
          </span>
        )}
      </div>

      {loading ? (
        <div className="list-loading"><Spinner /> 加载中…</div>
      ) : !data || !data.list.length ? (
        <Empty icon={<InboxIcon size={30} />} text={selGroups.includes('junk') ? '杂项文件夹是空的' : '暂无附件'} sub="打开包含附件的邮件后会自动出现在这里（正文已抓取的部分）" />
      ) : (
        <div className="att-grid">
          {data.list.map((a) => {
            const isImg = (a.mime || '').startsWith('image/');
            return (
              <div className={`att-card${a.junk ? ' junk-card' : ''}`} key={a.id}>
                <div className="att-card-icon">
                  {isImg ? <img src={attUrl(a.id)} alt="" loading="lazy" onClick={() => canPreview(a) && setPreview(a)} /> : <FileText size={18} />}
                </div>
                <div className="att-card-main">
                  <div className="att-card-name" title={a.filename}>
                    {a.filename}
                    {a.junk && <span className="junk-tag" title={a.junkReason || '杂项'}>杂项</span>}
                  </div>
                  <div className="att-card-meta dim">{fmtBytes(a.size)}{a.junkReason ? ` · ${a.junkReason}` : ''}</div>
                  <div className="att-card-src dim" title={a.subject}>
                    <span className="sender-avatar sm" style={{ background: dotColor({ accountId: a.accountId, fromAddr: a.fromAddr }, accounts) }}>{(a.fromName || a.fromAddr || '?').charAt(0)}</span>
                    {a.fromName || a.fromAddr} · {fmtDate(a.dateMs)}
                  </div>
                </div>
                <div className="att-card-actions">
                  {canPreview(a) && <IconBtn title="在线预览（图片/PDF/文本）" onClick={() => setPreview(a)}><Eye size={13} /></IconBtn>}
                  <IconBtn title="下载" onClick={() => download(a)}><Download size={13} /></IconBtn>
                  <IconBtn title="保存到本地文件夹" onClick={() => save(a)}><Save size={13} /></IconBtn>
                  {a.junk
                    ? <IconBtn title={a.junkOverridden ? '恢复为自动判定' : '这条其实不是杂项：移出主列表隐藏，改成正常附件'} onClick={() => setJunk(a, a.junkOverridden ? null : false)}><RotateCcw size={13} /></IconBtn>
                    : <IconBtn title="归入杂项（不再显示在主列表）" onClick={() => setJunk(a, true)}><Trash2 size={13} /></IconBtn>}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {data && data.total > 0 && (
        <div className="list-pager">
          <button className="mini-btn" disabled={page === 0} onClick={() => setPage(page - 1)}>上一页</button>
          <span>第 {page + 1} / {Math.ceil(data.total / data.pageSize)} 页</span>
          <button className="mini-btn" disabled={(page + 1) * data.pageSize >= data.total} onClick={() => setPage(page + 1)}>下一页</button>
        </div>
      )}
      {preview && <FileViewer att={preview} onClose={() => setPreview(null)} />}
    </div>
  );
}
