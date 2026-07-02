/**
 * Checkpoint/captcha detection for LinkedIn pages.
 *
 * Deliberately narrow. The old detector regex-matched the ENTIRE page HTML for
 * single words (captcha|checkpoint|security check|...), which false-positived on
 * normal profiles whose content mentions those words — e.g. security leaders with
 * "Checkpoint" skills or posts about captchas (halted the engine on 2026-07-02).
 *
 * Real LinkedIn challenges are recognized by two narrow signals instead:
 *  - URL: challenges navigate to /checkpoint/..., /authwall or /uas/... routes.
 *  - Page chrome: the tab title / <h1> of a challenge page ("Security Verification",
 *    "Let's do a quick security check", ...). Body text is never inspected.
 */

export interface CheckpointScan {
  hit: boolean;
  /** What identified the challenge: the URL route or the page title/heading. */
  via: 'url' | 'page' | null;
  /** The pattern text that matched, for logs and the guardrail detail. */
  matched: string | null;
  url: string;
  title: string;
}

const URL_RE = /linkedin\.com\/(checkpoint\/|authwall|uas\/)/i;

// Full phrases only — single words appear in legitimate profile content.
const PAGE_PATTERNS: RegExp[] = [
  /security verification/i,
  /quick security check/i,
  /verify (that )?you'?re (a )?human/i,
  /are you a (robot|human)/i,
  /unusual activity/i,
  /account (has been |is )?(temporarily )?restricted/i,
  /confirm (it'?s|that it'?s) really you/i,
  /help us verify/i,
];

export interface CheckpointScanInput {
  url: string;
  title: string;
  /** Top-level page headings (h1) — a challenge page's headline, a profile's person name. */
  headings: string[];
}

export function detectCheckpoint(input: CheckpointScanInput): CheckpointScan {
  const base = { url: input.url, title: input.title };
  const urlMatch = input.url.match(URL_RE);
  if (urlMatch) return { hit: true, via: 'url', matched: urlMatch[0], ...base };

  for (const text of [input.title, ...input.headings]) {
    for (const re of PAGE_PATTERNS) {
      const m = text.match(re);
      if (m) return { hit: true, via: 'page', matched: m[0], ...base };
    }
  }
  return { hit: false, via: null, matched: null, ...base };
}
