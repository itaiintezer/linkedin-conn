/**
 * LIVE verification of the post-engagement pipeline, through the REAL driver.
 *
 * Everything this feature has ever done to LinkedIn went through
 * `scripts/probe-post-engage.ts`, which drives Playwright by hand. The shipped path —
 * `LinkedInDriver.reactToPost` / `.commentOnPost` over `browser/post-selectors.ts` — has
 * never run against the site. This script is the thing that proves it does, so it
 * deliberately reimplements NOTHING: it resolves the URL through `core/url.ts`, builds a
 * real `LinkedInDriver`, calls the real methods, and prints each `EngagementOutcome`
 * verbatim before interpreting it.
 *
 * Run with the Relay app STOPPED — `.linkedin-profile` is single-instance, and a second
 * Chromium cannot attach to it. The script refuses to start if the server answers on its
 * port, and says so plainly if the launch fails for that reason anyway.
 *
 *   npx tsx scripts/verify-post-engage.ts <postUrl> [--dry]
 *                                                   [--reaction <name>]
 *                                                   [--comment "<text>"]
 *
 * START WITH `--dry`. It is the only mode that touches nothing: it resolves the URL, opens
 * the post, and reads the reaction state, the observed URN and the comment affordances
 * without clicking or even hovering. Every other mode performs an irreversible, public
 * action on the real account.
 *
 * Exit code is 0 only when every step it ran interpreted as PASS.
 */
import type { Page } from 'playwright-core';
import { LinkedInDriver } from '../src/browser/linkedin-driver.js';
import { CloakSession } from '../src/browser/cloak-session.js';
import {
  PSEL, reactionEntry, existingReactionFrom, POST_LOAD_TIMEOUT_MS,
} from '../src/browser/post-selectors.js';
import { isNotFoundUrl } from '../src/browser/linkedin-selectors.js';
import { parseReaction, DEFAULT_REACTION, REACTIONS, type Reaction } from '../src/core/engagement-action.js';
import { normalizePostUrl, isShortlink, resolveShortlink } from '../src/core/url.js';
import { isProfileInUse } from '../src/worker/orchestrator.js';
import type { EngagementOutcome } from '../src/types.js';
import { PORT } from '../src/config.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const USAGE = `usage: npx tsx scripts/verify-post-engage.ts <postUrl> [--dry] [--reaction <name>] [--comment "<text>"]

  --dry              read-only. Opens the post and reports what a live run WOULD do.
                     Nothing is clicked, nothing is hovered, nothing is published.
                     START HERE — it is the only safe mode.
  --reaction <name>  one of: ${REACTIONS.join(', ')}   (default: ${DEFAULT_REACTION})
  --comment "<text>" post a comment after the reaction. IRREVERSIBLE and public.

