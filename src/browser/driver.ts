import type { BrowserDriver, SendOutcome, SendResult } from '../types.js';
import { applyFirstName } from '../core/message.js';
export type { BrowserDriver };

/** In-memory driver for testing workers without a real browser. */
export class FakeDriver implements BrowserDriver {
  loggedIn = true;
  pending: string[] = [];
  connections: string[] = [];
  scripted = new Map<string, SendResult>();
  /** Name this fake "reads" from profiles; {firstName} is substituted with it. */
  firstName = 'Test';
  /** Records the note as actually sent (after {firstName} substitution). */
  sentLog: { url: string; message: string | null }[] = [];

  async isLoggedIn() { return this.loggedIn; }
  async openLoginWindow() { this.loggedIn = true; }
  async sendConnectionRequest(url: string, message: string | null): Promise<SendOutcome> {
    // Faithfully mirror the real driver: substitute {firstName} with the name it reads.
    const note = message === null ? null : applyFirstName(message, this.firstName);
    this.sentLog.push({ url, message: note });
    const result = this.scripted.get(url) ?? 'sent';
    return { result, firstName: this.firstName };
  }
  async readPendingInvites() { return this.pending; }
  async readRecentConnections() { return this.connections; }
  async close() {}
}
