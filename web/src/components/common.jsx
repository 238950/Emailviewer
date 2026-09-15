// 公共小组件
import React, { useEffect, useRef, useState } from 'react';
import { X, Loader2, Inbox, AlertCircle, CheckCircle2, Info } from 'lucide-react';

export function Spinner({ size = 16 }) {
  return <Loader2 size={size} className="spin" />;
}

export function IconBtn({ title, children, onClick, danger, active, disabled, className = '' }) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`icon-btn${active ? ' active' : ''}${danger ? ' danger' : ''} ${className}`}
    >
      {children}
    </button>
  );
}

export function Chip({ children, color, onClick, active, title }) {
  return (
    <span
      className={`chip${active ? ' chip-active' : ''}`}
      style={color ? { '--chip': color } : undefined}
      onClick={onClick}
      title={title}
    >
      {children}
    </span>
  );
}

export function Modal({ title, onClose, children, wide, footer }) {
  // 配套：Esc 关闭 + 关闭后把焦点还给触发元素。
  // onClose 每次渲染都是新函数，用 ref 持有以免 effect 反复重建、焦点被反复抢回。
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const prev = document.activeElement;
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      closeRef.current?.();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (prev && typeof prev.focus === 'function' && document.contains(prev)) prev.focus();
    };
  }, []);
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className={`modal${wide ? ' wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <div className="modal-title">{title}</div>
          <IconBtn title="关闭" onClick={onClose}><X size={16} /></IconBtn>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Empty({ icon, text, sub }) {
  return (
    <div className="empty">
      {icon || <Inbox size={34} />}
      <div className="empty-text">{text}</div>
      {sub && <div className="empty-sub">{sub}</div>}
    </div>
  );
}

export function Toasts({ toasts }) {
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.type}`}>
          {t.type === 'error' ? <AlertCircle size={15} /> : t.type === 'success' ? <CheckCircle2 size={15} /> : <Info size={15} />}
          <span>{t.msg}</span>
        </div>
      ))}
    </div>
  );
}

/** 右侧滑动抽屉 */
export function Drawer({ open, onClose, title, children, width = 'min(640px, 100%)' }) {
  return (
    <div className={`drawer-mask${open ? ' open' : ''}`} onClick={onClose}>
      <div className="drawer" style={{ width }} onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <div className="drawer-title">{title}</div>
          <IconBtn title="关闭" onClick={onClose}><X size={16} /></IconBtn>
        </div>
        <div className="drawer-body">{children}</div>
      </div>
    </div>
  );
}

/** 弹出菜单（点按收起） */
export function PopMenu({ open, onClose, items, pos }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="popmenu" ref={ref} style={pos}>
      {items.filter(Boolean).map((it, i) =>
        it.divider ? <div key={i} className="popmenu-divider" />
          : (
            <button key={i} className={`popmenu-item${it.danger ? ' danger' : ''}`} onClick={() => { onClose(); it.onClick && it.onClick(); }}>
              {it.icon}{it.label}
            </button>
          ))}
    </div>
  );
}

export function useModalState() {
  const [open, setOpen] = useState(false);
  return { open, setOpen };
}

/**
 * 主题化的确认弹窗，替代 window.confirm。
 * 原生 confirm 在暗色模式下刺眼、按钮文案无法定制（改不成"永久删除/保留"），
 * 且部分浏览器"禁止再弹窗"后会静默返回 false，用户误以为操作已生效。
 * 用法：
 *   const [ask, setAsk] = useState(null);   // { title, body, danger, confirmText, onOk }
 *   ...
 *   <ConfirmDialog req={ask} onClose={() => setAsk(null)} />
 */
export function ConfirmDialog({ req, onClose }) {
  if (!req) return null;
  const { title = '请确认', body, danger, confirmText = '确定', cancelText = '取消', onOk } = req;
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={(
        <div className="modal-actions">
          <button className="btn ghost" onClick={onClose}>{cancelText}</button>
          <button
            className={`btn ${danger ? 'danger' : 'primary'}`}
            onClick={async () => { await onOk?.(); onClose(); }}
          >
            {confirmText}
          </button>
        </div>
      )}
    >
      <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.65 }}>{body}</div>
    </Modal>
  );
}

export function Field({ label, children, hint }) {
  return (
    <label className="field">
      <div className="field-label">{label}</div>
      {children}
      {hint && <div className="field-hint">{hint}</div>}
    </label>
  );
}

export function Toggle({ checked, onChange, label }) {
  return (
    <label className="toggle-row" onClick={(e) => e.stopPropagation()}>
      <input type="checkbox" className="toggle-input" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="toggle-track"><span className="toggle-knob" /></span>
      {label && <span className="toggle-label">{label}</span>}
    </label>
  );
}
