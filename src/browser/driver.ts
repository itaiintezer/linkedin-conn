import type { BrowserDriver, SendOutcome, SendResult, SendEvidence, LoginSnapshot, CheckpointScan, InboxRow, ConnectionCard } from '../types.js';
import { applyFirstName, MAX_MESSAGE } from '../core/message.js';
export type { BrowserDriver };

const slug = (url: string) => url.match(/\/in\/([^/?#]+)/)?.[1] ?? 'x';

/** In-memory driver for testing workers without a real browser. */
export class FakeDriver implements BrowserDriver {
  loggedIn = true;
  open = false;
  cookieExpiry: string | null = null;
  checkpoint = false;
  /** Attached to checkpoint/error outcomes, mirroring the real driver's capture. */
  evidence: SendEvidence | undefined;
  pending: string[] = [];
  scripted = new Map<string, SendResult>();
  /** Name this fake "reads" from profiles; {firstName} is substituted with it. */
  firstName = 'Test';
  /** Records the note as actually sent (after {firstName} substitution). */
  sentLog: { url: string; message: string | null }[] = [];
  /** Scripted per-URL message outcomes; default 'sent'. */
  msgScripted = new Map<string, SendResult>();
  /** Records messages "sent" (after {firstName} substitution). */
  msgLog: { url: string; message: string }[] = [];
  /** Full name this fake "reads" from profiles. */
  fullName = 'Test Person';
  /** Inbox rows returned by readInboxSnapshot. */
  inboxRows: InboxRow[] = [];
  /** When set, readInboxSnapshot throws (read-failure paths). */
  inboxError: string | null = null;
  /** Cards returned by readConnectionCards (roster sync). */
  connectionCards: ConnectionCard[] = [];
  /** When set, readConnectionCards throws (read-failure paths). */
  connectionCardsError: string | null = null;

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
    const evidence = (result === 'checkpoint' || result === 'error' || result === 'unavailable')
      ? this.evidence : undefined;
    return { result, firstName: this.firstName, ...(evidence ? { evidence } : {}) };
  }
  async sendMessage(url: string, message: string): Promise<SendOutcome> {
    this.open = true;
    const text = applyFirstName(message, this.firstName, MAX_MESSAGE);
    this.msgLog.push({ url, message: text });
    const result = this.msgScripted.get(url) ?? 'sent';
    const evidence = (result === 'checkpoint' || result === 'error' || result === 'unavailable')
      ? this.evidence : undefined;
    return {
      result,
      firstName: this.firstName,
      fullName: this.fullName,
      ...(result === 'sent' ? { threadUrl: `https://www.linkedin.com/messaging/thread/fake-${slug(url)}/` } : {}),
      ...(evidence ? { evidence } : {}),
    };
  }

  async readInboxSnapshot(): Promise<InboxRow[]> {
    this.open = true;
    if (this.inboxError) throw new Error(this.inboxError);
    return this.inboxRows;
  }
  async readPendingInvites() { return this.pending; }
  async readConnectionCards(): Promise<ConnectionCard[]> {
    this.open = true;
    if (this.connectionCardsError) throw new Error(this.connectionCardsError);
    return this.connectionCards;
  }
  async checkpointScan(): Promise<CheckpointScan> {
    return this.checkpoint
      ? { hit: true, via: 'url', matched: 'linkedin.com/checkpoint/', url: 'https://www.linkedin.com/checkpoint/challenge/fake', title: '' }
      : { hit: false, via: null, matched: null, url: 'https://www.linkedin.com/feed/', title: '' };
  }
  async close() { this.open = false; }
}
