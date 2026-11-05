import iconv from 'iconv-lite';

export type FileEncoding = 'utf8' | 'utf8-bom' | 'utf16le' | 'utf16be' | 'gb18030';

export interface DecodedFile {
  text: string;
  encoding: FileEncoding;
  eol: '\n' | '\r\n';
}

const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

function isValidUtf8(buf: Buffer): boolean {
  try {
    utf8Decoder.decode(buf);
    return true;
  } catch {
    return false;
  }
}

function utf16LooksPlausible(buf: Buffer): 'utf16le' | 'utf16be' | null {
  if (buf.length < 4 || buf.length % 2 !== 0) return null;
  let evenZeros = 0;
  let oddZeros = 0;
  const sample = Math.min(buf.length, 4096);
  for (let i = 0; i < sample; i += 2) {
    if (buf[i] === 0) evenZeros++;
    if (buf[i + 1] === 0) oddZeros++;
  }
  const pairs = sample / 2;
  // 拉丁/中文文本用 UTF-16 编码时，高字节大量为 0
  if (oddZeros / pairs > 0.4 && evenZeros / pairs < 0.1) return 'utf16le';
  if (evenZeros / pairs > 0.4 && oddZeros / pairs < 0.1) return 'utf16be';
  return null;
}

/** 探测编码：BOM 优先，其次严格 UTF-8，其次 UTF-16 启发式，最后 GB18030 */
export function detectEncoding(buf: Buffer): FileEncoding {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return 'utf8-bom';
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return 'utf16le';
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return 'utf16be';
  if (isValidUtf8(buf)) return 'utf8';
  const utf16 = utf16LooksPlausible(buf);
  if (utf16) return utf16;
  return 'gb18030';
}

export function detectEol(text: string): '\n' | '\r\n' {
  let crlf = 0;
  let lf = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      if (i > 0 && text.charCodeAt(i - 1) === 13) crlf++;
      else lf++;
    }
  }
  return crlf > lf ? '\r\n' : '\n';
}

export function decodeFile(buf: Buffer): DecodedFile {
  const encoding = detectEncoding(buf);
  let text: string;
  switch (encoding) {
    case 'utf8-bom':
      text = iconv.decode(buf.subarray(3), 'utf8');
      break;
    case 'utf16le':
      text = iconv.decode(buf.subarray(2), 'utf16-le');
      break;
    case 'utf16be':
      text = iconv.decode(buf.subarray(2), 'utf16-be');
      break;
    case 'gb18030':
      text = iconv.decode(buf, 'gb18030');
      break;
    case 'utf8':
    default:
      text = iconv.decode(buf, 'utf8');
      break;
  }
  // 统一 NFC 只用于比较；文本本身不改写
  const eol = detectEol(text);
  return { text: text.normalize('NFC'), encoding, eol };
}

/** 按原编码（含 BOM）编码回 Buffer */
export function encodeFile(text: string, encoding: FileEncoding): Buffer {
  switch (encoding) {
    case 'utf8-bom':
      return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), iconv.encode(text, 'utf8')]);
    case 'utf16le':
      return Buffer.concat([Buffer.from([0xff, 0xfe]), iconv.encode(text, 'utf16-le')]);
    case 'utf16be':
      return Buffer.concat([Buffer.from([0xfe, 0xff]), iconv.encode(text, 'utf16-be')]);
    case 'gb18030':
      return iconv.encode(text, 'gb18030');
    case 'utf8':
    default:
      return iconv.encode(text, 'utf8');
  }
}

/** 把文本里的换行统一成文件原本的 EOL，避免把 CRLF 文件改成 LF */
export function applyEol(text: string, eol: '\n' | '\r\n'): string {
  const normalized = text.replace(/\r\n/g, '\n');
  return eol === '\n' ? normalized : normalized.replace(/\n/g, '\r\n');
}
