import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 应用数据目录：所有「不进书库」的东西都在这里（PRD §3.4） */
export function appDataDir(): string {
  if (process.env.READER_DATA_DIR) return path.resolve(process.env.READER_DATA_DIR);
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'md-reader');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'md-reader');
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'md-reader');
}

/** 首次启动、用户还没选书库时的默认位置 */
export function defaultLibraryDir(): string {
  return path.join(os.homedir(), 'Documents', 'md-reader');
}

export interface DataPaths {
  root: string;
  configFile: string;
  runFile: string;
  tokenFile: string;
  dbFile: string;
  versionsDir: string;
  logsDir: string;
  draftsDir: string;
}

export function dataPaths(root: string = appDataDir()): DataPaths {
  return {
    root,
    configFile: path.join(root, 'config.json'),
    runFile: path.join(root, 'run.json'),
    tokenFile: path.join(root, 'token'),
    dbFile: path.join(root, 'index.db'),
    versionsDir: path.join(root, 'versions'),
    logsDir: path.join(root, 'logs'),
    draftsDir: path.join(root, 'drafts'),
  };
}

export function ensureDataDirs(paths: DataPaths): void {
  for (const dir of [paths.root, paths.versionsDir, paths.logsDir, paths.draftsDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/** 库内路径一律 POSIX 风格（PRD §3.3） */
export function toPosixPath(p: string): string {
  return p.split(path.sep).join('/');
}

/** 相对 POSIX 路径 → 本机绝对路径 */
export function resolveInRoot(root: string, relPosix: string): string {
  const cleaned = relPosix.replace(/^[/\\]+/, '');
  return path.resolve(root, ...cleaned.split('/').filter((s) => s !== '' && s !== '.'));
}

/** 绝对路径是否在 root 内（含 root 本身返回 true） */
export function isInsideRoot(root: string, abs: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(abs));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function relativePosix(root: string, abs: string): string {
  return toPosixPath(path.relative(root, abs));
}

export function libraryPaths(root: string) {
  return {
    root,
    trashDir: path.join(root, '.trash'),
    assetsDir: path.join(root, 'assets'),
    metaDir: path.join(root, '.md-reader'),
  };
}

/** 目录名是否应当被索引器跳过 */
export function shouldSkipDir(name: string): boolean {
  if (name.startsWith('.')) return true;
  return ['node_modules', '__pycache__', 'venv', '$RECYCLE.BIN', 'System Volume Information'].includes(name);
}

/** 文件名是否应忽略 */
export function shouldSkipFile(name: string): boolean {
  if (name.startsWith('.')) return true;
  if (name.startsWith('~$')) return true;
  if (name.startsWith('.~')) return true;
  if (/\.(tmp|crdownload|download|part|swp|bak)$/i.test(name)) return true;
  return ['Thumbs.db', 'desktop.ini', '.DS_Store'].includes(name);
}
