/**
 * Selectors for the hashed-class React post detail surface — the SECOND post UI.
 *
 * LinkedIn is rolling this surface out per-account: one account (2026-08-05, another
 * operator's) renders posts with hashed classes, per-render `componentkey` UUIDs and NO
 * `data-urn` / `aria-pressed` / BEM vocabulary, while this repo's own account still renders
 * the classic Ember/artdeco surface that `post-selectors.ts` (PSEL) describes. Both are live
 * at once, so BOTH modules exist and the driver detects which one rendered per page load —
 * neither replaces the other. See docs/superpowers/specs/ and the imported diagnosis
 * (2026-08-05-engagement-react-selector-rot-fix.md) for the captured DOM this encodes.
 *
 * Rules on this surface, and they are stricter than PSEL's:
 *
 *  1. NO CLASSES AT ALL. There is no such thing as a stable class here — the hashed ones
 *     rotate per build, and the readable ones (`tiptap`) are a third-party library's. A BEM
 *     shape check provably fails to reject `c21779e1`, so the rule is total.
 *  2. NO STATE-ENCODING SELECTORS. `aria-pressed` is gone, so "reacted" vs "unreacted" is a
 *     judgement over the trigger's icon + label (`readReactionVerdict`), never a selector
 *     match — a selector that encodes state lets a caller infer "unreacted" from a
 *     non-match, and that inference is how a toggle silently un-likes a post.
 *  3. The post container is DERIVED, not assumed: the shell's own id embeds the post key
 *     (`expanded<postKey>FeedType_FEED_DETAIL`), and `div[componentkey="<postKey>"]` is the
 *     post. Read from one element, used to find the other.
 *
 * THE TOGGLE HAZARD, restated for this surface: clicking the trigger while a reaction is on
 * it REMOVES the reaction. With `aria-pressed` gone, "no evidence of a reaction" and
 * "provably no reaction" are different statements. A click is green-lit ONLY on a positive
 * unreacted signal (the outline thumb icon), never on the absence of a reacted one.
 */
import type { Reaction } from '../core/engagement-action.js';
import { REACTION_LABEL } from './post-selectors.js';

export const RSEL = {
  /**
   * The post-detail shell: `id == "expanded" + <postKey> + "FeedType_FEED_DETAIL"`.
   * Exactly one per page in all four live captures. BOTH ends of the id are required —
   * the page carries four other ids sharing the suffix (`…replaceableCommentTools…`,
   * `commentBoxLinkPreview-…`, `UpdateDetailSkeletonRef…`, `UpdateDetailSimilarPagesSlot…`).
   */
  detailShell: 'div[id^="expanded"][id$="FeedType_FEED_DETAIL"]',

  /**
   * The post-level react trigger. Three arms, matched as a union and REQUIRED by the driver
   * to resolve uniquely inside the post scope:
   *   - the `Reaction button state: …` label (English — the pinned `lang` cookie's render);
   *   - the outline thumb icon (language-independent, present when unreacted);
   *   - any `*-consumption-*` glyph inside a real `<button>` (language-independent, present
   *     when reacted).
   * A comment's own like control is an `<svg>` inside a `div[role="button"]` — not a
   * `<button>` — and comments live OUTSIDE the post container on this surface, so container
   * scoping excludes them structurally and the tag name is the second fence.
   *
   * Matching either state on purpose: state is then READ off the resolved element by
   * `readReactionVerdict`, never inferred from which selector matched (rule 2 above).
   */
  reactTrigger:
    'button[aria-label^="Reaction button state"], '
    + 'button:has(svg[id="thumbs-up-outline-small"]), '
    + 'button:has(svg[id*="-consumption-"])',

  /**
   * The flyout's keyboard affordance — the chevron next to the trigger. The click fallback
   * when hovering does not mount the flyout. Icon-first because the `Open reactions menu`
   * label is English; comment rows carry the same labelled button, which is why the driver
   * scopes this to the post and requires uniqueness.
   */
  reactionsMenuTrigger: 'button:has(svg[id="chevron-up-small"]), button[aria-label="Open reactions menu"]',

  /**
   * The action bar's Comment button. The new control carries NO aria-label at all, so this
   * is language-independent outright. Its absence is HALF of a `comments_disabled` verdict —
   * a terminal skip that never touches the failure streak — so it must never be able to fail
   * on a Hebrew render; the other half is the composer being absent from the WHOLE SHELL
   * (post-container absence is trivially true here: the composer sits outside the post).
   */
  commentButton: 'button:has(svg[id="comment-small"])',

  /** The comment composer wrapper (Tiptap/ProseMirror). Inside the shell, OUTSIDE the post. */
  commentComposer: 'div[data-testid="ui-core-tiptap-text-editor-wrapper"]',

  /** The editable surface inside that wrapper. Driven with `insertText` in one shot — the
   *  same astral-plane-emoji reason as the classic Quill editor. */
  commentEditor:
    'div[data-testid="ui-core-tiptap-text-editor-wrapper"] div[contenteditable="true"][role="textbox"]',

  /**
   * The submit control. DOES NOT EXIST until the editor has text — its presence IS the armed
   * signal. The button itself carries no aria-label and only hashed classes; its accessible
   * name is "Comment", which the action bar's own button shares (locating by accessible name
   * provably failed on the classic surface and cost a live attempt). The container id
   * (`…commentButtonSection<postKey>FeedType_FEED_DETAIL`) needs no such gamble.
   */
  commentSubmit: 'div[id*="commentButtonSection"] button',

  /** A comment row. Its own id embeds the comment URN — read `id`, not `data-id`, and note
   *  the rows sit OUTSIDE the post container (the classic UI put them inside it). */
  commentEntity: 'div[id^="replaceableComment_urn:li:comment:"]',

  /** A comment's body text, inside its row. */
  commentBody: 'span[data-testid="expandable-text-box"]',

  /**
   * The post's own URN in a single machine-readable attribute:
   * `data-testid="ReactionFacepileCollection-<urn>"`. A BETTER `observedUrn` source than
   * harvesting hrefs: a re-share's container also links to the ORIGINAL post's URN, and
   * `observedUrn` feeds `reconcileUrn`, which rewrites the row's identity unconditionally —
   * an href harvest would re-key the row onto somebody else's post. The facepile testid is
   * singular and matched the URL on all four captures, re-share included.
   */
  urnCarrier: '[data-testid^="ReactionFacepileCollection-"]',
} as const;

