# LinkedIn Connect-Flow Robustness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the connection-request browser automation resilient to LinkedIn UI-language and markup changes via four changes: force English locale, role-based selectors, a secondary click-path fallback for opening the invite composer, and a preflight selector health-check.

**Architecture:** All DOM selectors stay centralized in `linkedin-selectors.ts`. Button/pending selectors move from English `aria-label` CSS strings to Playwright `getByRole` locator-builder functions (resilient to LinkedIn moving the accessible name between `aria-label` and inner text). The composer is opened by the existing direct `custom-invite` route first, then — if that yields no composer — by clicking the Connect control on the profile UI. English is forced at browser-launch via CloakBrowser's stealth-safe top-level `locale` field (`--lang` binary flag), keeping all selectors valid regardless of the account's LinkedIn language. A new preflight script exercises the real selectors against a live profile without sending.

**Tech Stack:** TypeScript (ESM), Playwright (`playwright-core` 1.61.1) via CloakBrowser 0.4.5, vitest, tsx.

**Verification note:** The repo unit-tests at the `BrowserDriver` interface using `FakeDriver`; the real `LinkedInDriver` + selector layer talk to live pages and are verified by `scripts/*` against real LinkedIn, not unit tests. So this plan verifies via (a) `npm run typecheck` — the selector-shape change from strings to functions surfaces every missed call site at compile time; (b) `npm test` — the existing suite must stay green (it uses `FakeDriver`, so it should be untouched); (c) a live run of the new preflight script. No fabricated unit tests are added for the browser layer, consistent with the existing codebase.

---

## File Structure

- `src/browser/linkedin-selectors.ts` — **Modify.** Keep `SEL` for non-role selectors (textarea, list links, quota text, feed marker) and add `connectAnchor`. Add a `find` object of `getByRole`/locator builder functions for composer + pending + fallback controls.
- `src/browser/linkedin-driver.ts` — **Modify.** Use `find.*` builders; add `composerVisible()` and `openComposerViaProfile()` helpers; insert the fallback between route-nav and the `unavailable` return; switch final confirmation from `waitForSelector(string)` to `locator.waitFor()`.
- `src/browser/cloak-session.ts` — **Modify.** Add `locale: 'en-US'` to `launchPersistentContext`.
- `scripts/check-state.ts`, `scripts/inspect-connect.ts`, `scripts/inspect-lists.ts` — **Modify.** Add `locale: 'en-US'` so diagnostics match production.
- `scripts/preflight-selectors.ts` — **Create.** Structured selector health-check importing the real `find`/`SEL`; never sends.

---

## Task 1: Force English locale at launch

**Files:**
- Modify: `src/browser/cloak-session.ts:25-31`
- Modify: `scripts/check-state.ts:7`
- Modify: `scripts/inspect-connect.ts:8`
- Modify: `scripts/inspect-lists.ts:12`

Rationale: CloakBrowser's top-level `locale` sets the `--lang` Chromium binary flag (drives `navigator.language`, `Accept-Language`, and UI language together). Per `node_modules/cloakbrowser/dist/types.d.ts`, locale must be set top-level — NOT via `contextOptions`, where it is stripped to avoid detectable CDP emulation.

- [ ] **Step 1: Add locale to the production session**

In `src/browser/cloak-session.ts`, change the launch block to:

```ts
    this.ctx = await launchPersistentContext({
      userDataDir: BROWSER_PROFILE_DIR,
      headless: false,
      humanize: true,
      locale: 'en-US',
      viewport: { width: 1280, height: 900 },
    });
```

- [ ] **Step 2: Add locale to the three diagnostic scripts**

In each of `scripts/check-state.ts`, `scripts/inspect-connect.ts`, `scripts/inspect-lists.ts`, add `locale: 'en-US',` to the `launchPersistentContext({ ... })` options object (alongside the existing `userDataDir`/`headless`/`humanize`/`viewport` fields).

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS (no errors).

- [ ] **Step 4: Commit**

```bash
git add src/browser/cloak-session.ts scripts/check-state.ts scripts/inspect-connect.ts scripts/inspect-lists.ts
git commit -m "feat(browser): force en-US locale at launch for selector stability"
```

