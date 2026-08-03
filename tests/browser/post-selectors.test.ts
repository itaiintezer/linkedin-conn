import { test, expect } from 'vitest';
import { REACTIONS } from '../../src/core/engagement-action.js';
import {
  PSEL, REACTION_ICON_TYPE, REACTION_LABEL, reactionEntry,
  existingReactionFrom, commentNeedle,
  confirmPostedComment, type ThreadRow,
  POST_LOAD_TIMEOUT_MS, FLYOUT_TIMEOUT_MS, REACTED_TIMEOUT_MS, SUBMIT_ARM_TIMEOUT_MS,
  COMMENT_CONFIRM_TIMEOUT_MS,
} from '../../src/browser/post-selectors.js';

// Real selectors cannot be unit-tested without a browser — Task 15 does that live. What IS
// testable is that the vocabulary is complete, that the DOM enum is not derived by guesswork,
// and that no selector leans on a per-render id or a hashed class.

// --- The reaction map -------------------------------------------------------------------

test('REACTION_ICON_TYPE covers every reaction exactly once, with LinkedIn\'s own enum', () => {
  // Live-captured from the flyout's <img data-test-reactions-icon-type=…> (2026-08-02).
  // These deliberately do NOT match the display names — a case transform would mis-click.
  expect(REACTION_ICON_TYPE).toEqual({
    like: 'LIKE',
    celebrate: 'PRAISE',
    support: 'APPRECIATION',
    love: 'EMPATHY',
    insightful: 'INTEREST',
    funny: 'ENTERTAINMENT',
  });
  // Exactly the vocabulary, no extras and nothing missing. (A missing key is also a compile
  // error via Record<Reaction, …>; this is the runtime half of the same guarantee.)
  expect(Object.keys(REACTION_ICON_TYPE).sort()).toEqual([...REACTIONS].sort());
});

test('the icon enum is not derivable from the reaction name', () => {
  // Guards against someone "simplifying" the map into r.toUpperCase(): only `like` survives
  // that, and the other five would silently place the wrong reaction.
  const derivable = REACTIONS.filter((r) => REACTION_ICON_TYPE[r] === r.toUpperCase());
  expect(derivable).toEqual(['like']);
});

test('REACTION_LABEL covers every reaction exactly once', () => {
  expect(REACTION_LABEL).toEqual({
    like: 'Like', celebrate: 'Celebrate', support: 'Support',
    love: 'Love', insightful: 'Insightful', funny: 'Funny',
  });
  expect(Object.keys(REACTION_LABEL).sort()).toEqual([...REACTIONS].sort());
});

// --- Selector hygiene -------------------------------------------------------------------

/** Every class token a selector uses, e.g. "div.a-b__c--d" -> ["a-b__c--d"]. */
function classTokens(selector: string): string[] {
  return [...selector.matchAll(/\.([A-Za-z0-9_-]+)/g)].map((m) => m[1]);
}

/** Readable lowercase BEM, which is what this (classic Ember/artdeco) surface renders. */
const BEM = /^[a-z][a-z0-9]*(-[a-z0-9]+)*(__[a-z0-9]+(-[a-z0-9]+)*)?(--[a-z0-9]+(-[a-z0-9]+)*)?$/;

function allSelectors(): string[] {
  return [
    ...Object.values(PSEL),
    ...REACTIONS.map(reactionEntry),
  ];
}

