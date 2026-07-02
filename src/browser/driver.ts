import type { BrowserDriver, SendOutcome, SendResult, SendEvidence, LoginSnapshot, CheckpointScan } from '../types.js';
import { applyFirstName } from '../core/message.js';
export type { BrowserDriver };

/** In-memory driver for testing workers without a real browser. */
export class FakeDriver implements BrowserDriver {
  loggedIn = true;
  open = false;
  cookieExpiry: string | null = null;
  checkpoint = false;
  /** Attached to checkpoint/error outcomes, mirroring the real driver's capture. */
  evidence: SendEvidence | undefined;
  pending: string[] = [];
  connections: string[] = [];
  scripted = new Map<string, SendResult>();
  /** Name this fake "reads" from profiles; {firstName} is substituted with it. */
  firstName = 'Test';
  /** Records the note as actually sent (after {firstName} substitution). */
  sentLog: { url: string; message: string | null }[] = [];

  browserOpen() { return this.open; }
  async readLoginState(): Promise<LoginSnapshot> {
    this.open = true;
    return { loggedIn: this.loggedIn, cookieExpiry: this.cookieExpiry };
  }
  async openLoginWindow() { this.open = true; this.loggedIn = true; }
  async sendConnectionRequest(url: string, message: string | null): Promise<SendOutcome> {
    this.open = true;
    // Faithfully mirror the real driver: substitute {firstName} with the name it reads.
    const note = message === null ? null : applyFirstName(message, this.firstName);
    this.sentLog.push({ url, message: note });
    const result = this.scripted.get(url) ?? 'sent';
    const evidence = (result === 'checkpoint' || result === 'error') ? this.evidence : undefined;
    return { result, firstName: this.firstName, ...(evidence ? { evidence } : {}) };
  }
  async readPendingInvites() { return this.pending; }
  async readRecentConnections() { return this.connections; }
  async checkpointScan(): Promise<CheckpointScan> {
    return this.checkpoint
      ? { hit: true, via: 'url', matched: 'linkedin.com/checkpoint/', url: 'https://www.linkedin.com/checkpoint/challenge/fake', title: '' }
      : { hit: false, via: null, matched: null, url: 'https://www.linkedin.com/feed/', title: '' };
  }
  async close() { this.open = false; }
}