---

## Task 2: Role-based selectors (`find`) + `connectAnchor`

**Files:**
- Modify: `src/browser/linkedin-selectors.ts`

Convert composer/pending controls to `getByRole` builders and add the fallback-path locators. Keep `noteTextarea` (item 6 was out of scope — selector unchanged) and the list/quota/feed selectors as CSS in `SEL`.

- [ ] **Step 1: Rewrite the selector module**

Replace the `SEL` block (lines 9-29) with:

```ts
import type { Page, Locator } from 'playwright-core';

type Scope = Page | Locator;

// Non-role selectors (used via page.locator(...)). Stable enough; left as CSS.
export const SEL = {
  feedMarker: 'main',

  // Note composer textarea (unchanged — kept specific on purpose).
  noteTextarea: 'textarea[name="message"]',

  // Weekly invite-limit / quota wording (best-effort; wording varies).
  noteQuotaDialog: 'text=/weekly invitation limit|reached the weekly|out of invitations|limit of invitations/i',

  // Acceptance reader (list pages). NOTE: unverified against the new UI.
  invitationCardLink: 'a[href*="/in/"]',
  connectionCardLink: 'a[href*="/in/"]',

  // Fallback path: the obfuscated Connect control on a profile is an anchor to
  // the custom-invite route. Clicking it opens the composer in-page.
  connectAnchor: 'a[href*="custom-invite"]',
};

// Role-based locator builders. getByRole matches the *accessible name*, so these
// survive LinkedIn moving the label between aria-label and inner text. Forcing
// en-US at launch (see cloak-session.ts) keeps these English names valid.
export const find = {
  // Invite composer dialog (shown at the custom-invite route or after a UI click)
  sendWithoutNote: (s: Scope): Locator => s.getByRole('button', { name: 'Send without a note' }),
  addNote: (s: Scope): Locator => s.getByRole('button', { name: 'Add a note' }),
  sendInvitation: (s: Scope): Locator => s.getByRole('button', { name: 'Send invitation' }),
  dismissDialog: (s: Scope): Locator => s.getByRole('button', { name: 'Dismiss' }),

  // Pending state on the profile page (post-send confirmation / pre-send guard)
  pendingBadge: (s: Scope): Locator => s.getByRole('button', { name: /pending/i }),

  // Fallback path: Connect hidden behind the "More" overflow menu
  moreActions: (s: Scope): Locator => s.getByRole('button', { name: /more actions/i }),
  connectMenuItem: (s: Scope): Locator => s.getByRole('menuitem', { name: /^connect$/i }),
};
```

Leave the `URLS`, `customInviteUrl`, and `profileSlug` exports (lines 31-46) unchanged.

- [ ] **Step 2: Typecheck (expected to FAIL here)**

Run: `npm run typecheck`
Expected: FAIL — `linkedin-driver.ts` still references `SEL.sendWithoutNote`, `SEL.addNoteButton`, `SEL.sendInvitation`, `SEL.pendingBadge`, which no longer exist on `SEL`. This confirms the call sites that Task 3 must update. (Do not commit yet — Task 3 fixes these.)

---

## Task 3: Driver uses `find` + composer fallback

**Files:**
- Modify: `src/browser/linkedin-driver.ts`

- [ ] **Step 1: Update the import**

Change line 4 to:

```ts
import { SEL, find, URLS, customInviteUrl, profileSlug } from './linkedin-selectors.js';
```

- [ ] **Step 2: Use `find.pendingBadge` for the pre-send guard**

Replace line 53:

```ts
      if (await find.pendingBadge(page).first().isVisible().catch(() => false)) {
```

- [ ] **Step 3: Open composer via route, then profile-UI fallback**

Replace the composer-open block (current lines 57-68) with:

