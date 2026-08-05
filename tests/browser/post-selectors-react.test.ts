import { test, expect } from 'vitest';
import { REACTIONS } from '../../src/core/engagement-action.js';
import {
  RSEL, TRIGGER_OUTLINE_ICON, CONSUMPTION_FAMILY, FLYOUT_ENTRY_ICON,
  flyoutEntry, reactionFromConsumptionIcon, postKeyFromShellId, postContainerSelector,
  urnFromFacepileTestid, reactionStateFromLabel, readReactionVerdict, commentUrnFromRowId,
} from '../../src/browser/post-selectors-react.js';

// The react surface renders NOTHING selectable but attributes: hashed classes rotate per
// build, componentkeys per render, and aria-pressed is gone entirely. What is testable
// without a browser is the derivation helpers, the state machine that replaced aria-pressed,
// and the hygiene rules that keep this module from quietly re-acquiring the vocabulary that
// rots.

// --- Selector hygiene: stricter than the classic module's, and provably so ---------------

/** Readable lowercase BEM — the CLASSIC module's rule. Kept here only to prove it is NOT
 *  sufficient on this surface, so nobody restores it believing it ever was. */
const BEM = /^[a-z][a-z0-9]*(-[a-z0-9]+)*(__[a-z0-9]+(-[a-z0-9]+)*)?(--[a-z0-9]+(-[a-z0-9]+)*)?$/;

test('the BEM shape check would ACCEPT hashed classes on this surface — which is why the rule is total', () => {
  // From the live 2026-08-05 captures: the first two are rejected, but the next three are
  // just as hashed and per-build and BEM accepts them, and `tiptap` is a third-party
  // library's name that BEM also accepts. There is no stable LinkedIn class on this page.
  expect('_255816ee').not.toMatch(BEM);
  expect('_074d7d54').not.toMatch(BEM);
  expect('c21779e1').toMatch(BEM);
  expect('aac76eba').toMatch(BEM);
  expect('d2139735').toMatch(BEM);
  expect('tiptap').toMatch(BEM);
});

function allSelectors(): string[] {
  return [
    ...Object.values(RSEL),
    ...REACTIONS.map(flyoutEntry),
  ];
}

test('NO selector on this surface uses a class at all', () => {
  for (const sel of allSelectors()) {
    expect(sel, sel).not.toMatch(/\.[A-Za-z_]/);
  }
});

