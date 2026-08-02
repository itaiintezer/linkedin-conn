import type { CheckpointScan } from './core/checkpoint.js';
export type { CheckpointScan };

// Derived from the CAMPAIGN_KINDS list so the runtime validator and this type can never
// drift. Imported as well as re-exported: `export type { X } from` alone would not bring
// the name into this file's scope, and the interfaces below use it.
// Re-exported here because ~15 modules already import CampaignKind from types.js.
import type { CampaignKind } from './core/campaign-kind.js';
export type { CampaignKind };

// Derived from the REACTIONS list so the runtime validator and this type can never drift.
// Imported as well as re-exported: `export type { X } from` alone would not bring the name
// into this file's scope, and the Engagement interface below uses it.
import type { Reaction } from './core/engagement-action.js';
export type { Reaction };

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
  events_per_day: number;
  event_invite_cap: number;
  event_bucket_ceiling: number;
  event_run_budget_minutes: number;
  event_shard_threshold: number;
  engage_weekly_cap: number;
  engage_batch_size: number;
  engage_batches_per_day: number;
  engage_comment_daily_cap: number;
}

// --- Event invites -----------------------------------------------------------------

export type EventStatus = 'draft' | 'armed' | 'running' | 'done' | 'stopped' | 'failed';
export type EventInviteeStatus = 'pending' | 'invited' | 'unreachable' | 'failed';
export type EventBucketKind = 'country' | 'us_state' | 'region';

export interface LinkedInEvent {
  id: number;
  event_url: string;
  event_urn: string | null;
  title: string | null;
  starts_at: string | null;
  status: EventStatus;
  invite_cap: number;
  bucket_ceiling: number;
  bucket_cursor: number;
  attended: number;
  created_at: string;
  armed_at: string | null;
  closed_at: string | null;
  close_reason: string | null;
}

export interface EventBucket {
  id: number;
  event_id: number;
  rank: number;
  /** Display label, e.g. "California (US state)". */
  label: string;
  /** EXACT `.search-typeahead-v2__hit-text` to match, e.g. "California, United States".
   *  Never fuzzy: querying "Georgia" ranks the COUNTRY Georgia first. */
  geo_label: string;
  geo_urn: string | null;
  kind: EventBucketKind;
  /** Invitees expected here. Ranks the bucket list — this is what maximises yield. */
  target_count: number;
  /** Connections LinkedIn will list here. Decides sharding — this is what the
   *  1000-row cap acts on, and it is a different number from target_count. */
  roster_count: number;
  parent_bucket_id: number | null;
  status: 'pending' | 'done' | 'skipped' | 'failed';
}

/** What the event top card says when we arrive. */
export interface EventPageInfo {
  title: string | null;
  /** Raw prose, e.g. "Thu, Sep 10, 2026, 6:15 PM - 10:30 PM (your local time)". */
  startsAtText: string | null;
  attending: boolean;
  /** Whether an Attend control is present to click. */
  canAttend: boolean;
}

export type EventStepStatus = 'ok' | 'checkpoint' | 'unavailable' | 'error';

export interface EventStepOutcome {
  status: EventStepStatus;
  error?: string;
  evidence?: SendEvidence;
  info?: EventPageInfo;
}

export interface BucketRunRequest {
  /** Exact typeahead labels to try, in order. */
  geoCandidates: string[];
  /** URNs still awaiting an invite. Any of these that appears gets ticked — bucket
   *  membership ranks the work, it does not restrict who may be selected. */
  pending: string[];
  /** Most rows this bucket may tick (what is left of the lifetime cap). */
  limit: number;
  /** Stop paginating once past this instant. */
  deadline: Date;
  /** Do everything except the irreversible submit. */
  dryRun: boolean;
  onProgress?: (p: { rowsLoaded: number; matched: number }) => void;
}

export type BucketOutcome =
  | 'done' | 'early_exit' | 'row_cap' | 'deadline'
  | 'no_geo' | 'checkpoint' | 'failed';

export interface BucketRunResult {
  outcome: BucketOutcome;
  /** The candidate that actually resolved. */
  geoLabel: string | null;
  geoUrn: string | null;
  rowsLoaded: number;
  matchedUrns: string[];
  tickedUrns: string[];
  submitted: boolean;
  error?: string;
  evidence?: SendEvidence;
}

export interface EventInvitee {
  id: number;
  event_id: number;
  connection_id: number | null;
  member_urn: string | null;
  profile_url: string;
  full_name: string | null;
  bucket_id: number | null;
  status: EventInviteeStatus;
  invited_at: string | null;
  responded_at: string | null;
  note: string | null;
}

// --- Post engagements -----------------------------------------------------------------

/** Its own union, NOT an alias of ProfileStatus: an engagement can never be accepted,
 *  replied or expired, and a shared type would invite code that pretends otherwise. */
export type EngagementStatus =
  | 'queued' | 'scheduled' | 'sending' | 'sent' | 'skipped' | 'failed' | 'needs_attention';

/** Why a skipped engagement was skipped (terminal — the engine never retries these). */
export type EngagementSkipReason =
  | 'not_found' | 'unavailable' | 'comments_disabled' | 'dismissed';