/** The outline thumb — THE positive "no reaction is on this trigger" signal. */
export const TRIGGER_OUTLINE_ICON = 'thumbs-up-outline-small';

/**
 * Icon-id family -> OUR reaction name, for `*-consumption-*` glyph ids. An explicit map for
 * the same reason as PSEL's REACTION_ICON_TYPE: the families do NOT match the display names
 * (praise is celebrate, empathy is love, …), and on THIS surface support is `support-…` —
 * not the classic enum's APPRECIATION — so neither a case transform nor the classic map
 * could produce these.
 */
export const CONSUMPTION_FAMILY: Record<string, Reaction> = {
  like: 'like',
  praise: 'celebrate',
  support: 'support',
  empathy: 'love',
  interest: 'insightful',
  entertainment: 'funny',
};

/**
 * The reaction named by a `*-consumption-*` glyph id ("like-consumption-small" -> "like"),
 * or undefined for anything else (including the outline icon). An unmodelled family passes
 * through lowercased rather than being dropped — same contract as `existingReactionFrom`.
 * Tolerant of size/`-mixed` suffixes on purpose: only the family prefix is identity.
 */
export function reactionFromConsumptionIcon(iconId: string | null | undefined): string | undefined {
  const m = /^([a-z]+)-consumption-/.exec((iconId ?? '').trim());
  if (!m) return undefined;
  return CONSUMPTION_FAMILY[m[1]!] ?? m[1]!;
}

/**
 * OUR reaction name -> the flyout entry's `<svg>` id. SPELT OUT, never templated: `support`
 * is `support-…` (not `appreciation-…`), and `celebrate` carries a `-mixed` suffix no other
 * entry has. Captured from the real hovered flyout (the flyout only exists while open, so no
 * failure dump contains it). A test fails if someone templates these.
 */
export const FLYOUT_ENTRY_ICON: Record<Reaction, string> = {
  like: 'like-consumption-large',
  celebrate: 'praise-consumption-large-mixed',
  support: 'support-consumption-large',
  love: 'empathy-consumption-large',
  insightful: 'interest-consumption-large',
  funny: 'entertainment-consumption-large',
};

/**
 * The flyout entry for one reaction. Entry labels on this surface are BARE display names
 * ("Like", previously "React Like"), and both signals must agree on one element — the label
 * is the click target, the icon id is the language-independent identity. The flyout is
 * portalled to the body root, so the driver matches this page-wide and requires uniqueness.
 */
export function flyoutEntry(reaction: Reaction): string {
  return `button[aria-label="${REACTION_LABEL[reaction]}"]:has(svg[id="${FLYOUT_ENTRY_ICON[reaction]}"])`;
}

/** The token alphabet actually observed in post keys (base64url-ish). */
const POST_KEY = /^[A-Za-z0-9_-]+$/;

/**
 * The post key sliced out of the shell's id, or null. `expanded<postKey>FeedType_FEED_DETAIL`
 * -> `<postKey>`. Null on anything malformed — a partial key must NEVER become
 * `div[componentkey=""]`, which would match the first keyless div on the page, and the key
 * is injected into an attribute selector so it is confined to the observed token alphabet.
 */
export function postKeyFromShellId(shellId: string | null | undefined): string | null {
  const m = /^expanded(.*)FeedType_FEED_DETAIL$/.exec(shellId ?? '');
  const key = m?.[1] ?? '';
  return POST_KEY.test(key) ? key : null;
}

/**
 * The post container derived from a shell's post key: `div[componentkey="<postKey>"]`.
 * Throws on a key `postKeyFromShellId` would not have produced rather than emitting a
 * selector that matches the wrong element.
 */
