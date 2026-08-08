import type {
  BrowserDriver, SendOutcome, SendResult, SendEvidence, SendOptions, LoginSnapshot,
  CheckpointScan, InboxRow, ConnectionCard, EventPageInfo, EventStepOutcome,
  EventStepStatus, BucketRunRequest, BucketRunResult,
  EngagementOutcome, EngagementResult, Reaction, Relationship,
} from '../types.js';
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
  /** Relationship reported alongside an outcome, when a test cares which kind of `already`
   *  (or unconfirmed send) it is. Left unset so existing tests are unaffected. */
  relationship: Relationship | undefined = undefined;
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
  /** Scripted per-URL reaction outcomes; default 'done'. */
  reactScripted = new Map<string, EngagementResult>();
  /** Scripted per-URL comment outcomes; default 'done'. */
  commentScripted = new Map<string, EngagementResult>();
  /** Records the reactions this fake "placed". */
  reactLog: { url: string; reaction: Reaction }[] = [];
  /** Records the comments this fake "posted". */
  commentLog: { url: string; text: string }[] = [];
  /** Reported alongside an `already` reaction outcome. */
  existingReaction = 'like';
  /** Canonical URN this fake "reads" off the post container. Left undefined by default so
   *  tests opt in to exercising the reconciliation path. */
  observedUrn: string | undefined = undefined;

  browserOpen() { return this.open; }
  async readLoginState(): Promise<LoginSnapshot> {
    this.open = true;
    return { loggedIn: this.loggedIn, cookieExpiry: this.cookieExpiry };
  }
  async openLoginWindow() { this.open = true; this.loggedIn = true; }
  async sendConnectionRequest(url: string, message: string | null, opts?: SendOptions): Promise<SendOutcome> {
    this.open = true;
    // Faithfully mirror the real driver: an injected name wins, else the one it "reads" —
    // and the outcome reports whichever was used, because the sender stamps the profile
    // from it.
    const firstName = opts?.firstName ?? this.firstName;
    const note = message === null ? null : applyFirstName(message, firstName);
    this.sentLog.push({ url, message: note });
    const result = this.scripted.get(url) ?? 'sent';
    // 'unconfirmed' and 'already' carry evidence in the real driver too — the verdict line
    // links the screenshot, so a fake that omitted it would let those paths regress untested.
    const evidence = (result === 'checkpoint' || result === 'error' || result === 'unavailable'
      || result === 'unconfirmed' || result === 'already')
      ? this.evidence : undefined;
    return {
      result, firstName,
      ...(this.relationship ? { relationship: this.relationship } : {}),
      ...(evidence ? { evidence } : {}),
    };
  }
  async sendMessage(url: string, message: string, opts?: SendOptions): Promise<SendOutcome> {
    this.open = true;
    const firstName = opts?.firstName ?? this.firstName;
    const text = applyFirstName(message, firstName, MAX_MESSAGE);
    this.msgLog.push({ url, message: text });
    const result = this.msgScripted.get(url) ?? 'sent';
    const evidence = (result === 'checkpoint' || result === 'error' || result === 'unavailable')
      ? this.evidence : undefined;
    return {
      result,
      firstName,
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

  // --- Event invites ---
  /** Top-card info returned by openEvent. */
  eventInfo: EventPageInfo = {
    title: 'Fake Event', startsAtText: null, attending: false, canAttend: true,
  };
  /** When set, openEvent reports this status instead of 'ok'. */
  openEventStatus: EventStepStatus = 'ok';
  /** When set, attendEvent reports this status instead of 'ok'. */
  attendStatus: EventStepStatus = 'ok';
  /** Which URNs the picker will "see", per exact geo label. Anything not listed for a
   *  geo is simply absent from that filter — the normal way coverage is lost. */
  eventRowsByGeo = new Map<string, string[]>();
  /** How many rows the picker "loaded" for a geo; defaults to the row count. */
  eventRowsLoaded = new Map<string, number>();
  /** Per-geo scripted outcome override. */
  bucketOutcome = new Map<string, BucketRunResult['outcome']>();
  /** Every runEventBucket call, in order. */
  bucketCalls: BucketRunRequest[] = [];
  /** URNs actually submitted, in submit order. */
  invited: string[] = [];

  async openEvent(_eventUrl: string): Promise<EventStepOutcome> {
    this.open = true;
    if (this.openEventStatus !== 'ok') return { status: this.openEventStatus, error: 'scripted' };
    return { status: 'ok', info: this.eventInfo };
  }

  async attendEvent(): Promise<EventStepOutcome> {
    this.open = true;
    if (this.attendStatus !== 'ok') return { status: this.attendStatus, error: 'scripted' };
    this.eventInfo = { ...this.eventInfo, attending: true, canAttend: false };
    return { status: 'ok' };
  }

  async runEventBucket(req: BucketRunRequest): Promise<BucketRunResult> {
    this.open = true;
    this.bucketCalls.push(req);
    const geo = req.geoCandidates.find((c) => this.eventRowsByGeo.has(c));
    if (geo === undefined) {
      return {
        outcome: 'no_geo', geoLabel: null, geoUrn: null, rowsLoaded: 0,
        matchedUrns: [], tickedUrns: [], submitted: false,
      };
    }
    const scripted = this.bucketOutcome.get(geo);
    const visible = this.eventRowsByGeo.get(geo)!;
    const matched = visible.filter((u) => req.pending.includes(u));
    const ticked = matched.slice(0, Math.max(0, req.limit));
    if (!req.dryRun) this.invited.push(...ticked);
    return {
      outcome: scripted ?? (matched.length >= req.pending.length ? 'early_exit' : 'done'),
      geoLabel: geo,
      geoUrn: `geo-${geo}`,
      rowsLoaded: this.eventRowsLoaded.get(geo) ?? visible.length,
      matchedUrns: matched,
      tickedUrns: ticked,
      submitted: !req.dryRun && ticked.length > 0,
    };
  }

  // --- Post engagements ---
  async reactToPost(postUrl: string, reaction: Reaction): Promise<EngagementOutcome> {
    this.open = true;
    this.reactLog.push({ url: postUrl, reaction });
    const result = this.reactScripted.get(postUrl) ?? 'done';
    const evidence = (result === 'checkpoint' || result === 'error' || result === 'unavailable')
      ? this.evidence : undefined;
    return {
      result,
      ...(result === 'already' ? { existingReaction: this.existingReaction } : {}),
      ...(this.observedUrn ? { observedUrn: this.observedUrn } : {}),
      ...(evidence ? { evidence } : {}),
    };
  }

  async commentOnPost(postUrl: string, text: string): Promise<EngagementOutcome> {
    this.open = true;
    this.commentLog.push({ url: postUrl, text });
    const result = this.commentScripted.get(postUrl) ?? 'done';
    const evidence = (result === 'checkpoint' || result === 'error' || result === 'unavailable')
      ? this.evidence : undefined;
    return { result, ...(evidence ? { evidence } : {}) };
  }

  async close() { this.open = false; }
}
