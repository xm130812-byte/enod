export class HttpError extends Error {
  status: number;
  code: string;
  detail: unknown;

  constructor(status: number, code: string, message: string, detail?: unknown) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

export function isHttpError(err: unknown): err is HttpError {
  return err instanceof HttpError;
}

export function notFound(message = '资源不存在'): HttpError {
  return new HttpError(404, 'not-found', message);
}

export function badRequest(message: string, detail?: unknown): HttpError {
  return new HttpError(400, 'bad-request', message, detail);
}
