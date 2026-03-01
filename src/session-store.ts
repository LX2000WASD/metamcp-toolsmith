export type Closable = { close: () => Promise<void> | void };

export interface SessionEntry<TTransport extends Closable> {
  transport: TTransport;
  createdAt: number;
  updatedAt: number;
}

export class SessionStore<TTransport extends Closable> {
  private readonly sessions = new Map<string, SessionEntry<TTransport>>();

  constructor(private readonly ttlMs: number) {}

  getSessionIds(): string[] {
    return Array.from(this.sessions.keys());
  }

  get(sessionId: string): SessionEntry<TTransport> | undefined {
    return this.sessions.get(sessionId);
  }

  set(sessionId: string, transport: TTransport): void {
    const now = Date.now();
    this.sessions.set(sessionId, { transport, createdAt: now, updatedAt: now });
  }

  touch(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    entry.updatedAt = Date.now();
  }

  async closeAndDelete(sessionId: string): Promise<boolean> {
    const entry = this.sessions.get(sessionId);
    if (!entry) return false;
    this.sessions.delete(sessionId);
    await entry.transport.close();
    return true;
  }

  async cleanupExpired(): Promise<number> {
    if (this.ttlMs <= 0) return 0;

    const now = Date.now();
    const toClose: string[] = [];

    for (const [sessionId, entry] of this.sessions.entries()) {
      if (now - entry.updatedAt > this.ttlMs) {
        toClose.push(sessionId);
      }
    }

    await Promise.allSettled(toClose.map((id) => this.closeAndDelete(id)));
    return toClose.length;
  }

  async closeAll(): Promise<void> {
    const ids = this.getSessionIds();
    await Promise.allSettled(ids.map((id) => this.closeAndDelete(id)));
  }
}
