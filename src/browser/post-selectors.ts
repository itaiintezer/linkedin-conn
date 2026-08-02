/**
 * Selectors for a post's reaction bar and comment box.
 *
 * Every one of these was captured from the live DOM on 2026-08-02
 * (scripts/probe-post-engage.ts, dumps under data/incidents/*-post-engage/) and then
 * proven by performing real engagements — a Like and a `👀` comment that actually posted.
 * See the "Discovery findings" section of
 * docs/superpowers/specs/2026-08-02-engagements-pipeline-design.md.
 *
 * The surface is the classic Ember/artdeco feed UI, not the hashed-class React UI the
 * profile top card uses, so its BEM classes are readable and stable. Two rules still hold:
 *
 *  1. `ember####` ids are per-render (the post container was `#ember34`, the comment submit
 *     `#ember147`). Never select on them.
 *  2. Prefer `aria-*` and `data-*`. The one place a class is the RIGHT answer is the comment
 *     submit control — see `commentSubmit`.
 *
 * THREE HAZARDS this module exists to defuse:
 *
 *  A. The react trigger is a TOGGLE. Clicking it while `aria-pressed="true"` REMOVES the
 *     reaction. `reactTriggerReacted` is how the driver reads state before touching it.
 *  B. The action bar's FIRST button is an identity toggle (`identityToggleNeverClick`). On an
 *     account that administers company pages, clicking it switches the authoring identity.
 *     Nothing here is positional, so the bar's ordering is never relied on.
 *  C. Comment-level controls live INSIDE the post container — verified by walking the
 *     post-comment page dump: `article.comments-comment-entity`, the composer, and a
 *     comment's own `React Like to <Name>'s comment` trigger are all descendants of
 *     `div[data-urn][role="article"]`. Scoping to the post therefore does NOT separate
 *     post-level controls from comment-level ones; the structural path through
 *     `div.feed-shared-social-action-bar` does (that class is absent from comment social
 *     bars, whereas `react-button__trigger` and `span.reactions-react-button` are shared by
 *     both).
 */
import type { Reaction } from '../core/engagement-action.js';

/** LinkedIn's own reaction enum, as it appears in `data-test-reactions-icon-type`. */
export type ReactionIconType =
  'LIKE' | 'PRAISE' | 'APPRECIATION' | 'EMPATHY' | 'INTEREST' | 'ENTERTAINMENT';

/**
 * OUR reaction name -> LinkedIn's enum. An explicit map, because the enum does NOT match the
 * display name: celebrate is PRAISE, support is APPRECIATION, love is EMPATHY, insightful is
 * INTEREST, funny is ENTERTAINMENT. A case transform would silently click the wrong one.
 *
 * Typed `Record<Reaction, …>` on purpose: a reaction added to `REACTIONS` without a DOM
 * mapping fails to COMPILE here rather than mis-clicking at run time.
 */
export const REACTION_ICON_TYPE: Record<Reaction, ReactionIconType> = {
  like: 'LIKE',
  celebrate: 'PRAISE',
  support: 'APPRECIATION',
  love: 'EMPATHY',
  insightful: 'INTEREST',
  funny: 'ENTERTAINMENT',
};

/**
 * OUR reaction name -> the flyout entry's `aria-label` suffix ("React <Display>").
 * Spelt out rather than capitalised for the same compile-time reason as above. These are
 * English, and English is what the pinned `lang` cookie gets us (both probed posts rendered
 * `<html lang="en">`); they are used only as the click target, never as an identity — the
 * identity is the language-independent enum above.
 */
export const REACTION_LABEL: Record<Reaction, string> = {
  like: 'Like',
  celebrate: 'Celebrate',
  support: 'Support',
  love: 'Love',
  insightful: 'Insightful',
  funny: 'Funny',
};

