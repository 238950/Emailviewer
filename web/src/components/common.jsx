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
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className={`modal${wide ? ' wide' : ''}`} onClick={(e) => e.stopPropagation()}>
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
