import { test, expect, describe } from 'vitest';
import {
  classifyRelationship, skipsInvite, confirmsInviteLanded, mayReceiveDirectMessage,
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
    ['unknown', true, false, true],
    ['unreadable', false, false, false],
  ];

  for (const [r, skip, confirms, dm] of table) {
    test(`${r}: skip=${skip} confirms=${confirms} dm=${dm}`, () => {
      expect(skipsInvite(r)).toBe(skip);
      expect(confirmsInviteLanded(r)).toBe(confirms);
      expect(mayReceiveDirectMessage(r)).toBe(dm);
    });
  }

  test('the pre-visit skip trusts absence but the post-submit confirmation does not', () => {
    // The asymmetry IS the fix. Same signals, opposite readings, because reaching the
    // post-submit branch proves the pre-visit already found them invitable.
    expect(skipsInvite('unknown')).toBe(true);
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
    { what: 'classic, connected (no badge, no Connect)', s: signals(), expect: 'unknown' },

    // --- Sales Navigator: the affordance is demoted into the "More" overflow -----------
    { what: 'salesnav, invite pending (badge only once More is expanded)', s: signals({ pendingForTarget: true }), expect: 'pending' },
    { what: 'salesnav, invitable (Connect still primary)', s: signals({ connectForTarget: true }), expect: 'connectable' },
    { what: 'salesnav, connected (Remove connection in overflow)', s: signals({ removeConnection: true }), expect: 'connected' },
  ];

  for (const c of cases) {
    test(c.what, () => expect(classifyRelationship(c.s)).toBe(c.expect));
  }

  test('classic "connected" keeps its existing verdict via the legacy absence rule', () => {
    // The one classic row that lands on 'unknown' rather than a positive signal. It must
    // still skip the invite and still permit a DM, exactly as before this change — that is
    // what makes the fix safe for accounts without a Sales Navigator licence.
    const r = classifyRelationship(signals());
    expect(r).toBe('unknown');
    expect(skipsInvite(r)).toBe(true);
    expect(mayReceiveDirectMessage(r)).toBe(true);
  });
});