export const PSEL = {
  /**
   * The post itself, and the source of `observedUrn`:
   * `div.feed-shared-update-v2[role="article"][data-urn="urn:li:activity:…"]`.
   * Verified on BOTH probed posts (an individual member's and a company page's) AND on both
   * URL shapes — the individual post was loaded from a `/posts/<slug>-share-…` link and still
   * rendered the same `main[aria-label="Feed detail update"]` shell with `data-urn` present.
   * Matched on the two semantic attributes only; the class and the `#ember34` id are not used.
   */
  postContainer: 'div[data-urn][role="article"]',

  /** The post-level action bar. Absent from comment social bars, which is what makes it the
   *  scope that separates the post's own controls from every comment's. */
  actionBar: 'div.feed-shared-social-action-bar',

  /**
   * NEVER CLICK. The bar's first button on an account that administers pages: clicking it
   * switches the authoring identity to a company page for subsequent actions. Exported so the
   * hazard is visible in code and so evidence can record whether the bar rendered it.
   */
  identityToggleNeverClick:
    'button[aria-label="Open menu for switching identity when interacting with this post"]',

  /**
   * The post-level react trigger, located structurally: the `aria-pressed` button inside the
   * action bar's react wrapper.
   *
   * Why not the aria-label form the probe used (`button[aria-pressed][aria-label^="React "]`)?
   * Because the prefix also matches a comment's own like button
   * (`React Like to <Name>'s comment`), which lives inside the post container too, and the
   * bare-vs-suffixed distinction only holds while LinkedIn renders English. This path is
   * language-independent, and it cannot resolve to:
   *   - the identity toggle (hazard B) — it carries no `aria-pressed`;
   *   - the flyout's keyboard affordance (`button[aria-label="Open reactions menu"]`) — also
   *     no `aria-pressed`;
   *   - a flyout entry — same, no `aria-pressed`;
   *   - a comment's like button — `feed-shared-social-action-bar` is not in a comment.
   */
  reactTrigger: 'div.feed-shared-social-action-bar span.reactions-react-button button[aria-pressed]',
  /** The trigger with NO reaction on it — the only thing that is ever safe to click. */
  reactTriggerUnreacted:
    'div.feed-shared-social-action-bar span.reactions-react-button button[aria-pressed="false"]',
  /**
   * REACTED_STATE. `aria-pressed="true"` is the signal: semantic, boolean, language-
   * independent, and verified as a live before/after (the same click also flipped the label
   * `React Like` -> `Unreact Like`, added `react-button--active`, and moved the social count
   * from "6 | Jamie Garrison and 5 others" to "7 | You and 6 others").
   *
   * Read this BEFORE opening the flyout: the flyout entries do NOT reflect current state (on
   * the already-reacted company post the Like entry still read `React Like`), so only the
   * trigger knows. And read it before clicking anything, because the click is a toggle.
   */
  reactTriggerReacted:
    'div.feed-shared-social-action-bar span.reactions-react-button button[aria-pressed="true"]',

  /**
   * The hover-opened reaction flyout. NOT a `role="menu"`, and its items are not
   * `role="menuitem"` — plain `<button type="button" tabindex="-1">` inside a `span`.
   *
   * The design doc says this span is "always in the DOM and becomes visible by class"; the
   * dumps disagree — `reactions-menu` appears in NO pre-hover or post-hover-closed page dump,
   * only in the capture taken while the pointer was on the trigger. So the driver waits for an
   * ENTRY to become visible after hovering rather than trusting a container state class. Kept
   * here for diagnostics and for that documentation.
   */
  reactionFlyout: 'span.reactions-menu',

  // --- Comment box (live-verified: a `👀` comment posted through exactly these) ---

  /**
   * The action bar's Comment button. Only needed when arriving from the feed: on a post
   * detail page (both `/feed/update/` and `/posts/…`) the composer is already inline.
   *
   * TWO SIGNALS, ORed, and the language-independent one is listed first. This used to be
   * `button[aria-label="Comment"]` alone, which is English — and LinkedIn has been observed
   * rendering Hebrew on a cold load (hence the pinned `lang` cookie). That mattered for more
   * than a missed click: the driver reads the ABSENCE of this control as evidence that the
   * author disabled commenting, a terminal skip that deliberately never touches the failure
   * streak. An English-only probe turned "we cannot read this page" into "this post has
   * comments off", silently, for every comment-bearing task.
   *
   * `comment-button` is a readable BEM class on the same element, present in all six live
   * dumps (data/incidents/*-post-engage/action-bar.html) and — checked page-wide on the dump
   * taken with two comments rendered — matching exactly ONE element, the post's own control.
   * Scoped to the post action bar regardless, which is what excludes comment-level controls.
   */
  commentButton:
    'div.feed-shared-social-action-bar button:is(.comment-button, [aria-label="Comment"])',
  /** The composer form. */
  commentForm: 'form.comments-comment-box__form',
  /** The composer's Quill editor. Content is `<p>…</p>`, so it must be driven with
   *  `insertText`, not per-key typing — the verified `👀` is astral-plane and per-key typing
   *  mangles it. */
  commentEditor: 'div.ql-editor[contenteditable="true"][role="textbox"]',
  /**
   * The submit control. THE ONE PLACE A CLASS IS RIGHT.
   *
   * It does not exist in the DOM until the editor has text — its presence IS the armed
   * signal, there is no disabled->enabled transition to wait on — and when it appears it
   * carries NO `aria-label`. Its accessible name is `Comment`, which the action bar's own
   * button also uses.
   *
   * Locating it by accessible name PROVABLY FAILS and cost a failed live attempt: artdeco
   * pads the button's textContent with newlines, so `hasText: /^Comment$/` matched zero
   * elements with the button plainly in the DOM. Dropping the anchor collides with the action
   * bar's Comment button. This BEM class exists only on the composer's submit control.
   */
  commentSubmit: 'button.comments-comment-box__submit-button--cr',

  /** A comment in the thread. `data-id` embeds the POST's urn as
   *  `urn:li:comment:(activity:<postId>,<commentId>)`, so a comment can be attributed to its
   *  post without trusting page context. */
  commentEntity: 'article.comments-comment-entity[data-id^="urn:li:comment:"]',
  /** A comment's body text. */
  commentBody: 'span.comments-comment-item__main-content',
  /** A comment's meta line. Carries a `• You` badge on our own comments (as plain text — there
   *  is no dedicated class for it), and the actor anchor whose href is the author's profile. */
  commentMeta: 'div.comments-comment-meta__container',
  /** The author link inside a comment's meta line. */
  commentActor: 'a.comments-comment-meta__description-container',

  /**
   * PROVISIONAL — never observed live. Neither probed post had comments restricted, so the
   * structural signal is unknown and is deliberately NOT guessed at: this is a wording probe
   * only, and every comments-disabled verdict captures evidence so a real restricted post can
   * be read from the incident rather than from a guess.
   */
  commentsDisabledText:
    'text=/comments (are )?(off|disabled|restricted)|turned off comments|no longer accepting comments/i',
} as const;

