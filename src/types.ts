import type { CheckpointScan } from './core/checkpoint.js';
export type { CheckpointScan };

export type CampaignKind = 'invite' | 'message';

export type ProfileStatus =
  | 'queued' | 'scheduled' | 'sending' | 'sent'
  | 'accepted' | 'replied' | 'expired' | 'skipped' | 'failed' | 'needs_attention';

/** Why a skipped profile was skipped (terminal — the engine never retries these). */
export type SkipReason =
  | 'already_connected' | 'email_required' | 'not_found' | 'unavailable' | 'dismissed'
  | 'not_connected';

export type EventType = 'sent' | 'accepted' | 'replied' | 'expired' | 'skipped' | 'failed';

export interface Cohort {
  id: number;
  name: string;
  kind: CampaignKind;
  message_template: string | null;
  allow_no_note: number; // 0 | 1 (SQLite has no bool)
  archived: number;      // 0 | 1
  created_at: string;    // ISO
}

export interface Profile {
  id: number;
  cohort_id: number;
  kind: CampaignKind;
  profile_url: string;       // normalized
  first_name: string | null;
  custom_message: string | null;
  status: ProfileStatus;
  attempts: number;
  last_error: string | null;
  skip_reason: SkipReason | null;
  scheduled_for: string | null; // ISO
  sent_at: string | null;
  accepted_at: string | null;
  full_name: string | null;
  thread_url: string | null;
  replied_at: string | null;
  resolved_at: string | null;
  priority: number;
  created_at: string;
}

export interface Settings {
  id: 1;
  workday_start_hour: number;
  workday_end_hour: number;
  weekdays_only: number;
  weekly_cap: number;
  batch_size: number;
  batches_per_day: number;
  msg_weekly_cap: number;
  msg_batch_size: number;
  msg_batches_per_day: number;
  reply_checks_per_day: number;
  roster_sync_per_day: number;
  /** Apify credential. Never leaves the process over HTTP — see publicSettings(). */
  apify_api_key: string | null;
  enrich_ttl_days: number;
  enrich_concurrency: number;
  note_quota_exhausted: number;
  min_delay_ms: number;
  max_delay_ms: number;
  paused: number;
  pause_reason: string | null;
  onboarded: number;
  failure_threshold: number;
  expiry_days: number;
}

export type SendResult =
  | 'sent' | 'already' | 'unavailable' | 'note_quota' | 'checkpoint' | 'error'
  | 'email_required' | 'not_found' | 'weekly_limit' | 'not_connected';

/** What the browser saw when a send went wrong — captured for the operator. */
export interface SendEvidence {
  pageUrl: string;
  /** Checkpoint pattern that matched (see core/checkpoint.ts), if any. */
  matched?: string | null;
  /** Screenshot file name under data/incidents/ (served at /incidents/<name>). */
  screenshot?: string | null;
}

export interface SendOutcome {
  result: SendResult;
  firstName?: string;
  fullName?: string;
  threadUrl?: string;
  error?: string;
  evidence?: SendEvidence;
}

export interface BrowserDriver {
  /** No side effects: whether the browser context is currently open. */
  browserOpen(): boolean;
  /** Read the li_at cookie. Opens the context if needed (callers that must not
   *  open the browser guard with browserOpen() first). */
  readLoginState(): Promise<LoginSnapshot>;
  openLoginWindow(): Promise<void>;
  // message === null => send a bare request (no note)
  sendConnectionRequest(url: string, message: string | null): Promise<SendOutcome>;
  /** Send a plain message to an existing 1st-degree connection. `message` still
   *  contains {firstName}; the driver substitutes the live name it reads. */
  sendMessage(url: string, message: string): Promise<SendOutcome>;
  /** One-page scan of the messaging inbox conversation list. */
  readInboxSnapshot(): Promise<InboxRow[]>;
  readPendingInvites(): Promise<string[]>;     // normalized profile URLs
  /** One scroll-loaded read of the connections page, returning URL + display name per card.
   *  The single source of connection discovery: roster-sync calls this, and acceptance
   *  resolves against the roster it fills rather than scraping again. */
  readConnectionCards(): Promise<ConnectionCard[]>;
  /** Scan the currently-loaded page for a checkpoint/captcha (url + what matched). */
  checkpointScan(): Promise<CheckpointScan>;
  close(): Promise<void>;
}

export type GuardrailReason = 'checkpoint' | 'login_lost' | 'repeated_failures';

export interface AppState {
  id: 1;
  login_logged_in: number;        // 0 | 1
  login_cookie_expiry: string | null;  // ISO
  login_confirmed_at: string | null;   // ISO
  guardrail_tripped: number;      // 0 | 1
  guardrail_reason: GuardrailReason | null;
  guardrail_detail: string | null;
  guardrail_tripped_at: string | null; // ISO
  failure_streak: number;
  acceptance_checked_at: string | null; // ISO, last successful acceptance read
  replies_checked_at: string | null;    // ISO, last successful reply-check read
  roster_synced_at: string | null;      // ISO, last successful roster read
  connections_seeded_at: string | null; // ISO, one-time seed from existing profiles
}