Run with the Relay app stopped: .linkedin-profile is single-instance.`;

function die(message: string): never {
  console.error(message);
  process.exit(1);
}

// ---------------------------------------------------------------------------- arguments
// Hand-rolled rather than positional: `--comment "text"` puts a non-flag word in the middle
// of the list, so "the first bare argument is the URL" is only true if flag VALUES are
// consumed with their flag. A flag whose value is missing is an error, never a silent skip.
const argv = process.argv.slice(2);
let postArg: string | undefined;
let reactionArg: string | undefined;
let commentArg: string | undefined;
let dry = false;

for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!;
  const eq = a.indexOf('=');
  const flag = a.startsWith('--') && eq > 0 ? a.slice(0, eq) : a;
  const inline = a.startsWith('--') && eq > 0 ? a.slice(eq + 1) : undefined;
  const take = (name: string): string => {
    if (inline !== undefined) return inline;
    const v = argv[++i];
    if (v === undefined || v.startsWith('--')) die(`${name} needs a value\n\n${USAGE}`);
    return v;
  };

  if (flag === '--dry') dry = true;
  else if (flag === '--reaction') reactionArg = take('--reaction');
  else if (flag === '--comment') commentArg = take('--comment');
  else if (flag === '--help' || flag === '-h') { console.log(USAGE); process.exit(0); }
  else if (a.startsWith('--')) die(`unknown flag: ${a}\n\n${USAGE}`);
  else if (postArg === undefined) postArg = a;
  else die(`unexpected extra argument: ${a}\n\n${USAGE}`);
}

if (postArg === undefined) die(USAGE);

// Refuse a typo by NAME. parseReaction returns `undefined` for an absent value and the
// default is applied here, exactly as every other call site does it — a bad name must never
// fall through to `like`.
const parsed = parseReaction(reactionArg);
if (!parsed.ok) die(`${parsed.error}\nvalid reactions: ${REACTIONS.join(', ')}`);
const reaction: Reaction = parsed.reaction ?? DEFAULT_REACTION;

if (commentArg !== undefined && commentArg.trim() === '') {
  die('--comment was given an empty string; there is nothing to post');
}
const comment = commentArg;

// ------------------------------------------------------------------- the URL layer first
// Exercised deliberately: the sender resolves the same way, and a share link's slug id
// routinely disagrees with the post's own URN — which is the whole reason `observedUrn`
// exists and is checked below.
let raw = postArg;
if (isShortlink(raw)) {
  const expanded = await resolveShortlink(raw);
  if (expanded === null) die(`could not expand the shortlink ${raw} (lnkd.in did not redirect to linkedin.com)`);
  console.log(`shortlink  : ${raw}\n  expands to: ${expanded}`);
  raw = expanded;
}
const resolved = normalizePostUrl(raw);
if (resolved === null) die(`not a LinkedIn post reference: ${postArg}\n\n${USAGE}`);
// Re-bound so the narrowing survives into the closures below: control-flow narrowing of the
// original binding does not reach inside a function body.
const post = resolved;

console.log(`requested  : ${postArg}`);
console.log(`canonical  : ${post.url}`);
console.log(`urn (url)  : ${post.urn}   [best-effort — the page's own data-urn wins]`);

// ------------------------------------------------------ safety 1: is the server running?
/**
 * The Relay server holds `.linkedin-profile` open, and a second Chromium cannot attach to
 * it. `isProfileInUse` (worker/orchestrator.ts) is the codebase's precedent, but it
 * classifies a launch error AFTER the fact — there is no pre-flight probe to reuse. So this
 * asks the only question that can be asked before launching: is anything answering on the
 * API port?
 *
 * A refused connection is the one answer that proves nothing is there. Anything else —
 * a response of any status, a timeout, an unexpected socket error — is reported and the run
 * refuses, because the cost of a false "all clear" is a confusing browser failure and the
 * cost of a false alarm is one command to stop the server. Nothing is ever killed.
 */
async function relayServerCheck(): Promise<string | null> {
  const url = `http://127.0.0.1:${PORT}/api/status`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return `something answered ${url} with HTTP ${res.status}`;
  } catch (e) {
    const code = (e as { cause?: { code?: string } }).cause?.code;
    if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'ENOTFOUND') return null;
    return `could not tell whether the server is up — ${url} failed with `
      + `${code ?? (e as Error).name}: ${(e as Error).message}`;
  }
}

const serverUp = await relayServerCheck();
if (serverUp !== null) {
  die(`REFUSING TO RUN: ${serverUp}\n\n`
    + 'The Relay server holds the LinkedIn browser profile open and it is single-instance,\n'
    + 'so this script cannot open its own window while the app is running.\n'
    + 'Stop the app (Ctrl+C in the terminal running `npm start`, and wait for the prompt),\n'
    + 'then run this again. Do not force-kill it — that orphans the browser and blocks the\n'
    + `next start. If port ${PORT} belongs to something else entirely, stop that instead.`);
}