/**
 * The flyout entry for one reaction.
 *
 * Both discovered signals must agree, which is what makes a mis-click impossible:
 *  - the `aria-label` is the click target ("React Celebrate");
 *  - `data-test-reactions-icon-type` on the entry's `<img>` is the language-independent
 *    identity ("PRAISE").
 * `:not([aria-pressed])` excludes the trigger itself, which carries the same bare
 * `aria-label="React Like"` when unreacted AND an `img[data-test-reactions-icon-type="LIKE"]`.
 * Without it, the `like` selector would resolve to the trigger.
 */
export function reactionEntry(reaction: Reaction): string {
  return `button[aria-label="React ${REACTION_LABEL[reaction]}"]:not([aria-pressed])`
    + `:has(img[data-test-reactions-icon-type="${REACTION_ICON_TYPE[reaction]}"])`;
}

/** Comment rows belonging to one post id, whatever URN type the container reported. */
export function commentRowsForPost(postId: string): string {
  return `article.comments-comment-entity[data-id^="urn:li:comment:(activity:${postId},"]`;
}

/**
 * The reaction named by a reacted trigger's `aria-label` ("Unreact Like" -> "like").
 *
 * English-dependent BY NATURE, and that is contained: this value only ever reaches a log line
 * and `EngagementOutcome.existingReaction`. The `already` verdict itself is decided by
 * `aria-pressed`, which is language-independent, so an unrecognised label costs a less
 * informative log line and NEVER a wrong already/done verdict. LinkedIn has been observed to
 * render Hebrew on a cold load (hence the pinned `lang` cookie), so this returning `undefined`
 * is an expected outcome, not a bug.
 *
 * Requires the BARE two-word form. `Unreact Like to <Name>'s comment` — a comment's own
 * button — returns undefined rather than being mistaken for a post-level reaction. An
 * unmodelled reaction (LinkedIn adding one) comes back as its lowercased word, which is why
 * `existingReaction` is typed `string` and not `Reaction`.
 */