```ts
      // 2) Open the invite composer: direct custom-invite route first, then
      //    fall back to clicking the Connect control on the profile UI.
      await page.goto(customInviteUrl(slug), { waitUntil: 'domcontentloaded' });
      await sleep(rand(2000, 4000));
      if (!(await this.composerVisible(page))) {
        await this.openComposerViaProfile(page, url);
        await sleep(rand(1500, 3000));
      }
      const sendWithout = find.sendWithoutNote(page).first();
      const addNote = find.addNote(page).first();
      const hasSendWithout = await sendWithout.isVisible().catch(() => false);
      const hasAddNote = await addNote.isVisible().catch(() => false);

      if (!hasSendWithout && !hasAddNote) {
        if (await this.looksLikeCheckpoint(page)) return { result: 'checkpoint', error: 'checkpoint detected', firstName };
        return { result: 'unavailable', firstName };
      }
```

- [ ] **Step 4: Use `find.sendInvitation` for the note-send click**

Replace line 82 (`await page.locator(SEL.sendInvitation).first().click();`) with:

```ts
        await find.sendInvitation(page).first().click();
```

(The `addNote.click()`, `page.locator(SEL.noteTextarea).fill(note)`, and `sendWithout.click()` lines stay as-is — `addNote`/`sendWithout` are now `find` locators, and `SEL.noteTextarea` still exists.)

- [ ] **Step 5: Switch final confirmation to a Locator wait**

Replace the confirmation block (current lines 91-98) with:

```ts
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      try {
        await find.pendingBadge(page).first().waitFor({ state: 'visible', timeout: 9000 });
        return { result: 'sent', firstName };
      } catch {
        if (await this.looksLikeCheckpoint(page)) return { result: 'checkpoint', error: 'checkpoint detected', firstName };
        return { result: 'error', error: 'send not confirmed: no Pending state after submit', firstName };
      }
```

- [ ] **Step 6: Add the two private helpers**

Insert after the `looksLikeCheckpoint` method (after current line 108):

```ts
  /** True if the invite composer (note or no-note path) is currently open. */
  private async composerVisible(page: Page): Promise<boolean> {
    if (await find.sendWithoutNote(page).first().isVisible().catch(() => false)) return true;
    return find.addNote(page).first().isVisible().catch(() => false);
  }

  /**
   * Fallback when the direct custom-invite route yields no composer: open the
   * profile and click the Connect control. Tries the obfuscated custom-invite
   * anchor first, then the "More" overflow menu's Connect item.
   */
  private async openComposerViaProfile(page: Page, url: string): Promise<void> {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await sleep(rand(1500, 3000));

    const anchor = page.locator(SEL.connectAnchor).first();
    if (await anchor.isVisible().catch(() => false)) {
      await anchor.click().catch(() => {});
      await sleep(rand(1500, 3000));
      if (await this.composerVisible(page)) return;
    }

    const more = find.moreActions(page).first();
    if (await more.isVisible().catch(() => false)) {
      await more.click().catch(() => {});
      await sleep(rand(800, 1600));
      const item = find.connectMenuItem(page).first();
      if (await item.isVisible().catch(() => false)) {
        await item.click().catch(() => {});
        await sleep(rand(1500, 3000));
      }
    }
  }
```

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: PASS — all former `SEL.*` button/pending references are now `find.*`.

- [ ] **Step 8: Run the existing test suite**

Run: `npm test`
Expected: PASS — all tests green (they use `FakeDriver`; the driver page-logic change is not exercised by unit tests).

- [ ] **Step 9: Commit**

```bash
git add src/browser/linkedin-selectors.ts src/browser/linkedin-driver.ts
git commit -m "feat(browser): role-based selectors + profile-UI fallback for invite composer"
```

---

## Task 4: Preflight selector health-check script

**Files:**
- Create: `scripts/preflight-selectors.ts`

A smoke check that imports the REAL `find`/`SEL`/`customInviteUrl` and confirms each composer selector resolves on a live profile, without ever sending. Exits non-zero if a critical composer selector is missing, so it can gate a deploy / be run after any suspected LinkedIn change.

- [ ] **Step 1: Create the script**

