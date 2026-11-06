export type DocStatus = 'unread' | 'reading' | 'done';
export type AnnotationColor = 'yellow' | 'green' | 'blue' | 'pink';
export type ThemeName = 'light' | 'dark' | 'sepia' | 'system';
export type FontFamily = 'serif' | 'sans' | 'mono';
export type AccentName = 'blue' | 'teal' | 'green' | 'red' | 'amber' | 'graphite';
export type Density = 'comfortable' | 'compact';
export type ReaderLayout = 'document' | 'focus';

export interface DocSummary {
  id: string;
  relPath: string;
  title: string;
  tags: string[];
  aliases: string[];
  status: DocStatus;
  progress: number;
  words: number;
  excerpt: string;
  sourceUrl: string | null;
  mtime: number;
  size: number;
  annCount: number;
  created: string | null;
}

export interface Annotation {
  id: string;
  exact: string;
  prefix: string;
  suffix: string;
  pos: number;
  color: AnnotationColor;
  note: string;
  created: string;
}

export interface OutLink {
  dstId: string | null;
  dstRaw: string;
  dstTitle: string | null;
  anchor: string | null;
  broken: boolean;
}

export interface Backlink {
  srcId: string;
  srcTitle: string;
  relPath: string;
  anchor: string | null;
  context: string;
}

export interface Heading {
  level: number;
  text: string;
  slug: string;
  line: number;
}

export interface SourceInfo {
  url?: string;
  site?: string;
  author?: string;
  published?: string;
  clipped_at?: string;
}

export interface DocPayload extends DocSummary {
  body: string;
  rawHash: string;
  encoding: string;
  eol: '\n' | '\r\n';
  annotations: Annotation[];
  links: OutLink[];
  backlinks: Backlink[];
  headings: Heading[];
  source: SourceInfo | null;
  frontmatter: Record<string, unknown> | null;
  hasFrontmatter: boolean;
}

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

export interface LibraryStats {
  root: string | null;
  total: number;
  words: number;
  tags: number;
  byStatus: Record<string, number>;
  indexedAt: number | null;
  scanning: boolean;
  lastScan: {
    indexed: number;
    updated: number;
    skipped: number;
    removed: number;
    errors: number;
    total: number;
    durationMs: number;
  } | null;
}

export interface LibraryInfo {
  root: string | null;
  stats: LibraryStats;
  dirs: string[];
  config: AppConfig;
}

export interface SearchResult {
  id: string;
  title: string;
  relPath: string;
  status: DocStatus;
  tags: string[];
  progress: number;
  snippet: string;
  matchStart: number;
  matchEnd: number;
}

export interface SaveResult {
  hash: string;
  mtime: number;
  encoding: string;
  reencoded: boolean;
}

export interface ConflictDetail {
  current: {
    hash: string;
    mtime: number;
    body: string;
  };
}

export type ClipMode = 'ask' | 'skip' | 'new' | 'overwrite';

export interface ClipDuplicate {
  id: string;
  title: string;
  relPath: string;
}

export interface ClipResult {
  doc: DocSummary;
  title: string;
  url: string;
  site: string;
  imageCount: number;
  warnings: string[];
  duplicate?: ClipDuplicate;
  skipped?: boolean;
  overwritten?: boolean;
}

export type ClipJobStatus =
  | 'queued'
  | 'fetching'
  | 'extracting'
  | 'duplicate'
  | 'images'
  | 'saving'
  | 'done'
  | 'error';

export interface ClipJob {
  jobId: string;
  url: string;
  status: ClipJobStatus;
  progress: number;
  message: string;
  createdAt: number;
  updatedAt: number;
  result?: ClipResult;
  error?: { code: string; message: string };
}
