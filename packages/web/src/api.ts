import type {
  Annotation,
  AppConfig,
  ClipJob,
  ClipMode,
  DocPayload,
  DocStatus,
  DocSummary,
  LibraryInfo,
  LibraryStats,
  SaveResult,
  SearchResult,
} from './types.ts';

const BASE = '/api/v1';

export class ApiError extends Error {
  status: number;
  code: string;
  detail: unknown;

  constructor(status: number, code: string, message: string, detail?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  headers?: Record<string, string>;
  raw?: BodyInit;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  let body: BodyInit | undefined;

  if (options.raw !== undefined) {
    body = options.raw;
  } else if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  }
  if (method !== 'GET') headers['X-Reader-Client'] = '1';

  const res = await fetch(`${BASE}${path}`, { method, headers, body });
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    const err = data as { error?: { code?: string; message?: string; detail?: unknown } } | null;
    throw new ApiError(
      res.status,
      err?.error?.code ?? `http-${res.status}`,
      err?.error?.message ?? `请求失败 (${res.status})`,
      err?.error?.detail,
    );
  }
  return data as T;
}

export interface UnlinkedMention {
  id: string;
  title: string;
  relPath: string;
  status: DocStatus;
  snippet: string;
}

export const api = {
  health: () => request<{ ok: boolean; version: string; port: number }>('/health'),

  library: () => request<LibraryInfo>('/library'),
  openLibrary: (path: string) => request<{ ok: boolean; root: string }>('/library/open', { method: 'POST', body: { path } }),
  stats: () => request<LibraryStats>('/library/stats'),
  rescan: () => request<{ ok: boolean; result: unknown }>('/library/rescan', { method: 'POST' }),
  dirs: () => request<{ dirs: string[] }>('/library/dirs'),

  docs: (query: { status?: string; tag?: string; sort?: string; q?: string } = {}) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v) params.set(k, v);
    const qs = params.toString();
    return request<DocSummary[]>(`/docs${qs ? `?${qs}` : ''}`);
  },
  doc: (id: string) => request<DocPayload>(`/docs/${encodeURIComponent(id)}`),
  createDoc: (input: { dir?: string; title?: string; content?: string; tags?: string[] }) =>
    request<DocPayload>('/docs', { method: 'POST', body: input }),
  saveDoc: (
    id: string,
    input: {
      body?: string;
      baseHash?: string;
      title?: string;
      tags?: string[];
      reader?: { status?: DocStatus; progress?: number };
    },
  ) => request<SaveResult>(`/docs/${encodeURIComponent(id)}`, { method: 'PATCH', body: input }),
  setStatus: (id: string, status: DocStatus) =>
    request<SaveResult>(`/docs/${encodeURIComponent(id)}/status`, { method: 'POST', body: { status } }),
  moveDoc: (id: string, input: { targetDir?: string; newName?: string; updateLinks?: boolean }) =>
    request<DocPayload>(`/docs/${encodeURIComponent(id)}/move`, { method: 'POST', body: input }),
  deleteDoc: (id: string) =>
    request<{ trashedTo: string }>(`/docs/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  addAnnotation: (
    id: string,
    input: { exact: string; prefix?: string; suffix?: string; pos?: number; color?: string; note?: string; baseHash?: string },
  ) =>
    request<{ annotation: Annotation; hash: string; count: number }>(`/docs/${encodeURIComponent(id)}/annotations`, {
      method: 'POST',
      body: input,
    }),
  updateAnnotation: (id: string, aid: string, patch: { note?: string; color?: string }) =>
    request<{ annotation: Annotation; hash: string; count: number }>(
      `/docs/${encodeURIComponent(id)}/annotations/${encodeURIComponent(aid)}`,
      { method: 'PATCH', body: patch },
    ),
  deleteAnnotation: (id: string, aid: string) =>
    request<{ hash: string; count: number }>(
      `/docs/${encodeURIComponent(id)}/annotations/${encodeURIComponent(aid)}`,
      { method: 'DELETE' },
    ),

  search: (q: string, limit = 30) =>
    request<SearchResult[]>(`/search?q=${encodeURIComponent(q)}&limit=${limit}`),
  mentions: (id: string) => request<UnlinkedMention[]>(`/docs/${encodeURIComponent(id)}/mentions`),
  tags: () => request<{ tag: string; count: number }[]>('/tags'),
  preview: (target: string) => request<{ id: string; title: string; excerpt: string } | { notFound: true }>(`/preview?target=${encodeURIComponent(target)}`),

  clip: (input: { url: string; mode?: ClipMode }) =>
    request<{ jobId: string; status: string }>('/clip', { method: 'POST', body: input }),
  clipJob: (jobId: string) => request<ClipJob>(`/clip/${encodeURIComponent(jobId)}`),

  config: () => request<AppConfig>('/config'),
  updateConfig: (patch: Partial<AppConfig>) => request<AppConfig>('/config', { method: 'PATCH', body: patch }),

  uploadAsset: async (docId: string, file: Blob, filename: string): Promise<{ relPath: string; url: string; size: number }> =>
    request<{ relPath: string; url: string; size: number }>(
      `/assets?docId=${encodeURIComponent(docId)}&name=${encodeURIComponent(filename)}`,
      { method: 'POST', raw: file, headers: { 'Content-Type': file.type || 'image/png' } },
    ),

  fileUrl: (relPath: string) => `${BASE}/files?path=${encodeURIComponent(relPath)}`,
  eventsUrl: () => `${BASE}/events`,
};
