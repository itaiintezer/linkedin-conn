import { test, expect, describe } from 'vitest';
import {
  classifyRelationship, skipsInvite, confirmsInviteLanded, mayReceiveDirectMessage,
  pendingBadgeMatchesTarget, confirmsExistingConnection, type PendingBadge,
  type Relationship, type RelationshipSignals,
} from '../../src/core/relationship.js';

const signals = (over: Partial<RelationshipSignals> = {}): RelationshipSignals => ({
  nameRead: true, pendingForTarget: false, connectForTarget: false, removeConnection: false,
  ...over,
});

describe('classifyRelationship', () => {
  test('a blank page is unreadable, whatever else appears to match', () => {
    // A page that did not render must never produce a verdict: the old code's guard
    // ("don't infer connected from a blank page") is preserved as its own state.
    expect(classifyRelationship(signals({ nameRead: false }))).toBe('unreadable');
    expect(classifyRelationship(signals({ nameRead: false, removeConnection: true }))).toBe('unreadable');
  });

  test('each positive signal maps to its own state', () => {
    expect(classifyRelationship(signals({ pendingForTarget: true }))).toBe('pending');
    expect(classifyRelationship(signals({ connectForTarget: true }))).toBe('connectable');
    expect(classifyRelationship(signals({ removeConnection: true }))).toBe('connected');
  });

  test('no signal at all is unknown — NOT connected', () => {
    // The whole bug in one assertion: absence used to mean "connected".
    expect(classifyRelationship(signals())).toBe('unknown');
  });

  test('pending outranks a stale Connect affordance', () => {
    expect(classifyRelationship(signals({ pendingForTarget: true, connectForTarget: true })))
      .toBe('pending');
  });

  test('a positive pending or connect signal outranks Remove connection', () => {
    expect(classifyRelationship(signals({ pendingForTarget: true, removeConnection: true })))
      .toBe('pending');
    expect(classifyRelationship(signals({ connectForTarget: true, removeConnection: true })))
      .toBe('connectable');
  });
});

describe('policies', () => {
  // One table so a change to any policy has to be stated here, per relationship.
  const table: Array<[Relationship, boolean, boolean, boolean]> = [
    // relationship,   skipsInvite, confirmsInviteLanded, mayReceiveDirectMessage
    ['pending', true, true, false],
    ['connectable', false, false, false],
    ['connected', true, true, true],
    ['unknown', false, false, true],
    ['unreadable', false, false, false],
  ];

  for (const [r, skip, confirms, dm] of table) {
    test(`${r}: skip=${skip} confirms=${confirms} dm=${dm}`, () => {
      expect(skipsInvite(r)).toBe(skip);
      expect(confirmsInviteLanded(r)).toBe(confirms);
      expect(mayReceiveDirectMessage(r)).toBe(dm);
    });
  }

  test('unknown — the absence of every signal — no longer reads as connected anywhere', () => {
    // The 2026-08-03 rework kept skipsInvite('unknown') true as a bet that classic-layout
    // connections would otherwise be re-invited. The 2026-08-07/08 roster cross-checks
    // showed the bet lost (9 of 10 / 8 of 18 such skips were not connections): every
    // transient read failure became a terminal already_connected. An unreadable
    // relationship is now a retryable relationship_unknown outcome, never a skip.
    expect(skipsInvite('unknown')).toBe(false);
    expect(confirmsInviteLanded('unknown')).toBe(false);
  });
});

/**
 * Regression guard for the layouts themselves. Each row is a situation observed live —
 * classic rows are the behaviour that works today and must not change; Sales Navigator rows
 * are from scripts/probe-pending.ts against a licensed account (2026-08-03).
 */
describe('observed layouts', () => {
  const cases: Array<{ what: string; s: RelationshipSignals; expect: Relationship }> = [
    // --- classic top card: Pending and Connect are primary, no overflow needed ----------
    { what: 'classic, invite pending (badge on top card)', s: signals({ pendingForTarget: true }), expect: 'pending' },
    { what: 'classic, invitable (Connect on top card)', s: signals({ connectForTarget: true }), expect: 'connectable' },
    // NB since 2026-08-08 this no longer skips by itself — the sender's roster
    // short-circuit is what protects a genuine classic-layout connection now, and
    // inviting an existing connection is a no-op on LinkedIn's side regardless.
    { what: 'classic, connected (no badge, no Connect)', s: signals(), expect: 'unknown' },

    // --- Sales Navigator: the affordance is demoted into the "More" overflow -----------
    { what: 'salesnav, invite pending (badge only once More is expanded)', s: signals({ pendingForTarget: true }), expect: 'pending' },
    { what: 'salesnav, invitable (Connect still primary)', s: signals({ connectForTarget: true }), expect: 'connectable' },
    { what: 'salesnav, connected (Remove connection in overflow)', s: signals({ removeConnection: true }), expect: 'connected' },
  ];

  for (const c of cases) {
    test(c.what, () => expect(classifyRelationship(c.s)).toBe(c.expect));
  }

  test('classic "connected" (all-absent) stays DM-able but is no longer a terminal skip', () => {
    // Pre-2026-08-08 this skipped via the legacy absence rule; the roster cross-check
    // proved that rule wrong far more often than right. The DM gate keeps its old
    // permissive reading (flagged separately — see the plan's out-of-scope note).
    const r = classifyRelationship(signals());
    expect(r).toBe('unknown');
    expect(skipsInvite(r)).toBe(false);
    expect(mayReceiveDirectMessage(r)).toBe(true);
  });
});

