/**
 * Classify an enrichment failure: is this ONE profile's problem, or the account's?
 *
 * The stakes are asymmetric. `markEnrichFailure` parks a row as `failed` after 3 attempts,
 * and `failed` is manual-re-arm-only by design (a restricted profile does not become
 * scrapeable on retry). So a rotated API key — which fails every single fetch — would,
 * without this distinction, quietly convert a 7,000-row roster into rows needing a button
 * press each. Account-level failures must therefore halt the run and leave the rows alone.
 */

export type EnrichFailureKind = 'auth' | 'billing' | 'rate_limit' | 'upstream' | 'profile';

/** The kinds that mean the account is broken. Every one of them is also an EnrichHaltReason. */
export type AccountLevelKind = Exclude<EnrichFailureKind, 'profile'>;

/** Kinds where the profile is fine and the account is not. These halt the run. */
const ACCOUNT_LEVEL: ReadonlySet<EnrichFailureKind> = new Set<EnrichFailureKind>([
  'auth', 'billing', 'rate_limit', 'upstream',
]);

/** A type guard, so a caller that halts on `true` cannot pass 'profile' as a halt reason. */
export function isAccountLevel(kind: EnrichFailureKind): kind is AccountLevelKind {
  return ACCOUNT_LEVEL.has(kind);
}

/**
 * Read the HTTP status out of HttpApifyClient's `Apify run failed (HTTP nnn)` message.
 *
 * Anything unrecognised is deliberately `profile`: bounded attempts already contain the
 * per-row damage, whereas mis-classifying an ordinary hiccup as account-level would halt
 * enrichment and raise a dashboard alert over nothing. Fail toward the quieter mistake.
 */
export function classifyEnrichError(message: string): EnrichFailureKind {
  const status = Number(/\(HTTP (\d{3})\)/.exec(message)?.[1] ?? NaN);
  if (status === 401 || status === 403) return 'auth';
  if (status === 402) return 'billing';
  if (status === 429) return 'rate_limit';
  if (status >= 500 && status <= 599) return 'upstream';
  return 'profile';
}

/** Operator-facing sentence for a halt reason. Never includes the API token. */
export const ENRICH_HALT_TEXT: Record<string, string> = {
  no_api_key: 'No Apify API key is configured, so connections cannot be enriched.',
  auth: 'Apify rejected the API key (401/403). It may have been rotated or revoked.',
  billing: 'Apify refused the run for billing reasons (402) — the plan may be out of credit.',
  rate_limit: 'Apify is rate-limiting this account (429).',
  upstream: 'Apify returned server errors (5xx). This is usually temporary.',
  repeated_errors: 'Several profiles failed in a row, so enrichment stopped rather than burning attempts.',
};
