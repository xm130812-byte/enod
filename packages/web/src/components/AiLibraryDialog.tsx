import { useState } from 'react';
import type { AiLibraryBudget } from '../types.ts';
import { Modal } from './Modal.tsx';
import { Icon } from './Icons.tsx';

interface AiLibraryDialogProps {
  onSubmit: (question: string, budgetChars: number) => Promise<boolean>;
  onClose: () => void;
}

const BUDGETS: { key: AiLibraryBudget; label: string; chars: number; hint: string }[] = [
  { key: 'small', label: '小', chars: 4000, hint: '约 2.7k tokens' },
  { key: 'standard', label: '标准', chars: 8000, hint: '约 5.3k tokens' },
  { key: 'deep', label: '深', chars: 16000, hint: '约 10.7k tokens' },
];

/**
 * 「问书库」入口：一个问题、一个预算档。
 *
 * 预算档就是成本闸门 —— 检索在本地做（0 token），只有挑出来的片段进模型，
 * 所以花费只跟这个数字有关，和书库多大无关。
 */
export function AiLibraryDialog({ onSubmit, onClose }: AiLibraryDialogProps) {
  const [question, setQuestion] = useState('');
  const [budget, setBudget] = useState<AiLibraryBudget>('standard');
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    const text = question.trim();
    if (!text || busy) return;
    setBusy(true);
    try {
      const chars = BUDGETS.find((item) => item.key === budget)?.chars ?? 8000;
      if (await onSubmit(text, chars)) onClose();
    } catch {
      /* onSubmit 已经提示过错误，弹窗留着让人改 */
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="问书库"
      subtitle="在整库里检索后回答，答案会落成一篇新笔记"
      onClose={onClose}
      footer={
        <>
          <span className="ai-lib-cost">
            {BUDGETS.find((item) => item.key === budget)?.hint} · 检索在本地跑，不花 token
          </span>
          <button className="btn btn-ghost" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button className="btn btn-primary" onClick={() => void submit()} disabled={busy || !question.trim()}>
            <Icon name="sparkle" size={14} />
            {busy ? '入队中…' : '入队'}
          </button>
        </>
      }
    >
      <textarea
        className="ai-lib-input"
        autoFocus
        rows={4}
        placeholder="例如：我这半年关于 Agent 评测的笔记里，哪些说法互相矛盾？"
        value={question}
        onChange={(event) => setQuestion(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void submit();
          }
        }}
      />
      <div className="ai-lib-budget" role="group" aria-label="上下文预算">
        {BUDGETS.map((item) => (
          <button
            key={item.key}
            className={`ai-lib-budget-item${budget === item.key ? ' active' : ''}`}
            onClick={() => setBudget(item.key)}
            type="button"
          >
            <strong>{item.label}</strong>
            <span>{item.chars} 字</span>
          </button>
        ))}
      </div>
      <p className="ai-lib-hint">
        队列里的任务由 DSH 侧领走执行；结果写进 <code>Inbox/</code>，标题以「问书库：」开头。
      </p>
    </Modal>
  );
}
