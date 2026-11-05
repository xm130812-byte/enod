import type { ServerResponse } from 'node:http';

export interface ServerEvent {
  type: string;
  data: unknown;
}

/** SSE 广播：index-progress / doc-changed / doc-removed / clip-progress */
export class EventHub {
  private clients = new Set<ServerResponse>();
  private heartbeat: NodeJS.Timeout | null = null;

  constructor() {
    this.heartbeat = setInterval(() => {
      for (const res of this.clients) {
        try {
          res.write(': ping\n\n');
        } catch {
          this.clients.delete(res);
        }
      }
    }, 25_000);
    this.heartbeat.unref?.();
  }

  add(res: ServerResponse): void {
    this.clients.add(res);
    res.on('close', () => this.clients.delete(res));
    res.on('error', () => this.clients.delete(res));
  }

  remove(res: ServerResponse): void {
    this.clients.delete(res);
  }

  get size(): number {
    return this.clients.size;
  }

  broadcast(type: string, data: unknown): void {
    const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of this.clients) {
      try {
        res.write(payload);
      } catch {
        this.clients.delete(res);
      }
    }
  }

  closeAll(): void {
    for (const res of this.clients) {
      try {
        res.end();
      } catch {
        /* ignore */
      }
    }
    this.clients.clear();
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }
}
