import { useEffect } from 'react';
import { Icon } from './Icons.tsx';

interface LightboxProps {
  src: string;
  alt: string;
  onClose: () => void;
}

export function Lightbox({ src, alt, onClose }: LightboxProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return (
    <div className="lightbox" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <button className="lightbox-close icon-btn" onClick={onClose} aria-label="关闭">
        <Icon name="close" />
      </button>
      <img src={src} alt={alt} onClick={(e) => e.stopPropagation()} />
      {alt && <p className="lightbox-caption">{alt}</p>}
    </div>
  );
}
