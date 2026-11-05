/**
 * ULID —— 文档身份，不依赖路径。
 * 48bit 时间戳 + 80bit 随机，Crockford Base32，字典序即时间序。
 */
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ENCODING_LEN = 32;
const TIME_LEN = 10;
const RANDOM_LEN = 16;
const RANDOM_MAX = Math.pow(2, 48) - 1;

let lastTime = -1;
let lastRandom: number[] = [];

function encodeTime(now: number): string {
  let str = '';
  let time = now;
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    const mod = time % ENCODING_LEN;
    str = ENCODING[mod] + str;
    time = (time - mod) / ENCODING_LEN;
  }
  return str;
}

function randomBytes(len: number): number[] {
  const out = new Array<number>(len);
  for (let i = 0; i < len; i++) out[i] = Math.floor(Math.random() * ENCODING_LEN);
  return out;
}

function incrementRandom(chars: number[]): number[] {
  const out = chars.slice();
  for (let i = out.length - 1; i >= 0; i--) {
    const v = out[i]!;
    if (v < ENCODING_LEN - 1) {
      out[i] = v + 1;
      return out;
    }
    out[i] = 0;
  }
  return randomBytes(RANDOM_LEN);
}

/** 生成一个 ULID，同一毫秒内单调递增 */
export function ulid(now: number = Date.now()): string {
  let time = now;
  if (time === lastTime) {
    lastRandom = incrementRandom(lastRandom);
  } else {
    lastTime = time;
    lastRandom = randomBytes(RANDOM_LEN);
  }
  return encodeTime(time) + lastRandom.map((v) => ENCODING[v]).join('');
}

export function isUlid(value: string): boolean {
  return /^[0-9A-HJKMNP-TV-Z]{26}$/.test(value);
}

/** 短 id（批注等），26 位保持统一 */
export function shortId(): string {
  return ulid();
}

export { RANDOM_MAX };
