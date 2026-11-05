import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import type { DocPayload } from '../types.ts';
import { Modal } from './Modal.tsx';
import { useToast } from '../hooks/useToast.tsx';

interface NewDocDialogProps {
  open: boolean;
  dirs: string[];
  onClose: () => void;
  onCreated: (doc: DocPayload) => void;
}

export function NewDocDialog({ open, dirs, onClose, onCreated }: NewDocDialogProps) {
  const [title, setTitle] = useState('');
  const [dir, setDir] = useState('Inbox');
  const [busy, setBusy] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    if (open) {
      setTitle('');
      setDir('Inbox');
      setBusy(false);
    }
  }, [open]);

  if (!open) return null;

  const submit = async () => {
    const clean = title.trim();
    if (!clean) return;
    setBusy(true);
    try {
      const doc = await api.createDoc({ dir, title: clean });
      toast('已新建「' + doc.title + '」', 'success');
      onCreated(doc);
      onClose();
    } catch (err) {
      toast(err instanceof Error ? err.message : '新建失败', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="新建文档"
      subtitle="默认落到 Inbox/，文件名取自标题，重名自动加序号"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-primary" onClick={() => void submit()} disabled={busy || !title.trim()}>
            {busy ? '创建中…' : '创建并打开'}
          </button>
        </>
      }
    >
      <label className="field">
        <span>标题</span>
        <input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="例如：论持久战·读书笔记"
          onKeyDown={(e) => e.key === 'Enter' && void submit()}
        />
      </label>
      <label className="field">
        <span>目录</span>
        <input value={dir} onChange={(e) => setDir(e.target.value)} placeholder="Inbox 或 books/2026" />
        <div className="dir-chips">
          {['Inbox', ...dirs.filter((d) => d && d !== 'Inbox')].slice(0, 8).map((d) => (
            <button key={d} className={`chip ${dir === d ? 'active' : ''}`} onClick={() => setDir(d)}>
              {d}
            </button>
          ))}
        </div>
      </label>
    </Modal>
  );
}

interface MoveDialogProps {
  doc: DocPayload | null;
  dirs: string[];
  mode: 'move' | 'rename';
  onClose: () => void;
  onMoved: (doc: DocPayload) => void;
}

export function MoveDialog({ doc, dirs, mode, onClose, onMoved }: MoveDialogProps) {
  const [targetDir, setTargetDir] = useState('');
  const [newName, setNewName] = useState('');
  const [updateLinks, setUpdateLinks] = useState(true);
  const [busy, setBusy] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    if (!doc) return;
    const idx = doc.relPath.lastIndexOf('/');
    setTargetDir(idx === -1 ? '' : doc.relPath.slice(0, idx));
    setNewName(doc.relPath.slice(idx + 1).replace(/\.md$/i, ''));
    setUpdateLinks(true);
    setBusy(false);
  }, [doc]);

  if (!doc) return null;

  const submit = async () => {
    setBusy(true);
    try {
      const next = await api.moveDoc(doc.id, { targetDir, newName, updateLinks });
      toast(mode === 'rename' ? '已重命名' : '已移动', 'success');
      onMoved(next);
      onClose();
    } catch (err) {
      toast(err instanceof Error ? err.message : '操作失败', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={mode === 'rename' ? '重命名文档' : '移动文档'}
      subtitle={doc.relPath}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-primary" onClick={() => void submit()} disabled={busy || !newName.trim()}>
            {busy ? '处理中…' : '确定'}
          </button>
        </>
      }
    >
      <label className="field">
        <span>目录</span>
        <input value={targetDir} onChange={(e) => setTargetDir(e.target.value)} placeholder="books/2026" />
        <div className="dir-chips">
          {dirs.slice(0, 12).map((d) => (
            <button key={d || 'root'} className={`chip ${targetDir === d ? 'active' : ''}`} onClick={() => setTargetDir(d)}>
              {d || '根目录'}
            </button>
          ))}
        </div>
      </label>
      <label className="field">
        <span>文件名（不含 .md）</span>
        <input value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void submit()} />
      </label>
      <label className="field checkbox">
        <input type="checkbox" checked={updateLinks} onChange={(e) => setUpdateLinks(e.target.checked)} />
        <span>同步更新指向它的 [[链接]]</span>
      </label>
    </Modal>
  );
}
