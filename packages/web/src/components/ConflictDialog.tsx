import { useEffect, useMemo, useRef, useState } from 'react';
import { MergeView } from '@codemirror/merge';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import type { ConflictDetail, DocPayload } from '../types.ts';
import { Modal } from './Modal.tsx';

interface ConflictDialogProps {
  doc: DocPayload;
  conflict: ConflictDetail;
  mine: string;
  onLoadDisk: () => void;
  onSaveCopy: () => void;
  onMerge: (merged: string, diskHash: string) => Promise<void>;
  onClose: () => void;
}

function countLines(text: string): number {
  return text === '' ? 0 : text.split('\n').length;
}

export function ConflictDialog({ doc, conflict, mine, onLoadDisk, onSaveCopy, onMerge, onClose }: ConflictDialogProps) {
  const [mode, setMode] = useState<'choose' | 'merge'>('choose');
  const [merged, setMerged] = useState(mine);
  const [busy, setBusy] = useState(false);
  const mergeHost = useRef<HTMLDivElement>(null);
  const disk = conflict.current.body;
  const stats = useMemo(() => ({ disk: countLines(disk), mine: countLines(mine) }), [disk, mine]);

  // 逐行 diff3：磁盘版 / 我的版两栏带行级 diff 与接受控件，第三栏是可编辑结果。
  useEffect(() => {
    if (mode !== 'merge' || !mergeHost.current) return;
    const view = new MergeView({
      a: {
        doc: disk,
        extensions: [EditorState.readOnly.of(true), EditorView.editable.of(false)],
      },
      b: {
        doc: mine,
        extensions: [
          EditorView.updateListener.of((update) => {
            if (update.docChanged) setMerged(update.state.doc.toString());
          }),
        ],
      },
      parent: mergeHost.current,
      highlightChanges: true,
      gutter: true,
      collapseUnchanged: { margin: 3, minSize: 4 },
    });
    return () => view.destroy();
  }, [mode, disk, mine]);

  if (mode === 'merge') {
    return (
      <Modal
        title="逐行合并"
        subtitle={`磁盘版本 ${stats.disk} 行，我的版本 ${stats.mine} 行。左：磁盘版；中：我的版（可逐块接受）；右：可编辑的合并结果。`}
        onClose={onClose}
        wide
        dismissable={!busy}
        footer={
          <>
            <button className="btn btn-ghost" onClick={() => setMode('choose')} disabled={busy}>
              返回
            </button>
            <button
              className="btn btn-primary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await onMerge(merged, conflict.current.hash);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? '保存中…' : '保存合并结果'}
            </button>
          </>
        }
      >
        <div className="merge3">
          <div className="merge3-diff" ref={mergeHost} />
          <section className="merge3-result">
            <h4>合并结果（可编辑）</h4>
            <textarea
              className="merge-textarea"
              value={merged}
              onChange={(e) => setMerged(e.target.value)}
              spellCheck={false}
            />
          </section>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      title="保存冲突"
      subtitle={`「${doc.title}」在磁盘上被修改过，你的改动还没有保存。`}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onSaveCopy}>
            保留我的，另存副本
          </button>
          <button className="btn btn-ghost" onClick={() => setMode('merge')}>
            逐行合并
          </button>
          <button className="btn btn-primary" onClick={onLoadDisk}>
            载入磁盘版本
          </button>
        </>
      }
    >
      <p className="conflict-note">
        磁盘版本 {stats.disk} 行，你的版本 {stats.mine} 行。选择「载入磁盘版本」会丢弃你本次未保存的修改。
      </p>
      <div className="conflict-previews">
        <section>
          <h4>磁盘版本（开头）</h4>
          <pre>{disk.slice(0, 600) || '（空）'}</pre>
        </section>
        <section>
          <h4>我的版本（开头）</h4>
          <pre>{mine.slice(0, 600) || '（空）'}</pre>
        </section>
      </div>
    </Modal>
  );
}
