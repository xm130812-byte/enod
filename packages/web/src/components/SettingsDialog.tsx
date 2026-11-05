import { useEffect, useRef, useState } from 'react';
import { api } from '../api.ts';
import type { AppConfig, FontFamily, ThemeName } from '../types.ts';
import { useLibrary } from '../hooks/useLibrary.tsx';
import { useToast } from '../hooks/useToast.tsx';
import { Modal } from './Modal.tsx';
import { Icon } from './Icons.tsx';

interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
}

const THEMES: { key: ThemeName; label: string }[] = [
  { key: 'light', label: '亮' },
  { key: 'dark', label: '暗' },
  { key: 'sepia', label: '护眼' },
  { key: 'system', label: '跟随系统' },
];

const FONTS: { key: FontFamily; label: string; sample: string }[] = [
  { key: 'serif', label: '衬线', sample: 'Aa 宋' },
  { key: 'sans', label: '无衬线', sample: 'Aa 黑' },
  { key: 'mono', label: '等宽', sample: 'Aa 码' },
];

const ACCENTS: { key: AppConfig['accent']; label: string; color: string }[] = [
  { key: 'blue', label: '深蓝', color: '#4176e6' },
  { key: 'teal', label: '青', color: '#0e7c7b' },
  { key: 'green', label: '绿', color: '#3e7d4f' },
  { key: 'red', label: '朱', color: '#c24a38' },
  { key: 'amber', label: '琥珀', color: '#a9691b' },
  { key: 'graphite', label: '石墨', color: '#4a5563' },
];

const DENSITIES: { key: AppConfig['density']; label: string; hint: string }[] = [
  { key: 'comfortable', label: '舒适', hint: '卡片显示 3 行摘要' },
  { key: 'compact', label: '紧凑', hint: '卡片显示 2 行摘要，一屏更多' },
];

const LAYOUTS: { key: AppConfig['readerLayout']; label: string; hint: string }[] = [
  { key: 'document', label: '文档', hint: '三栏：目录 + 正文 + 批注/反链' },
  { key: 'focus', label: '专注', hint: '单栏：类似 Typora，隐藏两侧栏' },
];

