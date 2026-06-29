const MAX_NOTE = 300;

function substitute(text: string, firstName: string | null): string {
  return text.replace(/\{firstName\}/g, (firstName ?? '').trim() || 'there');
}

/**
 * Precedence: custom message -> cohort template -> null (bare request).
 * Tokens are substituted and the result is truncated to 300 chars.
 */
export function resolveMessage(
  customMessage: string | null,
  template: string | null,
  firstName: string | null,
): string | null {
  const source = (customMessage && customMessage.trim())
    ? customMessage
    : (template && template.trim())
      ? template
      : null;
  if (source === null) return null;
  return substitute(source, firstName).slice(0, MAX_NOTE);
}
