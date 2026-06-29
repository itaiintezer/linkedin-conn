const MAX_NOTE = 300;

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

/** Substitute {firstName} (falling back to 'there') and truncate to the 300-char limit. */
export function applyFirstName(text: string, firstName: string | null): string {
  return text.replace(/\{firstName\}/g, (firstName ?? '').trim() || 'there').slice(0, MAX_NOTE);
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