/**
 * The 2026-08-07 regression in one function: a Pending badge only belongs to the target
 * when its label canonically names them, or the card containing it links to their slug.
 * Label shapes are live-verified (2026-08-08 probe spec): the profile-page badge reads
 * "Pending, click to withdraw invitation sent to <Full Name>".
 */
describe('pendingBadgeMatchesTarget', () => {
  const badge = (label: string, cardSlug: string | null = null): PendingBadge => ({ label, cardSlug });
  const target = { name: 'Thomas Smith', slug: 'thomas-smith-crisc-915b052' };

  test('a label naming the target matches', () => {
    expect(pendingBadgeMatchesTarget(
      badge('Pending, click to withdraw invitation sent to Thomas Smith'),
      target.name, target.slug,
    )).toBe(true);
  });

  test('a post-nominal in the label does not break the match', () => {
    // Two of the ten mis-skipped slugs carried CRISC/CISSP; readFullName keeps the
    // credential when the title does, and canonicalName strips it from either side.
    expect(pendingBadgeMatchesTarget(
      badge('Pending, click to withdraw invitation sent to Thomas Smith, CRISC'),
      'Thomas Smith', target.slug,
    )).toBe(true);
    expect(pendingBadgeMatchesTarget(
      badge('Pending, click to withdraw invitation sent to Thomas Smith'),
      'Thomas Smith, CRISC', target.slug,
    )).toBe(true);
  });

  test('an omitted middle token still matches (same rule as the reply-checker)', () => {
    expect(pendingBadgeMatchesTarget(
      badge('Pending, click to withdraw invitation sent to Keren (Yosef) Tevet'),
      'Keren Tevet', 'keren-tevet-3453a079',
    )).toBe(true);
  });

  test("a NEIGHBOUR card's badge never matches — the whole 2026-08-07 bug", () => {
    // The operator's own outstanding invites render as Pending badges on the
    // "More profiles for you" cards of every profile they visit.
    expect(pendingBadgeMatchesTarget(
      badge('Pending, click to withdraw invitation sent to Somebody Else', 'somebody-else-1a2b3c'),
      target.name, target.slug,
    )).toBe(false);
  });

  test('a similar-but-different name never matches (substring is not identity)', () => {
    expect(pendingBadgeMatchesTarget(
      badge('Pending, click to withdraw invitation sent to Mary-Ann Leeson'),
      'Ann Lee', 'ann-lee-9',
    )).toBe(false);
  });

  test('a nameless label still matches when the containing card links to the target', () => {
    expect(pendingBadgeMatchesTarget(
      badge('Pending', target.slug), target.name, target.slug,
    )).toBe(true);
  });

  test('slug comparison survives percent-encoding differences', () => {
    // profile 817's stored URL is percent-encoded (andr%c3%a9-…) while the DOM href
    // decodes it — the two must still compare equal.
    expect(pendingBadgeMatchesTarget(
      badge('Pending', 'andré-harms-015bb0270'), 'André Harms', 'andr%c3%a9-harms-015bb0270',
    )).toBe(true);
  });

  test('a label naming nobody on a card linking nowhere never matches', () => {
    expect(pendingBadgeMatchesTarget(badge('Pending'), target.name, target.slug)).toBe(false);
    expect(pendingBadgeMatchesTarget(badge(''), target.name, target.slug)).toBe(false);
  });

  test('an empty canonical target name is not a name and never label-matches', () => {
    // name-match.ts' hard rule: '' would match everything.
    expect(pendingBadgeMatchesTarget(
      badge('Pending, click to withdraw invitation sent to (Bot)'), '(Bot)', 'bot-123',
    )).toBe(false);
    // …but the structural slug test is name-independent and still stands.
    expect(pendingBadgeMatchesTarget(badge('Pending', 'bot-123'), '(Bot)', 'bot-123')).toBe(true);
  });

  test('an empty target slug never slug-matches', () => {
    expect(pendingBadgeMatchesTarget(badge('Pending', ''), 'Thomas Smith', '')).toBe(false);
  });
});

/**
 * The roster tie-breaker: a DOM 'connected' verdict is terminal only when the local
 * connections roster agrees, or is too stale to disagree. The full matrix, because the
 * 2026-08-07/08 investigations were decided by exactly this cross-check.
 */
describe('confirmsExistingConnection', () => {
  const matrix: Array<[Relationship, boolean, boolean, boolean]> = [
    // relationship, inRoster, rosterFresh → confirmed
    ['connected', true, true, true],   // both sources agree
    ['connected', true, false, true],  // roster stale but agreeing is still agreement
    ['connected', false, true, false], // fresh roster disagrees → park it, don't skip
    ['connected', false, false, true], // absent from a stale roster proves nothing
  ];
  for (const [r, inRoster, fresh, want] of matrix) {
    test(`${r} inRoster=${inRoster} fresh=${fresh} → ${want}`, () => {
      expect(confirmsExistingConnection(r, inRoster, fresh)).toBe(want);
    });
  }

  test('only a connected verdict can be confirmed at all', () => {
    for (const r of ['pending', 'connectable', 'unknown', 'unreadable'] as Relationship[]) {
      expect(confirmsExistingConnection(r, true, true)).toBe(false);
    }
  });
});