export function SettingsDialog({ open, onClose }: SettingsDialogProps) {
  const { config, info, applyConfig, refresh } = useLibrary();
  const { toast } = useToast();
  const [form, setForm] = useState<AppConfig | null>(null);
  const [rootInput, setRootInput] = useState('');
  const [busy, setBusy] = useState(false);
  const firstRender = useRef(true);

  useEffect(() => {
    if (open && config) {
      setForm({ ...config });
      setRootInput(info?.root ?? '');
      firstRender.current = true;
    }
  }, [open, config, info?.root]);

  useEffect(() => {
    if (!open || !form) return;
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    const timer = window.setTimeout(() => {
      void applyConfig({
        theme: form.theme,
        accent: form.accent,
        density: form.density,
        readerLayout: form.readerLayout,
        fontFamily: form.fontFamily,
        fontSize: form.fontSize,
        lineHeight: form.lineHeight,
        measureCh: form.measureCh,
        autosave: form.autosave,
        syncProgress: form.syncProgress,
        versionKeep: form.versionKeep,
      });
    }, 320);
    return () => window.clearTimeout(timer);
  }, [form, open, applyConfig]);

  if (!open || !form) return null;

  const patch = (next: Partial<AppConfig>) => setForm((prev) => (prev ? { ...prev, ...next } : prev));

  const openLibrary = async () => {
    const target = rootInput.trim();
    if (!target) return;
    setBusy(true);
    try {
      await api.openLibrary(target);
      await refresh();
      toast('已切换书库', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : '切换失败', 'error');
    } finally {
      setBusy(false);
    }
  };

  const rebuild = async () => {
    setBusy(true);
    try {
      await api.rescan();
      await refresh();
      toast('索引已重建', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : '重建失败', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="设置"
      subtitle="所有设置保存在本机，不进书库"
      onClose={onClose}
      wide
      footer={
        <button className="btn btn-primary" onClick={onClose}>
          完成
        </button>
      }
    >
      <div className="settings">
        <section className="settings-section">
          <h3>书库</h3>
          <label className="field">
            <span>书库目录（绝对路径）</span>
            <div className="field-row">
              <input value={rootInput} onChange={(e) => setRootInput(e.target.value)} spellCheck={false} />
              <button className="btn btn-ghost" onClick={() => void openLibrary()} disabled={busy}>
                切换
              </button>
            </div>
          </label>
          <div className="settings-stats">
            <span>{info?.stats.total ?? 0} 篇</span>
            <span>{(info?.stats.words ?? 0).toLocaleString('zh-CN')} 字</span>
            <span>{info?.stats.tags ?? 0} 个标签</span>
            {info?.stats.lastScan && <span>上次索引 {info.stats.lastScan.durationMs}ms</span>}
          </div>
          <div className="settings-actions">
            <button className="btn btn-ghost small" onClick={() => void rebuild()} disabled={busy}>
              <Icon name="refresh" size={14} />
              重建索引
            </button>
            <span className="muted small">索引库可随时删除重建，不会影响 .md 文件</span>
          </div>
        </section>

        <section className="settings-section">
          <h3>阅读</h3>
          <div className="field">
            <span>主题</span>
            <div className="segmented">
              {THEMES.map((t) => (
                <button
                  key={t.key}
                  className={form.theme === t.key ? 'active' : ''}
                  onClick={() => patch({ theme: t.key })}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          <div className="field">
            <span>字体</span>
            <div className="segmented">
              {FONTS.map((f) => (
                <button
                  key={f.key}
                  className={form.fontFamily === f.key ? 'active' : ''}
                  onClick={() => patch({ fontFamily: f.key })}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          <div className="field">
            <span>强调色</span>
            <div className="accent-row">
              {ACCENTS.map((accent) => (
                <button
                  key={accent.key}
                  className={`accent-swatch ${form.accent === accent.key ? 'active' : ''}`}
                  style={{ background: accent.color }}
                  title={accent.label}
                  aria-label={accent.label}
                  onClick={() => patch({ accent: accent.key })}
                />
              ))}
            </div>
          </div>

          <div className="field">
            <span>界面密度</span>
            <div className="segmented">
              {DENSITIES.map((density) => (
                <button
                  key={density.key}
                  className={form.density === density.key ? 'active' : ''}
                  onClick={() => patch({ density: density.key })}
                  title={density.hint}
                >
                  {density.label}
                </button>
              ))}
            </div>
          </div>

          <div className="field">
            <span>阅读布局</span>
            <div className="segmented">
              {LAYOUTS.map((layout) => (
                <button
                  key={layout.key}
                  className={form.readerLayout === layout.key ? 'active' : ''}
                  onClick={() => patch({ readerLayout: layout.key })}
                  title={layout.hint}
                >
                  {layout.label}
                </button>
              ))}
            </div>
          </div>

          <label className="field range">
            <span>
              字号 <em>{form.fontSize}px</em>
            </span>
            <input
              type="range"
              min={14}
              max={30}
              step={1}
              value={form.fontSize}
              onChange={(e) => patch({ fontSize: Number(e.target.value) })}
            />
          </label>

          <label className="field range">
            <span>
              行高 <em>{form.lineHeight.toFixed(2)}</em>
            </span>
            <input
              type="range"
              min={1.4}
              max={2.4}
              step={0.1}
              value={form.lineHeight}
              onChange={(e) => patch({ lineHeight: Number(e.target.value) })}
            />
          </label>

          <label className="field range">
            <span>
              行宽 <em>{form.measureCh}ch</em>
            </span>
            <input
              type="range"
              min={40}
              max={110}
              step={2}
              value={form.measureCh}
              onChange={(e) => patch({ measureCh: Number(e.target.value) })}
            />
          </label>

          <p className="settings-preview" style={{ maxWidth: `${form.measureCh}ch` }}>
            中文排版的舒适区：一行 60–75 个字符，行高 1.6–1.8。字号的绝对值小于它和行宽的比例。
          </p>
        </section>

        <section className="settings-section">
          <h3>写作与同步</h3>
          <label className="field checkbox">
            <input type="checkbox" checked={form.autosave} onChange={(e) => patch({ autosave: e.target.checked })} />
            <span>停止输入 800ms 后自动保存</span>
          </label>
          <label className="field checkbox">
            <input
              type="checkbox"
              checked={form.syncProgress}
              onChange={(e) => patch({ syncProgress: e.target.checked })}
            />
            <span>把阅读进度写进文件（默认只存本机，开启后跨设备可同步）</span>
          </label>
          <label className="field range">
            <span>
              版本快照保留 <em>{form.versionKeep}</em> 版
            </span>
            <input
              type="range"
              min={0}
              max={50}
              step={1}
              value={form.versionKeep}
              onChange={(e) => patch({ versionKeep: Number(e.target.value) })}
            />
          </label>
          <p className="muted small">快照在应用数据目录的 versions/ 下，不写进书库。</p>
        </section>

        <section className="settings-section about">
          <h3>关于</h3>
          <p className="muted small">
            md-reader 0.1.0 · 本地守护进程 + Chrome · 文件即数据库
            <br />
            应用数据目录与日志不进书库；书库只同步 .md 与 assets/。
          </p>
        </section>
      </div>
    </Modal>
  );
}
