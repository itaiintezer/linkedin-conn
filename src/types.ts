export type ProfileStatus =
  | 'queued' | 'scheduled' | 'sending' | 'sent'
  | 'accepted' | 'expired' | 'skipped' | 'failed' | 'needs_attention';

export type EventType = 'sent' | 'accepted' | 'expired' | 'skipped' | 'failed';

export type AccountType = 'unknown' | 'free' | 'premium' | 'salesnav';

export interface Cohort {
  id: number;
  name: string;
  message_template: string | null;
  allow_no_note: number; // 0 | 1 (SQLite has no bool)
  created_at: string;    // ISO
}

export interface Profile {
  id: number;
  cohort_id: number;
  profile_url: string;       // normalized
  first_name: string | null;
  custom_message: string | null;
  status: ProfileStatus;
  attempts: number;
  last_error: string | null;
  scheduled_for: string | null; // ISO
  sent_at: string | null;
  accepted_at: string | null;
  resolved_at: string | null;
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
  acceptance_checks_per_day: number;
  account_type: AccountType;
  note_quota_exhausted: number;
  min_delay_ms: number;
  max_delay_ms: number;
  paused: number;
  pause_reason: string | null;
  onboarded: number;
  failure_threshold: number;
}

export type SendResult =
  | 'sent' | 'already' | 'unavailable' | 'note_quota' | 'checkpoint' | 'error';

export interface SendOutcome {
  result: SendResult;
  firstName?: string;
  error?: string;
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
  readPendingInvites(): Promise<string[]>;     // normalized profile URLs
  readRecentConnections(): Promise<string[]>;  // normalized profile URLs
  /** Whether the currently-loaded page looks like a checkpoint/captcha. */
  checkpointPresent(): Promise<boolean>;
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
}

/** A point-in-time read of LinkedIn auth from the browser's li_at cookie. */
export interface LoginSnapshot {
  loggedIn: boolean;
  cookieExpiry: string | null;    // ISO, or null for a session cookie / unknown
}
