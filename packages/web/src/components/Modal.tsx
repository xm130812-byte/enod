import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { Icon } from './Icons.tsx';

interface ModalProps {
  title: string;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  wide?: boolean;
  dismissable?: boolean;
}

export function Modal({ title, subtitle, children, footer, onClose, wide, dismissable = true }: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && dismissable) {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose, dismissable]);

  return (
    <div className={`modal-backdrop ${wide ? 'modal-wide' : ''}`} onMouseDown={(e) => {
      if (dismissable && e.target === e.currentTarget) onClose();
    }}>
      <div className="modal" ref={panelRef} role="dialog" aria-modal="true" aria-label={title}>
        <header className="modal-head">
          <div>
            <h2>{title}</h2>
            {subtitle && <p className="modal-subtitle">{subtitle}</p>}
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="关闭">
            <Icon name="close" />
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>
  );
}
