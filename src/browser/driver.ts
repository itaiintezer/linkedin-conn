import type { BrowserDriver, SendOutcome, SendResult } from '../types.js';
export type { BrowserDriver };

/** In-memory driver for testing workers without a real browser. */
export class FakeDriver implements BrowserDriver {
  loggedIn = true;
  pending: string[] = [];
  connections: string[] = [];
  scripted = new Map<string, SendResult>();
  sentLog: { url: string; message: string | null }[] = [];

  async isLoggedIn() { return this.loggedIn; }
  async openLoginWindow() { this.loggedIn = true; }
  async sendConnectionRequest(url: string, message: string | null): Promise<SendOutcome> {
    this.sentLog.push({ url, message });
    const result = this.scripted.get(url) ?? 'sent';
    return { result, firstName: 'Test' };
  }
  async readPendingInvites() { return this.pending; }
  async readRecentConnections() { return this.connections; }
  async close() {}
}