```ts
// Preflight: verify the live invite-composer selectors resolve, WITHOUT sending.
// Requires a logged-in persistent profile. Run: npx tsx scripts/preflight-selectors.ts [slug]
import { launchPersistentContext } from 'cloakbrowser';
import { BROWSER_PROFILE_DIR } from '../src/config.js';
import { find, customInviteUrl } from '../src/browser/linkedin-selectors.js';

const slug = process.argv[2] ?? 'liron-lalezary';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const ctx = await launchPersistentContext({
  userDataDir: BROWSER_PROFILE_DIR, headless: false, humanize: true,
  locale: 'en-US', viewport: { width: 1280, height: 900 },
});
const page = ctx.pages()[0] ?? (await ctx.newPage());
const results: Array<{ selector: string; found: boolean; critical: boolean }> = [];
const check = async (name: string, locator: { first(): { isVisible(): Promise<boolean> } }, critical = true) => {
  const found = await locator.first().isVisible().catch(() => false);
  results.push({ selector: name, found, critical });
};

try {
  await page.goto(customInviteUrl(slug), { waitUntil: 'domcontentloaded' });
  await sleep(6000);

  await check('sendWithoutNote', find.sendWithoutNote(page));
  await check('addNote', find.addNote(page));

  // Open the note path to reveal the textarea + Send invitation button.
  if (await find.addNote(page).first().isVisible().catch(() => false)) {
    await find.addNote(page).first().click().catch(() => {});
    await sleep(2000);
  }
  await check('sendInvitation', find.sendInvitation(page));
  await check('dismissDialog', find.dismissDialog(page), false);

  // Non-critical: pending may not be present unless an invite is already out.
  await check('pendingBadge (informational)', find.pendingBadge(page), false);

  console.log('\nSELECTOR HEALTH:');
  for (const r of results) {
    const mark = r.found ? 'OK  ' : (r.critical ? 'FAIL' : 'miss');
    console.log(`  [${mark}] ${r.selector}`);
  }
  const brokenCritical = results.filter((r) => r.critical && !r.found);
  if (brokenCritical.length) {
    console.error(`\n${brokenCritical.length} critical selector(s) broken — composer flow will fail.`);
    process.exitCode = 1;
  } else {
    console.log('\nAll critical selectors resolved.');
  }
} catch (e) {
  console.error('[preflight] ERROR:', (e as Error).message);
  process.exitCode = 1;
} finally {
  await ctx.close();
  console.log('[preflight] closed (no invitation sent).');
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Live smoke run (manual, requires logged-in session)**

Run: `npx tsx scripts/preflight-selectors.ts <a-non-connection-slug>`
Expected: `[OK ]` for `sendWithoutNote`, `addNote`, `sendInvitation`; final line `All critical selectors resolved.`; no invitation sent. This simultaneously validates Task 1 (English UI), Task 2 (role selectors), and confirms the composer renders.

- [ ] **Step 4: Commit**

```bash
git add scripts/preflight-selectors.ts
git commit -m "feat(scripts): preflight selector health-check for the invite composer"
```

---

## Self-Review

- **Spec coverage:** Item 1 (force English) → Task 1. Item 3 (getByRole) → Task 2 + Task 3 call-site updates. Item 4 (secondary fallback) → Task 3 (`openComposerViaProfile`). Item 7 (preflight) → Task 4. Items 2, 5, 6, 8 were explicitly out of scope and intentionally untouched (`noteTextarea` left as-is, modal scoping unchanged, no fallback chains, no failure screenshots).
- **Type consistency:** `find` builders take `Scope = Page | Locator` and return `Locator`; driver helpers `composerVisible(page)`/`openComposerViaProfile(page, url)` are referenced exactly as defined. `SEL.connectAnchor` defined in Task 2, used in Task 3 Step 6. `SEL.noteTextarea` retained for the unchanged `.fill` line.
- **Placeholder scan:** No TBD/TODO/"handle edge cases"; every code step shows full code.
- **Known live-only risk:** `find.pendingBadge` (`getByRole('button', {name:/pending/i})`) and `find.moreActions`/`connectMenuItem` accessible names are unverified against the live DOM — the preflight (pending) and a real fallback trigger will confirm; if a name differs, only that one builder line changes.
