import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DataPaths } from './paths.ts';
import { defaultLibraryDir } from './paths.ts';

export type ThemeName = 'light' | 'dark' | 'sepia' | 'system';
export type FontFamily = 'serif' | 'sans' | 'mono';
export type AccentName = 'blue' | 'teal' | 'green' | 'red' | 'amber' | 'graphite';
export type Density = 'comfortable' | 'compact';
export type ReaderLayout = 'document' | 'focus';

export interface AppConfig {
  libraryRoot: string | null;
  theme: ThemeName;
  accent: AccentName;
  density: Density;
  readerLayout: ReaderLayout;
  fontSize: number;
  lineHeight: number;
  measureCh: number;
  fontFamily: FontFamily;
  autosave: boolean;
  versionKeep: number;
  syncProgress: boolean;
  showLineNumbers: boolean;
  lastDocId: string | null;
}

export const DEFAULT_CONFIG: AppConfig = {
  libraryRoot: null,
  theme: 'system',
  accent: 'blue',
  density: 'comfortable',
  readerLayout: 'document',
  fontSize: 18,
  lineHeight: 1.75,
  measureCh: 68,
  fontFamily: 'sans',
  autosave: true,
  versionKeep: 20,
  syncProgress: false,
  showLineNumbers: false,
  lastDocId: null,
};

export const CONFIG_LIMITS = {
  fontSize: [13, 32] as [number, number],
  lineHeight: [1.2, 2.6] as [number, number],
  measureCh: [40, 120] as [number, number],
  versionKeep: [1, 200] as [number, number],
};

export class ConfigStore {
  paths: DataPaths;
  private config: AppConfig;

  constructor(paths: DataPaths) {
    this.paths = paths;
    this.config = this.read();
  }

  private read(): AppConfig {
    try {
      const raw = fs.readFileSync(this.paths.configFile, 'utf8');
      const parsed = JSON.parse(raw) as Partial<AppConfig>;
      return sanitizeConfig({ ...DEFAULT_CONFIG, ...parsed });
    } catch {
      return { ...DEFAULT_CONFIG };
    }
  }

  get(): AppConfig {
    return { ...this.config };
  }

  save(patch: Partial<AppConfig>): AppConfig {
    const next = sanitizeConfig({ ...this.config, ...patch });
    this.config = next;
    fs.mkdirSync(path.dirname(this.paths.configFile), { recursive: true });
    const tmp = `${this.paths.configFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
    fs.renameSync(tmp, this.paths.configFile);
    return { ...next };
  }

  /** 环境变量优先，供开发/测试使用 */
  resolveLibraryRoot(): string | null {
    const envRoot = process.env.READER_ROOT?.trim();
    if (envRoot) return path.resolve(envRoot);
    return this.config.libraryRoot ? path.resolve(this.config.libraryRoot) : null;
  }

  ensureDefaultLibrary(): string {
    const dir = this.config.libraryRoot ? path.resolve(this.config.libraryRoot) : defaultLibraryDir();
    fs.mkdirSync(path.join(dir, 'Inbox'), { recursive: true });
    if (!fs.existsSync(path.join(dir, 'assets'))) fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
    return dir;
  }
}

function clamp(value: number, [min, max]: [number, number], fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function sanitizeConfig(input: AppConfig): AppConfig {
  const theme: ThemeName = ['light', 'dark', 'sepia', 'system'].includes(input.theme) ? input.theme : 'system';
  const fontFamily: FontFamily = ['serif', 'sans', 'mono'].includes(input.fontFamily) ? input.fontFamily : 'sans';
  const accent: AccentName = ['blue', 'teal', 'green', 'red', 'amber', 'graphite'].includes(input.accent)
    ? input.accent
    : 'blue';
  const density: Density = input.density === 'compact' ? 'compact' : 'comfortable';
  const readerLayout: ReaderLayout = input.readerLayout === 'focus' ? 'focus' : 'document';
  return {
    libraryRoot: typeof input.libraryRoot === 'string' && input.libraryRoot.trim() ? input.libraryRoot : null,
    theme,
    accent,
    density,
    readerLayout,
    fontSize: clamp(input.fontSize, CONFIG_LIMITS.fontSize, 18),
    lineHeight: clamp(input.lineHeight, CONFIG_LIMITS.lineHeight, 1.75),
    measureCh: clamp(input.measureCh, CONFIG_LIMITS.measureCh, 68),
    fontFamily,
    autosave: input.autosave !== false,
    versionKeep: clamp(input.versionKeep, CONFIG_LIMITS.versionKeep, 20),
    syncProgress: input.syncProgress === true,
    showLineNumbers: input.showLineNumbers === true,
    lastDocId: typeof input.lastDocId === 'string' ? input.lastDocId : null,
  };
}

/* ------------------------------------------------------------------ run.json */

export interface RunInfo {
  pid: number;
  port: number;
  instanceId: string;
  startedAt: string;
  url: string;
  libraryRoot: string | null;
  version: string;
}

export function readRunInfo(paths: DataPaths): RunInfo | null {
  try {
    const raw = fs.readFileSync(paths.runFile, 'utf8');
    const info = JSON.parse(raw) as Partial<RunInfo>;
    if (!info || typeof info.port !== 'number' || typeof info.instanceId !== 'string') return null;
    return info as RunInfo;
  } catch {
    return null;
  }
}

export function writeRunInfo(paths: DataPaths, info: RunInfo): void {
  fs.mkdirSync(paths.root, { recursive: true });
  const tmp = `${paths.runFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(info, null, 2), 'utf8');
  fs.renameSync(tmp, paths.runFile);
}

export function clearRunInfo(paths: DataPaths, instanceId: string): void {
  const current = readRunInfo(paths);
  if (current && current.instanceId !== instanceId) return;
  fs.rmSync(paths.runFile, { force: true });
}

export function newInstanceId(): string {
  return randomUUID();
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
