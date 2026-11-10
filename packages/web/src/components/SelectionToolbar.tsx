import type { SelectionInfo } from '../lib/annotate.ts';
import type { AiKind, AnnotationColor } from '../types.ts';
import { Icon } from './Icons.tsx';

const COLORS: { key: AnnotationColor; label: string }[] = [
  { key: 'yellow', label: '黄色高亮' },
  { key: 'green', label: '绿色高亮' },
  { key: 'blue', label: '蓝色高亮' },
  { key: 'pink', label: '粉色高亮' },
];

/** 选区工具条上的 AI 动作：入队后由 DSH 侧 worker 领走。 */
const AI_ACTIONS: { key: AiKind; label: string; hint: string }[] = [
  { key: 'explain', label: '解释', hint: '这段在讲什么' },
  { key: 'verify', label: '核实', hint: '事实性断言是否站得住' },
  { key: 'background', label: '背景', hint: '补上缺的前因' },
  { key: 'counter', label: '反问', hint: '最强的反对意见' },
];

interface SelectionToolbarProps {
  info: SelectionInfo;
  onColor: (color: AnnotationColor, withNote?: boolean) => void;
  onCopy: () => void;
  onAi?: (kind: AiKind) => void;
  /** 就这段提一个自己的问题（走 AI 队列，答案写回这段旁边）。 */
  onAsk?: () => void;
}

export function SelectionToolbar({ info, onColor, onCopy, onAi, onAsk }: SelectionToolbarProps) {
  const width = 470;
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
      {onAi && AI_ACTIONS.length > 0 && (
        <>
          <span className="toolbar-sep" />
          <span className="toolbar-label" title="排进 AI 队列，由 DSH 侧执行">
            <Icon name="sparkle" size={14} />
            AI
          </span>
          {AI_ACTIONS.map((action) => (
            <button
              key={action.key}
              className="toolbar-btn ai"
              title={action.hint}
              onClick={() => onAi(action.key)}
            >
              {action.label}
            </button>
          ))}
          {onAsk && (
            <button className="toolbar-btn ai" title="就这段提自己的问题" onClick={onAsk}>
              问…
            </button>
          )}
        </>
      )}
    </div>
  );
}