/** A point-in-time read of LinkedIn auth from the browser's li_at cookie. */
export interface LoginSnapshot {
  loggedIn: boolean;
  cookieExpiry: string | null;    // ISO, or null for a session cookie / unknown
}

/** One conversation row from the messaging inbox list. */
export interface InboxRow {
  name: string;        // participant display name as rendered
  snippet: string;     // last-message preview text
  youSentLast: boolean; // snippet started with the "You:" prefix
  /** Thread URL from the row's anchor href, when the driver can extract one. Preferred
   *  match key over `name` — exact and unaffected by display-name rendering drift. */
  threadUrl?: string;
}

export type ConnectionSource = 'csv' | 'urls' | 'scrape' | 'migration';

/** Lifecycle of a connection's Apify enrichment (phase 2 drives this; phase 1 only writes 'pending'). */
export type EnrichStatus = 'pending' | 'enriching' | 'enriched' | 'empty' | 'failed';

/** One person you are connected to. Independent of cohorts and campaign status. */
export interface Connection {
  id: number;
  profile_url: string;              // normalized
  linkedin_id: string | null;
  public_identifier: string | null;
  full_name: string | null;
  first_name: string | null;
  last_name: string | null;
  headline: string | null;
  location_raw: string | null;
  location_city: string | null;
  location_region: string | null;
  location_country: string | null;
  location_country_code: string | null;   // ISO-3166 alpha-2, from Apify's parsed location
  current_title: string | null;
  current_company: string | null;
  /** ISO date. ONLY from the CSV export or a known accepted_at — never inferred. */
  connected_on: string | null;
  source: ConnectionSource;
  first_seen_at: string;
  last_seen_at: string;
  enrich_status: EnrichStatus;
  enrich_attempts: number;
  enrich_error: string | null;
  enriched_at: string | null;
  raw_json: string | null;
  created_at: string;
}

/** An incoming roster row from any non-Apify source (CSV, URL list, connection card). */
export interface ConnectionInput {
  profile_url: string;              // normalized
  full_name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  current_title?: string | null;
  current_company?: string | null;
  connected_on?: string | null;
}

/** One card read off the LinkedIn connections page. */
export interface ConnectionCard {
  url: string;                      // normalized
  name: string | null;
}

/* ---------- Apify enrichment (phase 2) ---------- */

/** Apify uses `position` for the role title, not `title`. */
export interface ApifyPosition {
  position?: string | null;
  title?: string | null;
  companyName?: string | null;
  location?: unknown;
  employmentType?: string | null;
  duration?: string | null;
  startDate?: unknown;
  endDate?: unknown;
  description?: string | null;
}

/**
 * The subset of Apify's ~50-field payload we read. Shapes verified against live runs on
 * 2026-07-31 — see "Apify payload findings" in the design doc.
 */
export interface ApifyProfile {
  id?: string | null;                    // stable LinkedIn URN; slug-change merge key
  publicIdentifier?: string | null;
  linkedinUrl?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  name?: string | null;
  headline?: string | null;
  about?: string | null;
  /** Apify PRE-PARSES this. Never comma-split linkedinText yourself. Older payloads
   *  (and the reference Python script's cache) carry a bare string instead. */
  location?: {
    linkedinText?: string | null;
    countryCode?: string | null;
    parsed?: {
      text?: string | null; city?: string | null; state?: string | null;
      country?: string | null; countryFull?: string | null; countryCode?: string | null;
    } | null;
  } | string | null;
  currentPosition?: ApifyPosition[] | null;
  experience?: ApifyPosition[] | null;
  education?: Record<string, unknown>[] | null;
  skills?: ({ name?: string | null } | string)[] | null;
  topSkills?: ({ name?: string | null } | string)[] | null;
  certifications?: Record<string, unknown>[] | null;
  languages?: ({ name?: string | null } | string)[] | null;
  originalQuery?: { query?: string | null } | null;
}

/** What extraction produces: indexed scalars, a compact payload, and the FTS document. */
export interface EnrichedProfile {
  linkedin_id: string | null;
  public_identifier: string | null;
  full_name: string | null;
  first_name: string | null;
  last_name: string | null;
  headline: string | null;
  location_raw: string | null;
  location_city: string | null;
  location_region: string | null;
  location_country: string | null;
  location_country_code: string | null;
  current_title: string | null;
  current_company: string | null;
  /** Cherry-picked payload, stored as raw_json. */
  compact: Record<string, unknown>;
  /** Flattened searchable text for connections_fts. */
  doc: string;
}

export type EnrichOutcome =
  | { kind: 'enriched'; profile: EnrichedProfile }
  | { kind: 'empty' }                       // silent-empty shell: 200 OK, no signal
  | { kind: 'failed'; error: string };