test('no selector leans on an ember id', () => {
  // The post container was #ember34, the comment submit #ember147, the react trigger #ember49
  // — all regenerated per render.
  for (const sel of allSelectors()) {
    expect(sel, sel).not.toMatch(/ember\d/i);
    expect(sel, sel).not.toMatch(/#/);
  }
});

test('no selector leans on a hashed class name', () => {
  for (const sel of allSelectors()) {
    for (const cls of classTokens(sel)) expect(cls, `${cls} in ${sel}`).toMatch(BEM);
  }
});

test('the hashed-class rule would actually catch the hashed classes on this page', () => {
  // Both observed live in the same DOM the BEM classes came from: the <main> wrapper and a
  // comment's actor anchor. If the rule above stops rejecting these it is worthless.
  expect('KQDXAyoQSwHfBYctwYXOYFWlahffrWFNvTfFc').not.toMatch(BEM);
  expect('XQidInOZdUqrHGlQkkUpVUZDTyqjTPrnrE').not.toMatch(BEM);
});

// --- The hazards, pinned ----------------------------------------------------------------

test('the react-trigger selectors all require aria-pressed and the post action bar', () => {
  // aria-pressed is what makes the identity toggle (hazard: it switches the authoring
  // identity to a company page) and the flyout's keyboard affordance unreachable, and what
  // makes the toggle's current state readable before clicking. feed-shared-social-action-bar
  // is what excludes every comment's own like button — those live inside the post container
  // too, and share both react-button__trigger and span.reactions-react-button.
  for (const sel of [PSEL.reactTrigger, PSEL.reactTriggerUnreacted, PSEL.reactTriggerReacted]) {
    expect(sel).toContain('[aria-pressed');
    expect(sel).toContain('div.feed-shared-social-action-bar');
    expect(sel).toContain('span.reactions-react-button');
  }
  expect(PSEL.reactTriggerUnreacted).toContain('[aria-pressed="false"]');
  expect(PSEL.reactTriggerReacted).toContain('[aria-pressed="true"]');
  // The identity toggle is exported to be avoided, never selected as a click target.
  expect(PSEL.identityToggleNeverClick)
    .toBe('button[aria-label="Open menu for switching identity when interacting with this post"]');
});

test('a flyout entry requires the aria-label and the icon enum to agree, and excludes the trigger', () => {
  expect(reactionEntry('like')).toBe(
    'button[aria-label="React Like"]:not([aria-pressed]):has(img[data-test-reactions-icon-type="LIKE"])',
  );
  expect(reactionEntry('celebrate')).toBe(
    'button[aria-label="React Celebrate"]:not([aria-pressed]):has(img[data-test-reactions-icon-type="PRAISE"])',
  );
  for (const r of REACTIONS) {
    const sel = reactionEntry(r);
    // Without :not([aria-pressed]) the `like` entry also matches the post's own trigger,
    // which carries the identical bare label AND an img[data-test-reactions-icon-type="LIKE"].
    expect(sel, sel).toContain(':not([aria-pressed])');
    expect(sel, sel).toContain(`data-test-reactions-icon-type="${REACTION_ICON_TYPE[r]}"`);
    expect(sel, sel).toContain(`aria-label="React ${REACTION_LABEL[r]}"`);
  }
});

test('the comment submit control is selected by its BEM class, not its accessible name', () => {
  // Live-proven: it carries no aria-label, its accessible name is "Comment" (which the action
  // bar's own button shares), and artdeco pads its textContent with newlines so
  // hasText: /^Comment$/ matches nothing at all.
  expect(PSEL.commentSubmit).toBe('button.comments-comment-box__submit-button--cr');
  expect(PSEL.commentSubmit).not.toContain('aria-label');
});

test('the action bar comment control does not depend on English', () => {
  // Its absence is read as "the author disabled comments" — a terminal skip that never
  // touches the failure streak. An English-only probe therefore turns a Hebrew cold-load
  // render (observed on this account; hence the pinned `lang` cookie) into a silent
  // retirement of every comment-bearing task. The BEM class is the load-bearing signal and
  // must come first; the aria-label survives only as a fallback.
  expect(PSEL.commentButton).toContain('.comment-button');
  expect(PSEL.commentButton).toContain('div.feed-shared-social-action-bar');
  expect(PSEL.commentButton.indexOf('.comment-button'))
    .toBeLessThan(PSEL.commentButton.indexOf('aria-label'));
  // Stripping the English half must still leave a usable selector.
  expect(PSEL.commentButton.replace(/,\s*\[aria-label="Comment"\]/, ''))
    .toBe('div.feed-shared-social-action-bar button:is(.comment-button)');
});

test('the post container is matched on its two semantic attributes', () => {
  expect(PSEL.postContainer).toBe('div[data-urn][role="article"]');
});

test('the detail shell scopes that container without depending on English', () => {
  // postContainer is page-wide and its data-urn becomes the row's identity via reconcileUrn,
  // so the shell is what stops DOM order from deciding which post a row IS. The same element
  // carries aria-label="Update container" inside main[aria-label="Feed detail update"] —
  // both English, both unusable for a surface that has rendered Hebrew on a cold load.
  expect(PSEL.detailShell).toBe('div.update-outlet');
  expect(PSEL.detailShell).not.toContain('aria-label');
});

test('composer selectors match the live Quill editor and form', () => {
  expect(PSEL.commentForm).toBe('form.comments-comment-box__form');
  expect(PSEL.commentEditor).toBe('div.ql-editor[contenteditable="true"][role="textbox"]');
  expect(PSEL.commentEntity).toBe('article.comments-comment-entity[data-id^="urn:li:comment:"]');
  expect(PSEL.commentBody).toBe('span.comments-comment-item__main-content');
});

// --- confirmPostedComment ---------------------------------------------------------------
//
// The verdict used to be computed inside page.evaluate, which is why the broken attribution
// marker below survived a live run: nothing could reach it from a test. It is a pure
// function over what the page reported, so all of this runs without a browser.

/** The comment this pipeline actually posted on 2026-08-02, verbatim from the live DOM.
 *  Its data-id is keyed on a `ugcPost` URN with an id that appears NOWHERE else — the post's
 *  own container called itself `urn:li:activity:7487584764410019841`. */
const LIVE_ID = 'urn:li:comment:(ugcPost:7487584763386560512,7489660459537788928)';

const row = (dataId: string, body: string, meta = ''): ThreadRow => ({ dataId, body, meta });

test('confirmPostedComment matches a comment whose URN type and id we could never have known', () => {
  // THE REGRESSION. The old marker was `(activity:<container id>,` and this row does not
  // contain it, so attribution was silently false on every ugcPost-backed post (which is
  // what a re-share is) and the verdict fell back to "any row containing our text".
  // Novelty is what identifies our comment now, so the URN is not consulted at all.
  const seen = confirmPostedComment([row(LIVE_ID, '👀', 'Itai Tevet • You')], [''], '👀', []);
  expect(seen.matched).toBe(true);
  expect(seen.commentId).toBe(LIVE_ID);
  expect(seen.cleared).toBe(true);
});

test('confirmPostedComment refuses a needle-bearing row that was already in the thread', () => {
  // The cross-confirmation case the design doc flags: somebody else's comment carrying our
  // text must never confirm ours. It was present BEFORE we clicked submit, so it is not ours,
  // and no amount of text match may promote it.
  const stranger = row('urn:li:comment:(ugcPost:7487584763386560512,111)', 'great post 👀');
  const seen = confirmPostedComment([stranger], [''], 'great post 👀', [stranger.dataId]);
  expect(seen.matched).toBe(false);
  expect(seen.commentId).toBeNull();
});

test('confirmPostedComment matches the new row on a thread that started empty', () => {
  // A re-share detail page with no comments yet — verified live on
  // urn:li:ugcPost:7490079826100297728, which rendered zero comment rows.
  const seen = confirmPostedComment([row(LIVE_ID, 'welcome to Black Hat')], [''],
    'welcome to Black Hat', []);
  expect(seen.matched).toBe(true);
});

test('confirmPostedComment picks OUR new row out of several that arrived', () => {
  const old = row('urn:li:comment:(activity:1,111)', 'an older comment');
  const other = row('urn:li:comment:(activity:1,222)', 'someone else, also new');
  const ours = row('urn:li:comment:(activity:1,333)', 'ours 👀');
  const seen = confirmPostedComment([old, other, ours], [''], 'ours 👀', [old.dataId]);
  expect(seen.commentId).toBe(ours.dataId);
  expect(seen.matched).toBe(true);
});

test('confirmPostedComment reports not-cleared while a composer still holds our text', () => {
  // `cleared` is the second independent signal, and a composer that still shows the text
  // means the submit did not take. Parks as `unverified` rather than claiming success.
  const seen = confirmPostedComment([row(LIVE_ID, '👀')], ['👀'], '👀', []);
  expect(seen.matched).toBe(true);
  expect(seen.cleared).toBe(false);
});

test('confirmPostedComment reads the English You badge without letting it decide', () => {
  // Corroborating only — LinkedIn has been observed rendering Hebrew, so a missing badge must
  // never cost a confirmed comment.
  expect(confirmPostedComment([row(LIVE_ID, '👀', 'Itai Tevet • You Premium')], [''], '👀', []))
    .toMatchObject({ matched: true, ownBadge: true });
  expect(confirmPostedComment([row(LIVE_ID, '👀', 'איתי טבת')], [''], '👀', []))
    .toMatchObject({ matched: true, ownBadge: false });
});

test('confirmPostedComment confirms nothing on an empty needle', () => {
  // A whitespace-only comment cannot be recognised in the thread, so it must not be able to
  // confirm by matching every row. Mirrors the `want.length > 0` guard this replaces.
  const seen = confirmPostedComment([row(LIVE_ID, '👀')], [''], '', []);
  expect(seen.matched).toBe(false);
  expect(seen.cleared).toBe(false);
});

test('confirmPostedComment tolerates the whitespace the rendered thread collapses', () => {
  // Both sides are normalized: the needle comes from commentNeedle and the body from
  // textContent, and the thread wraps and indents freely.
  const seen = confirmPostedComment([row(LIVE_ID, 'Congrats on the launch')], [''],
    commentNeedle('Congrats   on the\n  launch'), []);
  expect(seen.matched).toBe(true);
});

// --- existingReactionFrom ---------------------------------------------------------------

test('existingReactionFrom reads the reaction out of an Unreact label', () => {
  expect(existingReactionFrom('Unreact Like')).toBe('like');
  expect(existingReactionFrom('Unreact Celebrate')).toBe('celebrate');
  expect(existingReactionFrom('Unreact Insightful')).toBe('insightful');
  expect(existingReactionFrom('  Unreact Love  ')).toBe('love');
});

test('existingReactionFrom passes through a reaction we do not model', () => {
  // EngagementOutcome.existingReaction is typed `string` for exactly this: LinkedIn adding a
  // reaction must produce a surprising log line, not a dropped value.
  expect(existingReactionFrom('Unreact Curious')).toBe('curious');
});

test('existingReactionFrom returns undefined for anything that is not a bare Unreact label', () => {
  // Not reacted at all.
  expect(existingReactionFrom('React Like')).toBeUndefined();
  // A COMMENT's own like button. Never a post-level reaction, however it reaches here.
  expect(existingReactionFrom('Unreact Like to Itai Tevet’s comment')).toBeUndefined();
  // Hebrew — LinkedIn ignores Playwright's locale and can render it on a cold load, which is
  // why the `already` verdict is decided by aria-pressed and never by this string. Losing the
  // name costs a less informative log line and cannot change a verdict.
  expect(existingReactionFrom('בטל לייק')).toBeUndefined();
  expect(existingReactionFrom('')).toBeUndefined();
  expect(existingReactionFrom(null)).toBeUndefined();
  expect(existingReactionFrom(undefined)).toBeUndefined();
  expect(existingReactionFrom('Unreact')).toBeUndefined();
});

// --- commentNeedle ----------------------------------------------------------------------

test('commentNeedle survives an astral-plane emoji', () => {
  // The live-verified comment was a bare 👀. A UTF-16 slice would have produced half a
  // surrogate pair and never matched the posted row.
  expect(commentNeedle('\u{1F440}')).toBe('\u{1F440}');
  expect([...commentNeedle('\u{1F440}'.repeat(60))].length).toBe(40);
  // No lone surrogates survived the truncation.
  expect(commentNeedle('\u{1F440}'.repeat(60))).toBe('\u{1F440}'.repeat(40));
});

test('commentNeedle normalizes whitespace and uses only the first line', () => {
  // The rendered thread collapses whitespace, and how Quill keeps a multi-line comment's
  // breaks is not ours to control — so only the first line is compared.
  expect(commentNeedle('hello   world')).toBe('hello world');
  expect(commentNeedle('  padded  ')).toBe('padded');
  expect(commentNeedle('first line\nsecond line')).toBe('first line');
  expect(commentNeedle('first\r\nsecond')).toBe('first');
  expect(commentNeedle('first\rsecond')).toBe('first');
});

test('commentNeedle truncates by code point and tolerates degenerate input', () => {
  expect(commentNeedle('abcdef', 3)).toBe('abc');
  expect(commentNeedle('abcdef', 0)).toBe('');
  expect(commentNeedle('abcdef', -5)).toBe('');
  expect(commentNeedle('')).toBe('');
  expect(commentNeedle('\n\n')).toBe('');
});

// --- Bounded waits ----------------------------------------------------------------------

test('every wait is bounded, and the comment confirmation is the most patient one', () => {
  // A "wait for X" with no timeout would hang the sender tick and, for the comment, block
  // holding the browser lock. The confirmation poll is the longest because a timeout there is
  // `unverified` (park it) rather than `error` (retry it).
  for (const ms of [POST_LOAD_TIMEOUT_MS, FLYOUT_TIMEOUT_MS, REACTED_TIMEOUT_MS,
    SUBMIT_ARM_TIMEOUT_MS, COMMENT_CONFIRM_TIMEOUT_MS]) {
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(20000);
  }
  // The flyout was observed settling well within 2.5 s; anything much longer would mean
  // hovering with the pointer parked on a live control for no reason.
  expect(FLYOUT_TIMEOUT_MS).toBeLessThanOrEqual(5000);
});
