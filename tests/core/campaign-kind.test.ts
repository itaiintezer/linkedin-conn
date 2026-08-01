import { test, expect } from 'vitest';
import { CAMPAIGN_KINDS, isCampaignKind, parseKind } from '../../src/core/campaign-kind.js';

/* CAMPAIGN_KINDS is the single source of truth: the CampaignKind type is derived from it,
   the scheduler iterates it, and every API boundary validates against it. A change here is
   a deliberate product decision, so it is asserted exactly. */
test('CAMPAIGN_KINDS lists exactly the kinds the engine can send', () => {
  expect([...CAMPAIGN_KINDS]).toEqual(['invite', 'message']);
});

test('isCampaignKind accepts members and rejects everything else', () => {
  expect(isCampaignKind('invite')).toBe(true);
  expect(isCampaignKind('message')).toBe(true);
  // The whole point: a kind that does not exist yet must not pass as one.
  expect(isCampaignKind('like')).toBe(false);
  expect(isCampaignKind('')).toBe(false);
  expect(isCampaignKind('INVITE')).toBe(false); // case-sensitive; the DB stores lowercase
  expect(isCampaignKind(undefined)).toBe(false);
  expect(isCampaignKind(null)).toBe(false);
  expect(isCampaignKind(7)).toBe(false);
});

/* Absent must stay distinguishable from invalid: POST /api/cohorts uses "was a kind
   explicitly stated?" to decide whether a kind mismatch is the caller's error or just an
   edit that omitted a frozen field. Defaulting inside parseKind would destroy that. */
test('parseKind treats an absent kind as absent, not as a default', () => {
  expect(parseKind(undefined)).toEqual({ ok: true, kind: undefined });
});

test('parseKind returns a valid kind unchanged', () => {
  expect(parseKind('invite')).toEqual({ ok: true, kind: 'invite' });
  expect(parseKind('message')).toEqual({ ok: true, kind: 'message' });
});

/* The regression this module exists to prevent. Before this, an unrecognized kind was
   coerced to 'invite' with no compile error and no runtime complaint — so a request meant
   to like a post sent a real, unsendable connection request instead. */
test('parseKind rejects an unrecognized kind instead of coercing it', () => {
  const r = parseKind('like');
  expect(r.ok).toBe(false);
  if (r.ok) throw new Error('expected a rejection');
  // The offending value is echoed back so a typo diagnoses itself.
  expect(r.error).toContain('like');
});

test('parseKind rejects non-string junk, and null is invalid rather than absent', () => {
  // `null` is a value the caller chose to send, so it is an error — unlike an omitted
  // field. The web UI never sends it (app.js sends 'invite'/'message' or omits the key).
  for (const bad of [null, 7, '', 'INVITE', {}, []]) {
    expect(parseKind(bad).ok, `expected ${JSON.stringify(bad)} to be rejected`).toBe(false);
  }
});