test('no selector leans on a bare per-render id either', () => {
  // ids ARE used, but only via structural ^= / $= / *= fragments that survive the per-render
  // middle (`expanded…FeedType_FEED_DETAIL`, `…commentButtonSection…`, `replaceableComment_…`).
  // A `#` id selector would pin a per-render value.
  for (const sel of allSelectors()) {
    expect(sel, sel).not.toMatch(/#/);
    expect(sel, sel).not.toMatch(/ember\d/i);
  }
});

test('there are NO state-encoding trigger selectors to infer state from', () => {
  // The classic module's reactTriggerReacted/reactTriggerUnreacted pair is deliberately NOT
  // ported: a selector that encodes state lets a caller infer "unreacted" from a non-match,
  // which is the inference that silently un-likes a post. State is read by
  // readReactionVerdict over the resolved element, never by which selector matched.
  for (const key of Object.keys(RSEL)) {
    expect(key).not.toMatch(/reacted/i);
    expect(key).not.toMatch(/unreacted/i);
  }
  for (const sel of allSelectors()) {
    expect(sel, sel).not.toContain('aria-pressed');
  }
});

test('the comments_disabled signals are language-independent outright', () => {
  // commentButton absence is half of a terminal-skip verdict that never touches the failure
  // streak, so an English-dependent probe would let a Hebrew render silently retire every
  // comment-bearing task. The new control has no aria-label at all — the icon id is the
  // whole selector.
  expect(RSEL.commentButton).toBe('button:has(svg[id="comment-small"])');
  expect(RSEL.commentButton).not.toContain('aria-label');
  // The composer probe (the other half) is a testid, not text.
  expect(RSEL.commentComposer).toBe('div[data-testid="ui-core-tiptap-text-editor-wrapper"]');
});

test('the detail shell requires BOTH ends of the id', () => {
  // The page carries four other ids sharing the FeedType_FEED_DETAIL suffix
  // (replaceableCommentTools, commentBoxLinkPreview, UpdateDetailSkeletonRef,
  // UpdateDetailSimilarPagesSlot); the prefix alone is what excludes them.
  expect(RSEL.detailShell).toBe('div[id^="expanded"][id$="FeedType_FEED_DETAIL"]');
});

test('the react trigger only ever matches a real <button>', () => {
  // A comment row's own like control is an <svg> inside a div[role="button"] carrying the
  // IDENTICAL aria-label. When container scoping falls back to shell scoping, the tag name
  // is the only remaining fence between the post's trigger and a comment's — every arm of
  // the union must start at `button`.
  for (const arm of RSEL.reactTrigger.split(',').map((s) => s.trim())) {
    expect(arm, arm).toMatch(/^button[[:]/);
  }
});

// --- The icon maps: spelt out, never templated --------------------------------------------

test('FLYOUT_ENTRY_ICON is the captured vocabulary, verbatim', () => {
  // support is `support-…` — NOT the classic enum's APPRECIATION — and celebrate carries a
  // `-mixed` suffix no other entry has. Neither is derivable from any map that predates this
  // surface; this test fails if someone templates them.
  expect(FLYOUT_ENTRY_ICON).toEqual({
    like: 'like-consumption-large',
    celebrate: 'praise-consumption-large-mixed',
    support: 'support-consumption-large',
    love: 'empathy-consumption-large',
    insightful: 'interest-consumption-large',
    funny: 'entertainment-consumption-large',
  });
  expect(Object.keys(FLYOUT_ENTRY_ICON).sort()).toEqual([...REACTIONS].sort());
});

test('the flyout icon ids are not derivable from the reaction name or from a uniform template', () => {
  // Only like and support coincide with `<name>-consumption-large`; the other four would be
  // silently wrong under a template (celebrate is praise + `-mixed`, love is empathy, …).
  const templated = REACTIONS.filter((r) => FLYOUT_ENTRY_ICON[r] === `${r}-consumption-large`);
  expect(templated).toEqual(['like', 'support']);
});

test('CONSUMPTION_FAMILY translates icon families to our names, not LinkedIn display names', () => {
  expect(CONSUMPTION_FAMILY).toEqual({
    like: 'like', praise: 'celebrate', support: 'support',
    empathy: 'love', interest: 'insightful', entertainment: 'funny',
  });
  expect(Object.values(CONSUMPTION_FAMILY).sort()).toEqual([...REACTIONS].sort());
});

test('a flyout entry requires the bare display label and the icon id to agree on one element', () => {
  // Labels are BARE display names now ("Like", previously "React Like").
  expect(flyoutEntry('like')).toBe('button[aria-label="Like"]:has(svg[id="like-consumption-large"])');
  expect(flyoutEntry('celebrate')).toBe(
    'button[aria-label="Celebrate"]:has(svg[id="praise-consumption-large-mixed"])',
  );
  for (const r of REACTIONS) {
    expect(flyoutEntry(r), r).toContain(`svg[id="${FLYOUT_ENTRY_ICON[r]}"]`);
  }
});

// --- reactionFromConsumptionIcon ----------------------------------------------------------

test('reactionFromConsumptionIcon names the family regardless of size or -mixed suffix', () => {
  expect(reactionFromConsumptionIcon('like-consumption-small')).toBe('like');
  expect(reactionFromConsumptionIcon('like-consumption-large')).toBe('like');
  expect(reactionFromConsumptionIcon('praise-consumption-large-mixed')).toBe('celebrate');
  expect(reactionFromConsumptionIcon('praise-consumption-small-mixed')).toBe('celebrate');
  expect(reactionFromConsumptionIcon('support-consumption-large')).toBe('support');
  expect(reactionFromConsumptionIcon('empathy-consumption-large')).toBe('love');
  expect(reactionFromConsumptionIcon('interest-consumption-large')).toBe('insightful');
  expect(reactionFromConsumptionIcon('entertainment-consumption-large')).toBe('funny');
});

test('reactionFromConsumptionIcon passes an unmodelled family through and rejects non-glyphs', () => {
  // LinkedIn adding a reaction must surface as its own word in a log line, not vanish.
  expect(reactionFromConsumptionIcon('curious-consumption-small')).toBe('curious');
  // The outline icon is NOT a consumption glyph — that distinction is the whole state machine.
  expect(reactionFromConsumptionIcon(TRIGGER_OUTLINE_ICON)).toBeUndefined();
  expect(reactionFromConsumptionIcon('chevron-up-small')).toBeUndefined();
  expect(reactionFromConsumptionIcon('comment-small')).toBeUndefined();
  expect(reactionFromConsumptionIcon('')).toBeUndefined();
  expect(reactionFromConsumptionIcon(null)).toBeUndefined();
  expect(reactionFromConsumptionIcon(undefined)).toBeUndefined();
});

// --- The shell-id derivation --------------------------------------------------------------

const LIVE_SHELL_ID = 'expandedMbscQ3hym0l2Y8Hf0NRhkwvAoq9Zy0CUnQ_1pZUHwf8FeedType_FEED_DETAIL';
const LIVE_KEY = 'MbscQ3hym0l2Y8Hf0NRhkwvAoq9Zy0CUnQ_1pZUHwf8';

test('postKeyFromShellId slices the key out of the live shell id', () => {
  expect(postKeyFromShellId(LIVE_SHELL_ID)).toBe(LIVE_KEY);
});

test('postKeyFromShellId returns null on anything malformed', () => {
  // A partial key must never become div[componentkey=""] — that matches the first keyless
  // div on the page.
  expect(postKeyFromShellId('expandedFeedType_FEED_DETAIL')).toBeNull();
  expect(postKeyFromShellId(`expanded${LIVE_KEY}`)).toBeNull();
  expect(postKeyFromShellId(`${LIVE_KEY}FeedType_FEED_DETAIL`)).toBeNull();
  // The other FEED_DETAIL-suffixed ids on the same page must not yield a key.
  expect(postKeyFromShellId(`commentBoxLinkPreview-${LIVE_KEY}FeedType_FEED_DETAIL`)).toBeNull();
  // The key is injected into an attribute selector, so it is confined to the observed
  // token alphabet — a quote or whitespace must not escape.
  expect(postKeyFromShellId('expandedab"cdFeedType_FEED_DETAIL')).toBeNull();
  expect(postKeyFromShellId('expandeda bFeedType_FEED_DETAIL')).toBeNull();
  expect(postKeyFromShellId('')).toBeNull();
  expect(postKeyFromShellId(null)).toBeNull();
  expect(postKeyFromShellId(undefined)).toBeNull();
});

test('postContainerSelector round-trips the live key and refuses anything else', () => {
  expect(postContainerSelector(LIVE_KEY)).toBe(`div[componentkey="${LIVE_KEY}"]`);
  expect(() => postContainerSelector('')).toThrow();
  expect(() => postContainerSelector('a"b')).toThrow();
  expect(() => postContainerSelector('a b')).toThrow();
});

// --- The URN carrier ----------------------------------------------------------------------

test('urnFromFacepileTestid reads the post URN out of the facepile testid', () => {
  expect(urnFromFacepileTestid('ReactionFacepileCollection-urn:li:activity:7488567705558478848'))
    .toBe('urn:li:activity:7488567705558478848');
  // ugcPost-backed posts (re-shares) carry their own URN the same way. This attribute is the
  // one URN source that does NOT also appear for the re-shared ORIGINAL post — an href
  // harvest would feed reconcileUrn somebody else's identity.
  expect(urnFromFacepileTestid('ReactionFacepileCollection-urn:li:ugcPost:7490079826100297728'))
    .toBe('urn:li:ugcPost:7490079826100297728');
});

test('urnFromFacepileTestid returns undefined for anything else', () => {
  expect(urnFromFacepileTestid('ReactionFacepileCollection-')).toBeUndefined();
  expect(urnFromFacepileTestid('ReactionFacepileCollection-not-a-urn')).toBeUndefined();
  expect(urnFromFacepileTestid('urn:li:activity:123')).toBeUndefined();
  expect(urnFromFacepileTestid('')).toBeUndefined();
  expect(urnFromFacepileTestid(null)).toBeUndefined();
  expect(urnFromFacepileTestid(undefined)).toBeUndefined();
});

// --- The trigger label --------------------------------------------------------------------

test('reactionStateFromLabel parses the two live shapes', () => {
  expect(reactionStateFromLabel('Reaction button state: no reaction')).toEqual({ kind: 'none' });
  expect(reactionStateFromLabel('Reaction button state: Like'))
    .toEqual({ kind: 'named', reaction: 'like' });
  expect(reactionStateFromLabel('Reaction button state: Celebrate'))
    .toEqual({ kind: 'named', reaction: 'celebrate' });
  expect(reactionStateFromLabel('  Reaction button state: Insightful  '))
    .toEqual({ kind: 'named', reaction: 'insightful' });
});

test('reactionStateFromLabel passes an unmodelled reaction through by name', () => {
  expect(reactionStateFromLabel('Reaction button state: Curious'))
    .toEqual({ kind: 'named', reaction: 'curious' });
});

test('reactionStateFromLabel returns undefined for anything that does not parse', () => {
  // Hebrew — this surface has rendered Hebrew on a cold load, which is exactly why the label
  // only corroborates and the icon decides.
  expect(reactionStateFromLabel('מצב כפתור תגובה: אין תגובה')).toBeUndefined();
  expect(reactionStateFromLabel('React Like')).toBeUndefined();
  expect(reactionStateFromLabel('Unreact Like')).toBeUndefined();
  expect(reactionStateFromLabel('')).toBeUndefined();
  expect(reactionStateFromLabel(null)).toBeUndefined();
  expect(reactionStateFromLabel(undefined)).toBeUndefined();
});

// --- readReactionVerdict: the state machine that replaced aria-pressed ---------------------

const NO_REACTION = 'Reaction button state: no reaction';
const NAMES_LIKE = 'Reaction button state: Like';
const HEBREW = 'מצב כפתור תגובה';

test('outline icon + "no reaction" label -> unreacted (both agree)', () => {
  expect(readReactionVerdict([TRIGGER_OUTLINE_ICON], NO_REACTION)).toEqual({ state: 'unreacted' });
});

test('outline icon + unparseable label -> unreacted (the Hebrew case; the icon decides)', () => {
  expect(readReactionVerdict([TRIGGER_OUTLINE_ICON], HEBREW)).toEqual({ state: 'unreacted' });
  expect(readReactionVerdict([TRIGGER_OUTLINE_ICON], null)).toEqual({ state: 'unreacted' });
});

test('outline icon + a label NAMING a reaction -> unknown (a click might REMOVE a reaction)', () => {
  expect(readReactionVerdict([TRIGGER_OUTLINE_ICON], NAMES_LIKE).state).toBe('unknown');
});

test('a reaction glyph + the agreeing label -> reacted, named (live-verified after the toggle)', () => {
  // The live post-click re-read: triggerLabel "Reaction button state: Like",
  // triggerIcons ['like-consumption-small'].
  expect(readReactionVerdict(['like-consumption-small'], NAMES_LIKE))
    .toEqual({ state: 'reacted', existingReaction: 'like' });
  expect(readReactionVerdict(['praise-consumption-small-mixed'], 'Reaction button state: Celebrate'))
    .toEqual({ state: 'reacted', existingReaction: 'celebrate' });
});

test('a reaction glyph + unparseable label -> reacted (the glyph IS a positive statement)', () => {
  expect(readReactionVerdict(['like-consumption-small'], HEBREW))
    .toEqual({ state: 'reacted', existingReaction: 'like' });
  expect(readReactionVerdict(['empathy-consumption-small'], null))
    .toEqual({ state: 'reacted', existingReaction: 'love' });
});

test('a reaction glyph + "no reaction" label -> unknown (the outline icon was probably renamed)', () => {
  // Trusting the glyph here would report `already` on every unreacted post forever — a false
  // success no incident would ever record. Loud beats silently wrong.
  expect(readReactionVerdict(['like-consumption-small'], NO_REACTION).state).toBe('unknown');
});

test('a glyph and a label naming DIFFERENT reactions -> unknown', () => {
  expect(readReactionVerdict(['like-consumption-small'], 'Reaction button state: Celebrate').state)
    .toBe('unknown');
});

test('no icons at all -> unknown, whatever the label claims', () => {
  expect(readReactionVerdict([], NO_REACTION).state).toBe('unknown');
  expect(readReactionVerdict([], NAMES_LIKE).state).toBe('unknown');
  expect(readReactionVerdict([], null).state).toBe('unknown');
  expect(readReactionVerdict(['chevron-up-small'], NO_REACTION).state).toBe('unknown');
});

test('contradictory or plural icons -> unknown', () => {
  expect(readReactionVerdict([TRIGGER_OUTLINE_ICON, 'like-consumption-small'], NO_REACTION).state)
    .toBe('unknown');
  expect(readReactionVerdict(['like-consumption-small', 'empathy-consumption-small'], NAMES_LIKE).state)
    .toBe('unknown');
});

test('EXHAUSTIVE: `unreacted` is unreachable without the outline icon', () => {
  // THE invariant. With aria-pressed gone, "no evidence of a reaction" and "provably no
  // reaction" are different statements, and conflating them is precisely how this toggle
  // silently un-likes a post. Sweep every icon/label shape this module can distinguish.
  const iconSets: string[][] = [
    [], [TRIGGER_OUTLINE_ICON], ['like-consumption-small'], ['praise-consumption-small-mixed'],
    ['curious-consumption-small'], ['chevron-up-small'], ['comment-small'],
    [TRIGGER_OUTLINE_ICON, 'like-consumption-small'],
    ['like-consumption-small', 'empathy-consumption-small'],
    [TRIGGER_OUTLINE_ICON, 'chevron-up-small'],
  ];
  const labels = [
    NO_REACTION, NAMES_LIKE, 'Reaction button state: Celebrate', 'Reaction button state: Curious',
    HEBREW, 'React Like', '', null, undefined,
  ];
  for (const icons of iconSets) {
    for (const label of labels) {
      const v = readReactionVerdict(icons, label);
      if (v.state === 'unreacted') {
        expect(icons, `unreacted verdict for icons=${JSON.stringify(icons)} label=${String(label)}`)
          .toContain(TRIGGER_OUTLINE_ICON);
        expect(icons.some((i) => reactionFromConsumptionIcon(i) !== undefined)).toBe(false);
      }
      if (v.state === 'reacted') {
        // Symmetrically: `reacted` needs a glyph, never just a label.
        expect(icons.some((i) => reactionFromConsumptionIcon(i) !== undefined),
          `reacted verdict for icons=${JSON.stringify(icons)} label=${String(label)}`).toBe(true);
      }
    }
  }
});

// --- The comment row id -------------------------------------------------------------------

const LIVE_ROW_ID =
  'replaceableComment_urn:li:comment:(urn:li:activity:7488567705558478848,7488662513581137921)';

test('commentUrnFromRowId strips the row prefix and keeps the URN verbatim', () => {
  expect(commentUrnFromRowId(LIVE_ROW_ID))
    .toBe('urn:li:comment:(urn:li:activity:7488567705558478848,7488662513581137921)');
});

test('commentUrnFromRowId returns null for anything else', () => {
  expect(commentUrnFromRowId('replaceableComment_')).toBeNull();
  expect(commentUrnFromRowId('replaceableComment_urn:li:activity:1')).toBeNull();
  expect(commentUrnFromRowId('urn:li:comment:(urn:li:activity:1,2)')).toBeNull();
  expect(commentUrnFromRowId('')).toBeNull();
  expect(commentUrnFromRowId(null)).toBeNull();
  expect(commentUrnFromRowId(undefined)).toBeNull();
});
