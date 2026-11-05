import type { SelectionInfo } from '../lib/annotate.ts';
import type { AnnotationColor } from '../types.ts';
import { Icon } from './Icons.tsx';

const COLORS: { key: AnnotationColor; label: string }[] = [
  { key: 'yellow', label: '黄色高亮' },
  { key: 'green', label: '绿色高亮' },
  { key: 'blue', label: '蓝色高亮' },
  { key: 'pink', label: '粉色高亮' },
];

interface SelectionToolbarProps {
  info: SelectionInfo;
  onColor: (color: AnnotationColor, withNote?: boolean) => void;
  onCopy: () => void;
}

export function SelectionToolbar({ info, onColor, onCopy }: SelectionToolbarProps) {
  const width = 292;
  const bottom = info.rect.top + info.rect.height;
  const left = Math.min(Math.max(info.rect.left + info.rect.width / 2, width / 2 + 12), window.innerWidth - width / 2 - 12);
  const placeBelow = info.rect.top < 90;
  const style = {
    left,
    top: placeBelow ? bottom + 10 : info.rect.top - 10,
    transform: placeBelow ? 'translate(-50%, 0)' : 'translate(-50%, -100%)',
  } as const;

  return (
    <div className="ann-toolbar" style={style} onMouseDown={(e) => e.preventDefault()}>
      {COLORS.map((color) => (
        <button
          key={color.key}
          className={`color-dot dot-${color.key}`}
          title={color.label}
          aria-label={color.label}
          onClick={() => onColor(color.key)}
        />
      ))}
      <span className="toolbar-sep" />
      <button className="toolbar-btn" title="高亮并写批注" onClick={() => onColor('yellow', true)}>
        <Icon name="note" size={15} />
        批注
      </button>
      <button className="toolbar-btn" title="复制引用" onClick={onCopy}>
        <Icon name="copy" size={15} />
      </button>
    </div>
  );
}
