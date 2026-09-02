export const MAX_NOTE = 300;
export const MAX_MESSAGE = 2000;
/** LinkedIn's comment limit. */
export const MAX_COMMENT = 1250;

/**
 * Choose the note source by precedence (custom message -> cohort template -> none),
 * WITHOUT substituting tokens. The {firstName} token is left intact so the driver can
 * substitute the real name it reads from the profile at send time. Returns null for a
 * bare (no-note) request.
 */
export function selectNoteSource(customMessage: string | null, template: string | null): string | null {
  if (customMessage && customMessage.trim()) return customMessage;
  if (template && template.trim()) return template;
  return null;
}

/** Substitute {firstName} (falling back to 'there') and truncate to the length limit
 *  (300 for invite notes; pass MAX_MESSAGE for direct messages). */
export function applyFirstName(text: string, firstName: string | null, max: number = MAX_NOTE): string {
  return text.replace(/\{firstName\}/g, (firstName ?? '').trim() || 'there').slice(0, max);
}

/** The one placeholder a note or message may carry. Substitution is case-sensitive. */
export const FIRST_NAME_TOKEN = '{firstName}';

/** `FirstName`, `first_name`, `firstname`, `First name`, `FIRSTNAME`… — a near-miss for the
 *  real token, spelled by a human who knew what they meant. */
const FIRST_NAME_LOOKALIKE = /^\s*first[\s_-]?name\s*$/i;
/** A `{…}` token made of word-like characters only. A stray brace inside prose
 *  (`{we're hiring!}`, a code snippet) does not match and is left alone. */
const BRACE_TOKEN = /\{([\p{L}\p{N} _.-]{1,40})\}/gu;
/** `[First name]`, `<firstName>`, `[firstname]` — the token in the wrong brackets. */
const WRONG_BRACKETS = /[[<]\s*first[\s_-]?name\s*[\]>]/i;

/**
 * Reject a template whose placeholder is misspelled, BEFORE it is stored. Returns the error
 * to show, or null when the text is fine.
 *
 * Fail closed on purpose. `applyFirstName` substitutes `{firstName}` exactly and passes
 * everything else through verbatim, so a near-miss is not a degraded greeting — it is a
 * message that opens `Hi {FirstName},` or `Hey [First name],` in front of a real person, and
 * it went out that way to six people on two machines on 2026-08-26 and 2026-09-01. Nothing
 * else in the pipeline can catch it: the sender has no preview step and the name it would
 * have used was sitting in the roster the whole time.
 *
 * Only the write endpoints call this; templates already stored are never re-validated, so
 * an existing cohort keeps working exactly as it did.
 */
export function validatePlaceholders(text: string | null | undefined): string | null {
  if (!text) return null;
  const doubled = text.match(/\{\{[^{}\n]*\}\}/);
  if (doubled) return `unsupported placeholder ${doubled[0]} — write ${FIRST_NAME_TOKEN} with single braces`;
  for (const m of text.matchAll(BRACE_TOKEN)) {
    const token = m[1];
    if (token === 'firstName') continue;
    if (FIRST_NAME_LOOKALIKE.test(token)) {
      return `unknown placeholder {${token}} — did you mean ${FIRST_NAME_TOKEN}? (it is case-sensitive)`;
    }
    return `unknown placeholder {${token}} — only ${FIRST_NAME_TOKEN} is supported`;
  }
  const wrong = text.match(WRONG_BRACKETS);
  if (wrong) return `unknown placeholder ${wrong[0]} — write ${FIRST_NAME_TOKEN} instead`;
  return null;
}

/**
 * Derive the "send without a note" policy from the template alone: a blank template means
 * bare requests are intended (allowed); a non-blank template means the note matters, so a
 * bare fallback is NOT allowed (the sender routes to needs_attention on note-quota exhaustion).
 */
export function deriveAllowNoNote(template: string | null | undefined): boolean {
  return !template || !template.trim();
}

/**
 * Select the note source then substitute {firstName} + truncate. Convenience composition
 * of selectNoteSource + applyFirstName (used where the name is already known).
 */
export function resolveMessage(
  customMessage: string | null,
  template: string | null,
  firstName: string | null,
): string | null {
  const source = selectNoteSource(customMessage, template);
  return source === null ? null : applyFirstName(source, firstName);
}