// ---------------------------------------------------- safety 2: say it before you do it
const plan = dry
  ? `DRY RUN — open ${post.url}, read the state for "${reaction}", click NOTHING`
  : `LIVE — react "${reaction}" on ${post.url}`
    + (comment === undefined ? ', no comment' : `, then PUBLISH the comment ${JSON.stringify(comment)}`);
console.log(`\n>>> ${plan}\n`);

if (!dry) {
  // The line above is only useful if there is time to read it. These are public actions on
  // a real account and a wrong argument cannot be taken back.
  console.log('Starting in 5s — Ctrl+C now if that line is not what you meant.');
  await sleep(5000);
}

// --------------------------------------------------------------------------- verdicts
let failures = 0;
function pass(message: string): void { console.log(`PASS ${message}`); }
function fail(message: string): void { failures++; console.log(`FAIL ${message}`); }

/** Where to look when a step goes wrong. */
function evidenceHint(out: EngagementOutcome): string {
  const shot = out.evidence?.screenshot;
  return shot ? ` — evidence: data/incidents/${shot}` : '';
}

/**
 * `observedUrn` is one of the four things this run exists to prove, so its absence on an
 * outcome that DID find the post is a failure in its own right and not a footnote: the
 * sender re-keys the row from this value, and a silent `undefined` means it re-keys from
 * nothing.
 */
function checkUrn(out: EngagementOutcome, step: string): void {
  if (out.observedUrn) {
    console.log(`     observedUrn ${out.observedUrn}`
      + (out.observedUrn === post.urn ? ' (same as the URL\'s)' : ` (DIFFERS from the URL's ${post.urn} — expected on share links)`));
  } else {
    fail(`${step} reported no observedUrn — the container's data-urn did not read, and the sender reconciles the row from it`);
  }
}

let aborted = false;
function checkpointAbort(out: EngagementOutcome, step: string): void {
  aborted = true;
  fail(`${step} hit a CHECKPOINT — ${out.error ?? 'no detail'}${evidenceHint(out)}`);
  console.log('\n'
    + '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n'
    + '!! LINKEDIN SHOWED A CHECKPOINT / SECURITY CHALLENGE.\n'
    + '!! Stopping here. Nothing further will be attempted, and the comment step is\n'
    + '!! SKIPPED. Solve the challenge in the browser window before running anything\n'
    + '!! else against this account, and treat the run as inconclusive.\n'
    + '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n');
}

function interpretReaction(out: EngagementOutcome): void {
  switch (out.result) {
    case 'done':
      pass(`reaction placed (${reaction})`);
      checkUrn(out, 'reaction');
      break;
    case 'already':
      // The destructive-click guard doing its job. A PASS: the trigger is a toggle, so
      // "already" is the correct, tested answer and NOT clicking is the point.
      pass(`already — the post carries ${out.existingReaction ?? 'a reaction we could not name'}`
        + ' and the driver did not click (a click would have REMOVED it)');
      if (!out.existingReaction) {
        console.log('     note: the aria-label did not parse as "Unreact <X>" — expected if the page rendered'
          + ' in another language; the already/done verdict itself comes from aria-pressed, not the label');
      }
      checkUrn(out, 'reaction');
      break;
    case 'checkpoint':
      checkpointAbort(out, 'reaction');
      break;
    case 'not_found':
      fail('expected done, got not_found — LinkedIn redirected to /404/; the post is deleted or the URL is wrong');
      break;
    case 'unavailable':
      fail(`expected done, got unavailable — ${out.error ?? 'no detail'}${evidenceHint(out)}\n`
        + '     the react control or the flyout entry did not resolve: the selector may have rotted.'
        + ' Re-run scripts/probe-post-engage.ts against this post and compare.');
      break;
    case 'error':
      fail(`expected done, got error — ${out.error ?? 'no detail'}${evidenceHint(out)}`);
      break;
    default:
      // `unverified` and `comments_disabled` belong to the comment path; reactToPost
      // returning either is a contract break worth shouting about.
      fail(`reactToPost returned "${out.result}", which it is documented never to return`);
  }
}