export interface Engagement {
  id: number;
  post_url: string;
  post_urn: string;
  reaction: Reaction;
  /** null for a reaction-only task. When set, always delivered WITH the reaction. */
  comment_text: string | null;
  status: EngagementStatus;
  attempts: number;
  last_error: string | null;
  skip_reason: EngagementSkipReason | null;
  scheduled_for: string | null;
  reacted_at: string | null;
  commented_at: string | null;
  priority: number;
  created_at: string;
}

/**
 * What one engagement step did.
 *
 * `unverified` is COMMENT-ONLY: reactToPost never returns it, because an unconfirmed
 * reaction is safe to retry and so reports `error` instead. An unconfirmed COMMENT may
 * already be published under the operator's name, so it gets its own result that the sender
 * turns into needs_attention rather than a retry.
 *
 * `comments_disabled` is split from `unavailable` deliberately: an author who restricted
 * commenting is a per-post terminal fact, and folding it into `unavailable` would march a
 * batch of such posts toward a repeated_failures halt.
 */
export type EngagementResult =
  | 'done' | 'already' | 'not_found' | 'unavailable'
  | 'comments_disabled' | 'unverified' | 'checkpoint' | 'error';

export interface EngagementOutcome {
  result: EngagementResult;
  /** Set on `already`: the reaction found on the post. Logged, never persisted.
   *  Deliberately `string`, not `Reaction`: it is read verbatim out of a live aria-label
   *  ("Unreact <X>"), so it may be a reaction we do not model. Narrowing it here would
   *  force the driver to drop the value exactly when it is most surprising. */
  existingReaction?: string;
  /** Canonical URN read off the post container's data-urn, when present. The sender
   *  reconciles the row's identity from this — the URL's id is only best-effort. */
  observedUrn?: string;
  error?: string;
  evidence?: SendEvidence;
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

/** Optional overrides for a send. `firstName` lets the caller supply a name resolved from
 *  the roster, so the driver does not have to derive one from the page title. */
export interface SendOptions { firstName?: string | null }

export interface BrowserDriver {
  /** No side effects: whether the browser context is currently open. */
  browserOpen(): boolean;
  /** Read the li_at cookie. Opens the context if needed (callers that must not
   *  open the browser guard with browserOpen() first). */
  readLoginState(): Promise<LoginSnapshot>;
  openLoginWindow(): Promise<void>;
  // message === null => send a bare request (no note)
  sendConnectionRequest(url: string, message: string | null, opts?: SendOptions): Promise<SendOutcome>;
  /** Send a plain message to an existing 1st-degree connection. `message` still
   *  contains {firstName}; the driver substitutes `opts.firstName` when the caller
   *  resolved one, otherwise the live name it reads. */
  sendMessage(url: string, message: string, opts?: SendOptions): Promise<SendOutcome>;
  /** One-page scan of the messaging inbox conversation list. */
  readInboxSnapshot(): Promise<InboxRow[]>;
  readPendingInvites(): Promise<string[]>;     // normalized profile URLs
  /** One scroll-loaded read of the connections page, returning URL + display name per card.
   *  The single source of connection discovery: roster-sync calls this, and acceptance
   *  resolves against the roster it fills rather than scraping again. */
  readConnectionCards(): Promise<ConnectionCard[]>;
  /** Scan the currently-loaded page for a checkpoint/captcha (url + what matched). */
  checkpointScan(): Promise<CheckpointScan>;

  // --- Event invites ---
  /** Navigate to an event and read its top card. */
  openEvent(eventUrl: string): Promise<EventStepOutcome>;
  /** RSVP. A hard prerequisite: the Share menu has no Invite item until you attend. */
  attendEvent(): Promise<EventStepOutcome>;
  /** Filter to one location, exhaust the list, tick pending matches, and submit unless
   *  `dryRun`. Opens AND closes its own picker, so buckets share no modal state and the
   *  caller needs no teardown call. */
  runEventBucket(req: BucketRunRequest): Promise<BucketRunResult>;

  // --- Post engagements ---
  /** Place a reaction on a post. MUST read current state first and report `already`
   *  rather than clicking: the trigger is a toggle, so a blind click on an
   *  already-reacted post REMOVES the reaction. */
  reactToPost(postUrl: string, reaction: Reaction): Promise<EngagementOutcome>;
  /** Post a comment. Reports `unverified` rather than `error` when it cannot confirm the
   *  comment landed — the caller must NOT retry that. */
  commentOnPost(postUrl: string, text: string): Promise<EngagementOutcome>;

  close(): Promise<void>;
}

export type GuardrailReason = 'checkpoint' | 'login_lost' | 'repeated_failures';

/**
 * Why automatic enrichment stopped itself. Distinct from GuardrailReason: the guardrail
 * protects the LinkedIn session, this one only ever means "Apify work cannot proceed".
 * `no_api_key` is raised by the drain tick; the rest come from a run's circuit breaker.
 */
export type EnrichHaltReason =
  | 'no_api_key' | 'auth' | 'billing' | 'rate_limit' | 'upstream' | 'repeated_errors';

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
  enrich_halted: number;          // 0 | 1 — automatic enrichment stopped itself
  enrich_halt_reason: EnrichHaltReason | null;
  enrich_halt_detail: string | null;   // operator-facing message; never the API token
  enrich_halted_at: string | null;     // ISO
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
