import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';

interface CollapseProps {
  open: boolean;
  children: ReactNode;
  className?: string;
}

/**
 * 高度折叠容器：始终保持子树挂载，用 grid-template-rows 做过渡；
 * 收起时设置 inert，避免键盘焦点落进看不见的内容。
 */
export function Collapse({ open, children, className }: CollapseProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = ref.current as (HTMLDivElement & { inert?: boolean }) | null;
    if (!node) return;
    node.inert = !open;
  }, [open]);

  return (
    <div ref={ref} className={`collapse ${open ? 'open' : ''} ${className ?? ''}`.trim()} aria-hidden={!open}>
      <div className="collapse-inner">{children}</div>
    </div>
  );
}
