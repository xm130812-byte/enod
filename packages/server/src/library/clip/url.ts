/**
 * 剪藏 URL 工具：规范化、去重键、内网地址拦截。
 *
 * 只接受 http/https；处理用户直接粘贴「example.com/a」这种没有 scheme 的输入。
 * 去重键会去掉 fragment 与常见跟踪参数，并归一化末尾斜杠。
 */
import { isIP } from 'node:net';

const TRACKING_PARAMS = [
  /^utm_/i,
  /^fbclid$/i,
  /^gclid$/i,
  /^yclid$/i,
  /^mc_cid$/i,
  /^mc_eid$/i,
  /^igshid$/i,
  /^spm/i,
  /^scm$/i,
  /^share_token$/i,
  /^from_source$/i,
];

export interface ClipUrl {
  url: URL;
  /** 规范化后的完整地址（写入 source.url） */
  href: string;
  /** 去重键（忽略 fragment / 跟踪参数 / 末尾斜杠） */
  key: string;
}

function stripWrapping(input: string): string {
  let text = input.trim();
  text = text.replace(/^[\s"'`<([{]+/, '').replace(/[\s"'`>)\]},.;，。；）]+$/, '');
  return text;
}

/** 用户输入 → 合法 URL；非法返回 null。没有 scheme 时按 https 补全。 */
export function parseClipUrl(input: string, allowPrivate = false): URL | null {
  const cleaned = stripWrapping(input).replace(/[\u0000-\u001f\u007f]/g, '');
  if (!cleaned) return null;

  let candidate = cleaned;
  if (candidate.startsWith('//')) candidate = `https:${candidate}`;
  else if (!/^[a-z][a-z0-9+.-]*:/i.test(candidate)) candidate = `https://${candidate}`;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!url.hostname || url.username || url.password) return null;
  if (url.port && !/^\d{1,5}$/.test(url.port)) return null;
  if (!allowPrivate && isPrivateHost(url.hostname)) return null;
  return url;
}

export function normalizeClipUrl(input: string, allowPrivate = false): ClipUrl | null {
  const url = parseClipUrl(input, allowPrivate);
  if (!url) return null;
  url.hash = '';
  return { url, href: url.href, key: clipKey(url) };
}

export function clipKey(input: string | URL, allowPrivate = true): string {
  let url: URL;
  if (input instanceof URL) {
    url = new URL(input.href);
  } else {
    const parsed = parseClipUrl(input, allowPrivate);
    if (!parsed) return '';
    url = parsed;
  }
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMS.some((re) => re.test(key))) url.searchParams.delete(key);
  }
  let key = url.href;
  // 根路径之外的末尾斜杠不参与去重；query 保持原顺序。
  if (url.pathname.length > 1) key = key.replace(/\/$/, '');
  return key;
}

/** 本地/内网地址拦截（防止剪藏请求打到回环、内网或云元数据服务） */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host) return true;
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host === 'metadata.google.internal'
  ) {
    return true;
  }

  const version = isIP(host);
  if (version === 4) return isPrivateIpv4(host);
  if (version === 6) return isPrivateIpv6(host);
  return false;
}

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 169 && b === 254) return true; // link-local / 云元数据
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true; // multicast / reserved / broadcast
  return false;
}

function isPrivateIpv6(raw: string): boolean {
  const ip = raw.split('%')[0]!.toLowerCase();
  if (ip === '::' || ip === '::1') return true;
  if (ip.startsWith('fe8') || ip.startsWith('fe9') || ip.startsWith('fea') || ip.startsWith('feb')) return true;
  if (ip.startsWith('fc') || ip.startsWith('fd')) return true;
  if (ip.startsWith('::ffff:')) {
    const mapped = ip.slice('::ffff:'.length);
    if (isIP(mapped) === 4) return isPrivateIpv4(mapped);
    const hex = mapped.split(':');
    if (hex.length === 2) {
      const high = parseInt(hex[0]!, 16);
      const low = parseInt(hex[1]!, 16);
      if (Number.isFinite(high) && Number.isFinite(low)) {
        return isPrivateIpv4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
      }
    }
  }
  return false;
}

/**
 * 用文章页地址解析相对链接；失败返回 null。
 *
 * 允许 file: 是因为书库里的本地 .html 用 file:// 作基准，相对图片必须先解析成 file://
 * 才能在后续步骤里改写成库内相对路径；剪藏走网络抓取时 file:// 会在下载环节被拒掉。
 */
export function resolveUrl(raw: string | null | undefined, base: string): string | null {
  if (!raw) return null;
  const value = raw.trim();
  if (!value || value.startsWith('data:') || value.startsWith('blob:')) return null;
  try {
    const resolved = new URL(value, base);
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:' && resolved.protocol !== 'file:') {
      return null;
    }
    return resolved.href;
  } catch {
    return null;
  }
}
