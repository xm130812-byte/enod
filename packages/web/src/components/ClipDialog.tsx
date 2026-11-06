import { useEffect, useRef, useState } from 'react';
import type { ClipJob, ClipMode, ClipResult } from '../types.ts';
import { api } from '../api.ts';
import { Modal } from './Modal.tsx';
import { Icon } from './Icons.tsx';
import { useToast } from '../hooks/useToast.tsx';

interface ClipDialogProps {
  open: boolean;
  onClose: () => void;
  onOpenDoc: (id: string) => void;
  onClipped: (result: ClipResult) => void;
}

type View = 'idle' | 'running' | 'duplicate' | 'error';

const PHASE_LABEL: Record<string, string> = {
  queued: '准备中…',
  fetching: '正在抓取网页…',
  extracting: '正在提取正文…',
  images: '正在保存图片…',
  saving: '正在写入收件箱…',
  duplicate: '发现重复文档',
  done: '剪藏完成',
  error: '剪藏失败',
};

export function ClipDialog({ open, onClose, onOpenDoc, onClipped }: ClipDialogProps) {
  const [url, setUrl] = useState('');
  const [view, setView] = useState<View>('idle');
  const [job, setJob] = useState<ClipJob | null>(null);
  const [duplicate, setDuplicate] = useState<ClipResult | null>(null);
  const [error, setError] = useState('');
  const [confirmOverwrite, setConfirmOverwrite] = useState(false);
  const timerRef = useRef<number | null>(null);
  const runRef = useRef(0);
  const { toast } = useToast();

  const stopPolling = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  useEffect(() => {
    if (!open) {
      stopPolling();
      runRef.current++;
      return;
    }
    setUrl('');
    setView('idle');
    setJob(null);
    setDuplicate(null);
    setError('');
    setConfirmOverwrite(false);
    runRef.current++;
  }, [open]);

  useEffect(() => () => stopPolling(), []);

  const finish = (result: ClipResult) => {
    toast(`已剪藏「${result.title}」${result.imageCount > 0 ? ` · ${result.imageCount} 张图片` : ''}`, 'success');
    onClipped(result);
    onClose();
  };

  const poll = (jobId: string, token: number) => {
    const tick = async () => {
      if (token !== runRef.current) return;
      try {
        const next = await api.clipJob(jobId);
        if (token !== runRef.current) return;
        setJob(next);
        if (next.status === 'done') {
          if (next.result) finish(next.result);
          return;
        }
        if (next.status === 'duplicate') {
          const result = next.result ?? null;
          setDuplicate(result);
          setView('duplicate');
          setConfirmOverwrite(false);
          return;
        }
        if (next.status === 'error') {
          setError(next.error?.message ?? next.message ?? '剪藏失败');
          setView('error');
          return;
        }
        timerRef.current = window.setTimeout(() => void tick(), 420);
      } catch (err) {
        if (token !== runRef.current) return;
        setError(err instanceof Error ? err.message : '无法读取剪藏进度');
        setView('error');
      }
    };
    void tick();
  };

  const start = async (mode: ClipMode = 'ask') => {
    const clean = url.trim();
    if (!clean) return;
    stopPolling();
    const token = ++runRef.current;
    setView('running');
    setError('');
    setDuplicate(null);
    setConfirmOverwrite(false);
    setJob(null);
    try {
      const { jobId } = await api.clip({ url: clean, mode });
      if (token !== runRef.current) return;
      poll(jobId, token);
    } catch (err) {
      if (token !== runRef.current) return;
      setError(err instanceof Error ? err.message : '剪藏请求失败');
      setView('error');
    }
  };

  if (!open) return null;

  const running = view === 'running';
  const progress = job?.progress ?? 0;
  const phase = job?.status ?? 'queued';

  return (
    <Modal
      title="剪藏网页"
      subtitle="抓取正文并保存到 Inbox/，图片会下载到书库 assets/"
      onClose={onClose}
      dismissable={!running}
      footer={
        view === 'idle' ? (
          <>
            <button className="btn btn-ghost" onClick={onClose}>
              取消
            </button>
            <button className="btn btn-primary" onClick={() => void start()} disabled={!url.trim()}>
              <Icon name="clip" size={14} />
              开始剪藏
            </button>
          </>
        ) : view === 'running' ? (
          <span className="clip-running-note">抓取和下载图片可能需要几秒到半分钟…</span>
        ) : view === 'duplicate' ? (
          <>
            <button
              className="btn btn-ghost"
              onClick={() => {
                if (duplicate?.duplicate) onOpenDoc(duplicate.duplicate.id);
                onClose();
              }}
            >
              打开已有
            </button>
            <button className="btn btn-ghost" onClick={() => void start('new')}>
              仍然新建
            </button>
            <button
              className={`btn ${confirmOverwrite ? 'btn-danger' : 'btn-ghost'}`}
              onClick={() => {
                if (!confirmOverwrite) {
                  setConfirmOverwrite(true);
                  return;
                }
                void start('overwrite');
              }}
            >
              {confirmOverwrite ? '确认覆盖正文' : '覆盖已有'}
            </button>
          </>
        ) : (
          <>
            <button className="btn btn-ghost" onClick={onClose}>
              关闭
            </button>
            <button className="btn btn-primary" onClick={() => void start()}>
              重试
            </button>
          </>
        )
      }
    >
      <label className="field">
        <span>网页地址</span>
        <input
          autoFocus
          type="url"
          value={url}
          disabled={running}
          onChange={(event) => setUrl(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && view === 'idle') void start();
          }}
          placeholder="https://example.com/article"
          spellCheck={false}
        />
      </label>

      {view === 'idle' && (
        <p className="clip-hint">
          支持大多数新闻、博客与公众号正文页。抓取失败时不会写入任何文件；重复链接会先询问。
        </p>
      )}

      {view === 'running' && (
        <div className="clip-progress" aria-live="polite">
          <div className="clip-progress-head">
            <span className="spinner" />
            <div>
              <strong>{PHASE_LABEL[phase] ?? job?.message ?? '正在处理…'}</strong>
              <span>{job?.message ?? '已加入队列'}</span>
            </div>
            <em>{Math.round(progress * 100)}%</em>
          </div>
          <div className="clip-bar" aria-hidden="true">
            <i style={{ width: `${Math.max(2, Math.round(progress * 100))}%` }} />
          </div>
          <p className="clip-url">{job?.url ?? url}</p>
        </div>
      )}

      {view === 'duplicate' && duplicate?.duplicate && (
        <div className="clip-duplicate">
          <div className="clip-dup-card">
            <Icon name="inbox" size={18} />
            <div>
              <strong>这篇已经剪藏过</strong>
              <span>{duplicate.duplicate.title}</span>
              <em>{duplicate.duplicate.relPath}</em>
            </div>
          </div>
          {confirmOverwrite && (
            <p className="clip-warn">
              覆盖会用本次抓取的正文替换现有文档；已保存的批注可能因原文变化而进入「已失效批注」，不会静默删除。
            </p>
          )}
        </div>
      )}

      {view === 'error' && (
        <div className="clip-error" role="alert">
          <Icon name="alert" size={17} />
          <div>
            <strong>没能剪藏这个页面</strong>
            <p>{error}</p>
            <span>可以换一个地址重试，或先确认页面在 Chrome 里能正常打开。</span>
          </div>
        </div>
      )}
    </Modal>
  );
}
