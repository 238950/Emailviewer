// 统一文件预览器：图片 / PDF / 文本 / JSON / CSV 等在线查看，其余提示下载
import React, { useEffect, useState } from 'react';
import { FileText, Download, Maximize2 } from 'lucide-react';
import { Modal } from './common.jsx';
import { attUrl, downloadUrl } from '../api.js';

const TEXT_RE = /^text\/|application\/json|application\/xml|application\/javascript|application\/x-httpd-php/;

export default function FileViewer({ att, onClose }) {
  const [text, setText] = useState(null);
  const [err, setErr] = useState('');
  const [pdfFailed, setPdfFailed] = useState(false);
  const mime = String(att.mime || '');
  const isImg = mime.startsWith('image/');
  const isPdf = mime === 'application/pdf';
  const isText = TEXT_RE.test(mime);
  const tooBigForPreview = isImg && att.size > 20 * 1048576;

  // P2-4：文本预览加超时——大附件读取卡住时不再无限"读取中…"
  useEffect(() => {
    if (!isText) return;
    let dead = false;
    setText(null); setErr('');
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 20000);
    fetch(attUrl(att.id), { signal: ctl.signal })
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((t) => { if (!dead) setText(t.length > 260000 ? t.slice(0, 260000) + '\n…（内容过长已截断，请下载查看全文）' : t); })
      .catch((e) => {
        if (dead) return;
        setErr(e.name === 'AbortError' ? '读取超时（20 秒），文件可能过大，请下载后查看' : `读取失败：${e.message}`);
      })
      .finally(() => clearTimeout(timer));
    return () => { dead = true; clearTimeout(timer); ctl.abort(); };
  }, [att.id, isText]);

  // P2-4：PDF 内嵌预览失败时（浏览器/内核不支持或文件损坏）给出明确兜底，而不是空白框
  useEffect(() => {
    if (!isPdf) return;
    let dead = false;
    const ctl = new AbortController();
    fetch(attUrl(att.id), { method: 'HEAD', signal: ctl.signal })
      .then((r) => { if (!dead && !r.ok) setPdfFailed(true); })
      .catch(() => { if (!dead) setPdfFailed(true); });
    return () => { dead = true; ctl.abort(); };
  }, [att.id, isPdf]);

  return (
    <Modal title={`预览：${att.filename}`} onClose={onClose} wide footer={(
      <div className="modal-actions">
        <span className="dim">{att.mime}</span>
        <a className="btn ghost" href={downloadUrl(att.id)} download title="下载原文件"><Download size={13} /> 下载</a>
        <button className="btn primary" onClick={onClose}>关闭</button>
      </div>
    )}>
      <div className="preview-body file-preview">
        {isImg && !tooBigForPreview && <img src={attUrl(att.id)} alt={att.filename} className="fp-img" />}
        {isImg && tooBigForPreview && (
          <div className="empty"><FileText size={26} /><div className="empty-text">图片较大（&gt;20MB），请下载后查看</div></div>
        )}
        {isPdf && !pdfFailed && <iframe title="pdf" src={attUrl(att.id)} className="fp-pdf" />}
        {isPdf && pdfFailed && (
          <div className="empty">
            <FileText size={26} />
            <div className="empty-text">PDF 无法在此内嵌预览</div>
            <div className="empty-sub">可能是内核不支持或文件已损坏，请点击下方「下载」后用本地阅读器打开</div>
          </div>
        )}
        {isText && !err && text == null && <div className="dim">读取中…</div>}
        {isText && err && <div className="err-text">{err}<div className="dim" style={{ marginTop: 6 }}>也可以点下方「下载」查看原文件。</div></div>}
        {isText && text != null && <pre className="preview-text">{text}</pre>}
        {!isImg && !isPdf && !isText && (
          <div className="empty">
            <FileText size={26} />
            <div className="empty-text">此类型（{att.mime}）不支持在线预览</div>
            <div className="empty-sub">Office 文档请下载后使用本地软件打开</div>
          </div>
        )}
      </div>
    </Modal>
  );
}
