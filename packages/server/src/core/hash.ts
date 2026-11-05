import { createHash } from 'node:crypto';

/** 文件内容指纹；空内容也给固定值，方便比较 */
export function hashBuffer(data: Buffer | string): string {
  return createHash('sha1').update(data).digest('hex');
}

export function hashText(text: string): string {
  return hashBuffer(Buffer.from(text, 'utf8'));
}

export function shortHash(data: Buffer | string): string {
  return hashBuffer(data).slice(0, 16);
}