function interpretComment(out: EngagementOutcome): void {
  switch (out.result) {
    case 'done':
      pass('comment posted AND confirmed in the thread through readCommentConfirmation');
      checkUrn(out, 'comment');
      break;
    case 'unverified':
      fail(`comment could not be confirmed — ${out.error ?? 'no detail'}${evidenceHint(out)}\n`
        + '     THE COMMENT MAY BE LIVE. Open the post and look before running this again;'
        + ' a retry would publish it twice.');
      break;
    case 'comments_disabled':
      fail(`got comments_disabled${evidenceHint(out)} — that may be true of this post, but it does not`
        + ' verify the comment path. Re-run against a post that accepts comments.');
      break;
    case 'checkpoint':
      checkpointAbort(out, 'comment');
      break;
    case 'not_found':
      fail('expected done, got not_found — the post vanished between the two steps');
      break;
    case 'unavailable':
      fail(`expected done, got unavailable — ${out.error ?? 'no detail'}${evidenceHint(out)}\n`
        + '     the composer never appeared: the selector may have rotted.');
      break;
    default:
      fail(`expected done, got ${out.result} — ${out.error ?? 'no detail'}${evidenceHint(out)}`);
  }
}

// ----------------------------------------------------------------------------- dry read
/**
 * The read-only half of what `reactToPost` does before it decides anything: resolve the
 * container the way `resolvePostContainer` does (detail shell if it is unambiguous, else
 * page-wide) and read state off the SAME `PSEL` selectors the driver uses.
 *
 * It stops short of hovering. The flyout only mounts on hover, so this cannot say anything
 * about the five non-`like` reactions — that is exactly what the live run is for, and
 * pretending otherwise here would be the one place this script guessed.
 */