export function existingReactionFrom(ariaLabel: string | null | undefined): string | undefined {
  const m = /^Unreact\s+(\S+)$/i.exec((ariaLabel ?? '').trim());
  // Lowercased so a recognised reaction comes back as one of REACTIONS verbatim; an
  // unrecognised word is passed through as-is rather than dropped.
  return m ? m[1].toLowerCase() : undefined;
}

/** The numeric id inside a `urn:li:<type>:<id>`, or null. Used to match a post against the
 *  post id embedded in a comment's `data-id`. */
export function urnNumericId(urn: string | null | undefined): string | null {
  return /^urn:li:[A-Za-z]+:(\d+)$/.exec((urn ?? '').trim())?.[1] ?? null;
}

export interface CommentIdParts {
  /** The post's URN type as the comment reports it — `activity` on every observed row. */
  postType: string;
  postId: string;
  commentId: string;
}

/** Split `urn:li:comment:(activity:<postId>,<commentId>)`. Null for anything else. */
export function commentIdParts(dataId: string | null | undefined): CommentIdParts | null {
  const m = /^urn:li:comment:\(([A-Za-z]+):(\d+),(\d+)\)$/.exec((dataId ?? '').trim());
  return m ? { postType: m[1], postId: m[2], commentId: m[3] } : null;
}

/**
 * The needle used to recognise our own comment in the thread.
 *
 * Only the FIRST LINE is used: `insertText` drives a Quill editor whose model is `<p>…</p>`,
 * so how a multi-line comment's breaks survive is not something we control, and a
 * whitespace difference must not turn a comment that DID post into an `unverified` that
 * pesters the operator.
 *
 * Truncated by CODE POINT, not by UTF-16 unit. `'👀'.slice(0, 1)` is half a surrogate pair,
 * and the emoji this flow was verified with is astral-plane — a naive slice would compare a
 * broken needle and never match.
 */
export function commentNeedle(text: string, maxCodePoints = 40): string {
  const firstLine = text.replace(/\r\n?/g, '\n').split('\n')[0] ?? '';
  const normalized = firstLine.replace(/\s+/g, ' ').trim();
  return [...normalized].slice(0, Math.max(0, maxCodePoints)).join('');
}

/** How long a post detail page gets to render its container. */
export const POST_LOAD_TIMEOUT_MS = 15000;
/** The flyout "settles well within 2.5 s" after hover (observed). */
export const FLYOUT_TIMEOUT_MS = 3000;
/** How long `aria-pressed="true"` gets to appear after the click. Mirrors the 9 s the invite
 *  flow gives the Pending badge — the same "LinkedIn's own state is the confirmation" wait. */
export const REACTED_TIMEOUT_MS = 9000;
/** How long the submit control gets to appear after the editor is filled. Its presence is the
 *  armed signal, so this is the "did the text register" wait. */
export const SUBMIT_ARM_TIMEOUT_MS = 9000;
/** How long the posted comment gets to show up in the thread. Polled, like the event picker's
 *  load and submit waits. A timeout here is `unverified`, NEVER `error`. */
export const COMMENT_CONFIRM_TIMEOUT_MS = 12000;