export function postContainerSelector(postKey: string): string {
  if (!POST_KEY.test(postKey)) {
    throw new Error(`malformed post key for a componentkey selector: ${JSON.stringify(postKey)}`);
  }
  return `div[componentkey="${postKey}"]`;
}

/** The URN out of a facepile testid (`ReactionFacepileCollection-<urn>` -> `<urn>`). */
export function urnFromFacepileTestid(testid: string | null | undefined): string | undefined {
  const m = /^ReactionFacepileCollection-(urn:li:\S+)$/.exec((testid ?? '').trim());
  return m?.[1];
}

/** What the trigger's aria-label asserts, or undefined when it does not parse (the Hebrew
 *  cold-load case — this surface's labels are English under the pinned `lang` cookie). */
export type TriggerLabelState = { kind: 'none' } | { kind: 'named'; reaction: string };

/**
 * Parse `Reaction button state: …`. "no reaction" -> none; a display name -> our reaction
 * name (unmodelled names pass through lowercased, same contract as everywhere else).
 * English BY NATURE and used only as a corroborating signal — the icon is primary.
 */
export function reactionStateFromLabel(label: string | null | undefined): TriggerLabelState | undefined {
  const m = /^Reaction button state:\s*(.+)$/.exec((label ?? '').trim());
  if (!m) return undefined;
  const name = m[1]!.trim();
  if (/^no reaction$/i.test(name)) return { kind: 'none' };
  return { kind: 'named', reaction: name.toLowerCase() };
}

export type ReactionVerdict =
  | { state: 'unreacted' }
  | { state: 'reacted'; existingReaction?: string }
  | { state: 'unknown'; why: string };

/**
 * The whole judgement of the trigger's state, pure. Two signals, asymmetric ON PURPOSE:
 * the icon is primary (language-independent), the label corroborates and names.
 *
 *   icon            | label              | verdict     | why
 *   ----------------+--------------------+-------------+------------------------------------
 *   outline thumb   | "no reaction"      | unreacted   | both agree — safe to click
 *   outline thumb   | unparseable        | unreacted   | icon is language-independent (Hebrew)
 *   outline thumb   | names a reaction   | UNKNOWN     | contradiction — a click might REMOVE
 *   a reaction glyph| names the same one | reacted     | both agree; report `already`
 *   a reaction glyph| unparseable        | reacted     | the glyph IS a positive statement
 *   a reaction glyph| "no reaction"      | UNKNOWN     | the outline icon was probably renamed
 *   a reaction glyph| names a DIFFERENT  | UNKNOWN     | the two signals disagree outright
 *   both / neither  | anything           | UNKNOWN     | state is unreadable
 *
 * THE INVARIANT: a click is green-lit only on a positive unreacted signal (the outline
 * icon), never on the absence of a reacted one. `unknown` resolves to `unavailable` at the
 * driver — evidence captured, failure streak incremented, engine halts loudly — because each
 * possible tie-break has an unacceptable failure mode: trusting the icon on row 3 removes
 * the operator's reaction; trusting it on row 6 reports `already` on every unreacted post
 * forever, a false success no incident would ever record.
 */
export function readReactionVerdict(
  iconIds: readonly string[],
  ariaLabel: string | null | undefined,
): ReactionVerdict {
  const hasOutline = iconIds.includes(TRIGGER_OUTLINE_ICON);
  const glyphs = [...new Set(
    iconIds.map(reactionFromConsumptionIcon).filter((r): r is string => r !== undefined),
  )];
  const label = reactionStateFromLabel(ariaLabel);

  if (!hasOutline && glyphs.length === 0) {
    return { state: 'unknown', why: 'the trigger carries neither the outline icon nor a reaction glyph' };
  }
  if (hasOutline && glyphs.length > 0) {
    return { state: 'unknown', why: 'the trigger carries both the outline icon and a reaction glyph' };
  }
  if (glyphs.length > 1) {
    return { state: 'unknown', why: `the trigger carries ${glyphs.length} different reaction glyphs` };
  }

  if (hasOutline) {
    if (label?.kind === 'named') {
      return {
        state: 'unknown',
        why: `the outline icon says unreacted but the label names "${label.reaction}" — a click might REMOVE a reaction`,
      };
    }
    return { state: 'unreacted' };
  }

  const fromIcon = glyphs[0]!;
  if (label === undefined) return { state: 'reacted', existingReaction: fromIcon };
  if (label.kind === 'none') {
    return {
      state: 'unknown',
      why: 'a reaction glyph on a trigger whose label says "no reaction" — the outline icon was probably renamed',
    };
  }
  if (label.reaction !== fromIcon) {
    return { state: 'unknown', why: `the glyph says "${fromIcon}" but the label says "${label.reaction}"` };
  }
  return { state: 'reacted', existingReaction: fromIcon };
}

/** The comment URN out of a row's own id
 *  (`replaceableComment_urn:li:comment:(…)` -> `urn:li:comment:(…)`), or null. */
export function commentUrnFromRowId(id: string | null | undefined): string | null {
  const m = /^replaceableComment_(urn:li:comment:.+)$/.exec(id ?? '');
  return m?.[1] ?? null;
}