async function dryInspect(page: Page): Promise<void> {
  await page.goto(post.url, { waitUntil: 'domcontentloaded' });
  await sleep(4000);
  console.log(`landed on  : ${page.url()}`);

  if (isNotFoundUrl(page.url())) {
    fail('LinkedIn redirected to /404/ — a live run would report not_found');
    return;
  }
  const scan = await driver.checkpointScan();
  if (scan.hit) {
    checkpointAbort({ result: 'checkpoint', error: `checkpoint at ${scan.url} (matched ${scan.matched})` }, 'dry run');
    return;
  }

  const wide = page.locator(PSEL.postContainer);
  await wide.first().waitFor({ state: 'attached', timeout: POST_LOAD_TIMEOUT_MS }).catch(() => {});

  const shells = await page.locator(PSEL.detailShell).count();
  const containers = await wide.count();
  let container = wide.first();
  let scopedBy = 'page-wide .first() — DOM order decides the post';
  if (shells === 1) {
    const scoped = page.locator(PSEL.detailShell).locator(PSEL.postContainer).first();
    if (await scoped.count()) { container = scoped; scopedBy = 'the detail shell (structural)'; }
  }

  if (!containers) {
    fail('no post container on the page — a live run would report unavailable. Either the page did not'
      + ' load or PSEL.postContainer has rotted.');
    return;
  }

  const observedUrn = await container.getAttribute('data-urn').catch(() => null);
  const reacted = container.locator(PSEL.reactTriggerReacted).first();
  const reactedCount = await reacted.count();
  const label = reactedCount ? await reacted.getAttribute('aria-label').catch(() => null) : null;

  console.log('\n--- what the driver would see ---');
  console.log({
    detailShells: shells,
    postContainers: containers,
    scopedBy,
    observedUrn,
    urnMatchesUrl: observedUrn === post.urn,
    actionBar: await container.locator(PSEL.actionBar).count(),
    identityTogglePresent: (await container.locator(PSEL.identityToggleNeverClick).count()) > 0,
    reactTrigger: await container.locator(PSEL.reactTrigger).count(),
    reactedTrigger: reactedCount,
    reactedLabel: label,
    existingReaction: existingReactionFrom(label) ?? null,
    unreactedTrigger: await container.locator(PSEL.reactTriggerUnreacted).count(),
    commentEditorInline: await container.locator(PSEL.commentEditor).count(),
    commentButton: await container.locator(PSEL.commentButton).count(),
    commentsDisabledWording: await page.locator(PSEL.commentsDisabledText).first().count(),
    // Zero is the expected, correct answer: the flyout mounts on hover and this run never
    // hovers. A non-zero count would mean the entry is in the DOM all along.
    flyoutEntryBeforeHover: await page.locator(reactionEntry(reaction)).count(),
  });

  console.log('\n--- what a live run WOULD do ---');
  if (reactedCount) {
    console.log(`  reaction: report "already" (${existingReactionFrom(label) ?? 'unrecognised label'}) and click nothing.`);
  } else if (await container.locator(PSEL.reactTriggerUnreacted).count()) {
    console.log(reaction === 'like'
      ? '  reaction: click the trigger directly.'
      : `  reaction: hover the trigger and click the "${reaction}" flyout entry`
        + ' (the flyout cannot be checked without hovering — the live run is the proof).');
  } else {
    console.log('  reaction: report "unavailable" — no react trigger resolved.');
  }
  console.log(comment === undefined
    ? '  comment : none requested.'
    : `  comment : type ${JSON.stringify(comment)} into the composer and publish it.`);

  if (!observedUrn) {
    fail('the post container carries no data-urn — observedUrn would come back undefined and the'
      + ' sender would have nothing to re-key the row from');
  }
  if (!(await container.locator(PSEL.reactTrigger).count())) {
    fail('no react trigger inside the action bar — PSEL.reactTrigger does not resolve on this post');
  } else {
    pass('the post, its action bar and its react trigger all resolve through the shipped selectors');
  }
}

// -------------------------------------------------------------------------------- run
// The session is constructed explicitly so the dry read can borrow the same page the driver
// uses. Live steps still go through the driver's own public methods — nothing here
// re-implements them.
const session = new CloakSession();
const driver = new LinkedInDriver(session);

try {
  let page: Page;
  try {
    page = await session.page();
  } catch (e) {
    if (isProfileInUse(e)) {
      throw new Error('the LinkedIn browser profile is already in use — stop the Relay app (or close the'
        + ' leftover Chromium window) and run this again. Nothing was done.');
    }
    throw e;
  }

  const login = await driver.readLoginState();
  if (!login.loggedIn) throw new Error('not logged in — start the app, sign in, stop the app, then re-run');
  console.log(`session    : logged in (li_at expires ${login.cookieExpiry ?? 'unknown'})`);

  if (dry) {
    await dryInspect(page);
  } else {
    console.log('\n=== reactToPost ===');
    const out = await driver.reactToPost(post.url, reaction);
    console.log(JSON.stringify(out, null, 2));
    interpretReaction(out);

    // A checkpoint NEVER continues to the comment: the account is being challenged and the
    // next action would be taken against a page we cannot read.
    if (!aborted && comment !== undefined) {
      console.log('\n=== commentOnPost ===');
      const cOut = await driver.commentOnPost(post.url, comment);
      console.log(JSON.stringify(cOut, null, 2));
      interpretComment(cOut);
    } else if (aborted && comment !== undefined) {
      console.log('\n=== commentOnPost — SKIPPED (checkpoint) ===');
    }
  }

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
  if (failures > 0) process.exitCode = 1;
} catch (e) {
  console.error('[verify-post-engage] ERROR:', (e as Error).message);
  process.exitCode = 1;
} finally {
  await driver.close();
  console.log('[verify-post-engage] browser closed.');
}
