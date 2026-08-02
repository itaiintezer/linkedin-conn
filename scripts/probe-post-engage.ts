/**
 * DOM probe for the post-engagement pipeline (reactions + comments).
 *
 * Phase A (default) is READ-ONLY apart from hovering the Like button: it navigates to a
 * post, resolves any shortlink, and dumps the social action bar, the Like button, the
 * reaction flyout (after hover), the comment affordances, and every `data-*` on the post
 * container — so no selector in `src/browser/post-selectors.ts` is ever written from memory.
 *
 * Phase B is opt-in per action and drives the REAL account:
 *   --like              place a Like reaction (idempotent; skipped if already reacted)
 *   --comment "<text>"  post a comment
 * Both capture before/after DOM so we learn which attribute flips.
 *
 * Full HTML dumps go to data/incidents/<stamp>-post-engage/ (gitignored); stdout gets a
 * sectioned, truncated view.
 *
 * Run with the Relay app STOPPED — `.linkedin-profile` is single-instance.
 *   npx tsx scripts/probe-post-engage.ts <postUrl> [--like] [--comment "text"]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchPersistentContext } from 'cloakbrowser';
import type { Page } from 'playwright-core';
import { BROWSER_PROFILE_DIR, INCIDENTS_DIR } from '../src/config.js';

const argv = process.argv.slice(2);
const url = argv.find((a) => !a.startsWith('--'));
const doLike = argv.includes('--like');
const commentIdx = argv.indexOf('--comment');
const commentText = commentIdx >= 0 ? argv[commentIdx + 1] : undefined;
// Read-only composer probe: types into the comment box to make the submit control
// render, dumps it, then clears the box. Never submits. Publishes nothing.
const armIdx = argv.indexOf('--arm-comment');
const armText = armIdx >= 0 ? argv[armIdx + 1] : undefined;

if (!url) {
  console.error('usage: probe-post-engage.ts <postUrl> [--like] [--comment "text"]');
  process.exit(1);
}
if (commentIdx >= 0 && (!commentText || commentText.startsWith('--'))) {
  console.error('--comment requires a text argument');
  process.exit(1);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = join(INCIDENTS_DIR, `${stamp}-post-engage`);
mkdirSync(outDir, { recursive: true });

function dump(name: string, body: string): string {
  const p = join(outDir, name);
  writeFileSync(p, body, 'utf8');
  return p;
}
function section(title: string): void {
  console.log(`\n${'='.repeat(78)}\n== ${title}\n${'='.repeat(78)}`);
}
function clip(s: string | null | undefined, n = 1800): string {
  if (!s) return String(s);
  return s.length > n ? `${s.slice(0, n)}\n…[${s.length} chars total, full copy in ${outDir}]` : s;
}

/** Everything the page evaluate needs, injected once so probe + engage share one view. */
const PAGE_HELPERS = `
  (globalThis).__name = (t) => t;
  const attrs = (el) => Object.fromEntries(Array.from(el.attributes).map((a) => [a.name, a.value]));
  const brief = (el) => el ? el.tagName.toLowerCase()
      + (el.id ? '#' + el.id : '')
      + (el.getAttribute('role') ? '[role=' + el.getAttribute('role') + ']' : '')
      + (el.getAttribute('aria-label') ? '[aria-label="' + el.getAttribute('aria-label') + '"]' : '')
    : null;
  const path = (el) => { const out = []; let n = el;
    while (n && n.nodeType === 1 && out.length < 12) { out.push(brief(n)); n = n.parentElement; }
    return out.join(' < '); };
  const visible = (el) => { const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
`;

const ctx = await launchPersistentContext({
  userDataDir: BROWSER_PROFILE_DIR,
  headless: false,
  humanize: true,
  locale: 'en-US',
  viewport: { width: 1280, height: 1000 },
});
await ctx.addCookies([
  { name: 'lang', value: 'v=2&lang=en-US', domain: '.linkedin.com', path: '/' },
  { name: 'lang', value: 'v=2&lang=en-US', domain: '.www.linkedin.com', path: '/' },
]);
const page: Page = ctx.pages()[0] ?? (await ctx.newPage());

/**
 * Read the post-level react trigger's full state — the before/after snapshot for
 * REACTED_STATE. Discovered 2026-08-02: the trigger is the ONLY `button[aria-pressed]`
 * whose aria-label is a bare "React <X>" / "Unreact <X>"; every comment's own like
 * button reads "React Like to <Name>'s comment", and the flyout entries carry the same
 * bare labels but no `aria-pressed`.
 */
const TRIGGER_SEL = 'button[aria-pressed][aria-label^="React "], button[aria-pressed][aria-label^="Unreact "]';

async function likeState(p: Page): Promise<any> {
  return p.evaluate(`(() => {
    ${PAGE_HELPERS}
    const all = Array.from(document.querySelectorAll('button[aria-pressed]'))
      .map((b) => ({ label: b.getAttribute('aria-label'), pressed: b.getAttribute('aria-pressed'), path: path(b) }));
    const post = document.querySelector('div[data-urn][role="article"]');
    const trigger = post ? post.querySelector('${TRIGGER_SEL.replace(/'/g, "\\'")}') : null;
    const counts = post ? post.querySelector('[class*="social-details-social-counts"]') : null;
    return {
      postUrn: post ? post.getAttribute('data-urn') : null,
      allAriaPressedButtons: all,
      found: !!trigger,
      attrs: trigger ? attrs(trigger) : null,
      text: trigger ? (trigger.innerText || '').trim() : null,
      iconType: trigger ? (trigger.querySelector('[data-test-icon]') || {}).getAttribute
        ? trigger.querySelector('[data-test-icon]').getAttribute('data-test-icon') : null : null,
      html: trigger ? trigger.outerHTML : null,
      path: trigger ? path(trigger) : null,
      socialCounts: counts ? (counts.innerText || '').replace(/\\n/g, ' | ') : null,
    };
  })()`);
}

try {
  // ---------------------------------------------------------------- navigation
  const redirects: string[] = [];
  page.on('response', (r) => {
    const s = r.status();
    if (s >= 300 && s < 400) redirects.push(`${s} ${r.url()} -> ${r.headers()['location'] ?? '?'}`);
  });
  const resp = await page.goto(url, { waitUntil: 'domcontentloaded' });
  await new Promise((r) => setTimeout(r, 9000));

  const finalUrl = page.url();
  const title = await page.title();
  section('1. URL RESOLUTION');
  console.log('requested :', url);
  console.log('final     :', finalUrl);
  console.log('title     :', title);
  console.log('status    :', resp?.status());
  console.log('3xx hops  :', redirects.length ? redirects : '(none observed — JS/interstitial hop or no redirect)');
  console.log('req chain :', JSON.stringify(
    (() => { const chain: string[] = []; let r = resp?.request();
      while (r) { chain.unshift(`${r.method()} ${r.url()}`); r = r.redirectedFrom() ?? undefined; }
      return chain; })(), null, 2));
  const urnInUrl = finalUrl.match(/urn:li:[a-zA-Z]+:\d+/)?.[0]
    ?? finalUrl.match(/-activity-(\d+)/)?.[1];
  console.log('urn (url) :', urnInUrl ?? '(none in URL)');

  if (/checkpoint|challenge|captcha/i.test(finalUrl) || /security verification/i.test(title)) {
    console.error('\n!! CHECKPOINT DETECTED — stopping.');
    throw new Error('checkpoint');
  }

  // ------------------------------------------------------- read-only structure
  const structure = await page.evaluate(`(() => {
    ${PAGE_HELPERS}

    // --- post container: anything carrying a urn:li: value in an attribute
    const urnCarriers = [];
    for (const el of Array.from(document.querySelectorAll('*'))) {
      for (const a of Array.from(el.attributes)) {
        if (/urn:li:/.test(a.value) && a.name !== 'href' && a.name !== 'src') {
          urnCarriers.push({ attr: a.name, value: a.value.slice(0, 160), on: brief(el), tag: el.tagName.toLowerCase() });
        }
      }
    }

    // --- the social action bar: the container holding Like + Comment together
    let bar = null;
    const allBtns = Array.from(document.querySelectorAll('button, [role="button"]'));
    const likeish = allBtns.filter((b) => /\\blike\\b/i.test((b.getAttribute('aria-label') || '') + ' ' + (b.innerText || '')));
    for (const l of likeish) {
      let n = l.parentElement, hops = 0;
      while (n && hops++ < 6) {
        const t = n.innerText || '';
        if (/comment/i.test(t) && /like|react/i.test(t) && n.querySelectorAll('button').length >= 2) { bar = n; break; }
        n = n.parentElement;
      }
      if (bar) break;
    }

    // --- all action-bar buttons with every attribute
    const barButtons = bar ? Array.from(bar.querySelectorAll('button, [role="button"]')).map((b) => ({
      text: (b.innerText || '').trim(), attrs: attrs(b), visible: visible(b), path: path(b),
    })) : [];

    // --- comment affordances
    const editables = Array.from(document.querySelectorAll('[contenteditable="true"], textarea')).map((e) => ({
      attrs: attrs(e), path: path(e), visible: visible(e), html: e.outerHTML.slice(0, 900),
    }));
    const commentCtl = allBtns.filter((b) => /comment/i.test((b.getAttribute('aria-label') || '') + ' ' + (b.innerText || '')))
      .map((b) => ({ text: (b.innerText || '').trim(), attrs: attrs(b), visible: visible(b), path: path(b) }));

    // --- structural signals for a comments-disabled post
    const commentsOff = Array.from(document.querySelectorAll('*'))
      .filter((e) => e.children.length === 0 && /comments (are )?(off|disabled|restricted)|turned off comments|no longer accepting/i.test(e.textContent || ''))
      .map((e) => ({ text: (e.textContent || '').trim().slice(0, 200), path: path(e) }));

    return {
      htmlLang: document.documentElement.getAttribute('lang'),
      dir: document.documentElement.getAttribute('dir'),
      urnCarriers,
      urnAttrNames: Array.from(new Set(urnCarriers.map((u) => u.attr))),
      barPath: bar ? path(bar) : null,
      barHtml: bar ? bar.outerHTML : null,
      barText: bar ? (bar.innerText || '').replace(/\\n/g, ' | ') : null,
      barButtons,
      editables,
      commentCtl,
      commentsOff,
      canonicalLink: (document.querySelector('link[rel="canonical"]') || {}).href || null,
      ogUrl: (document.querySelector('meta[property="og:url"]') || {}).content || null,
    };
  })()`) as any;

  section('2. LANGUAGE / PAGE SHELL');
  console.log('html lang :', structure.htmlLang, ' dir:', structure.dir, ' (lang-cookie pin holding =', structure.htmlLang === 'en-US' || structure.htmlLang === 'en', ')');
  console.log('canonical :', structure.canonicalLink);
  console.log('og:url    :', structure.ogUrl);

  section('3. SOCIAL ACTION BAR');
  console.log('bar path  :', structure.barPath);
  console.log('bar text  :', structure.barText);
  dump('action-bar.html', structure.barHtml ?? '(not found)');
  console.log(clip(structure.barHtml));

  section('4. ACTION-BAR BUTTONS (every attribute)');
  console.log(JSON.stringify(structure.barButtons, null, 2));

  section('5. LIKE BUTTON — pre-hover state');
  const beforeHover = await likeState(page);
  console.log(JSON.stringify(beforeHover, null, 2));

  // ---------------------------------------------------------------- the flyout
  section('6. REACTION FLYOUT (after hover)');
  const likeLoc = page.locator('button').filter({ hasText: /^Like$/ }).first();
  let flyout: any = { opened: false };
  try {
    const target = (await likeLoc.count()) > 0
      ? likeLoc
      : page.locator('button[aria-label*="ike" i]').first();
    await target.scrollIntoViewIfNeeded();
    await target.hover();
    await new Promise((r) => setTimeout(r, 2500));
    flyout = await page.evaluate(`(() => {
      ${PAGE_HELPERS}
      const NAMES = ['like','celebrate','support','love','insightful','funny'];
      const cands = Array.from(document.querySelectorAll('button, [role="button"]'))
        .filter((b) => visible(b))
        .filter((b) => NAMES.some((n) => new RegExp('\\\\b' + n + '\\\\b', 'i')
          .test((b.getAttribute('aria-label') || '') + ' ' + (b.innerText || '') + ' ' + (b.getAttribute('data-test-reactions-menu-item') || ''))));
      // The flyout is the smallest container holding >= 4 distinct reaction names.
      let container = null;
      for (const c of cands) {
        let n = c.parentElement, hops = 0;
        while (n && hops++ < 8) {
          const inner = (n.innerText || '') + ' ' + Array.from(n.querySelectorAll('[aria-label]')).map((x) => x.getAttribute('aria-label')).join(' ');
          const hits = NAMES.filter((x) => new RegExp('\\\\b' + x + '\\\\b', 'i').test(inner)).length;
          if (hits >= 4) { container = n; break; }
          n = n.parentElement;
        }
        if (container) break;
      }
      return {
        opened: !!container,
        containerPath: container ? path(container) : null,
        containerAttrs: container ? attrs(container) : null,
        containerHtml: container ? container.outerHTML : null,
        reactions: cands.map((b) => ({
          accessibleName: (b.getAttribute('aria-label') || b.innerText || '').trim(),
          tag: b.tagName.toLowerCase(),
          attrs: attrs(b),
          path: path(b),
          inFlyout: container ? container.contains(b) : false,
        })),
      };
    })()`) as any;
  } catch (e) {
    console.log('hover failed:', (e as Error).message);
  }
  console.log('opened    :', flyout.opened);
  console.log('container :', flyout.containerPath);
  console.log('attrs     :', JSON.stringify(flyout.containerAttrs, null, 2));
  dump('reaction-flyout.html', flyout.containerHtml ?? '(not found)');
  console.log(clip(flyout.containerHtml));
  section('6b. EACH REACTION CONTROL');
  console.log(JSON.stringify(flyout.reactions, null, 2));

  // move the pointer away so the flyout closes and cannot be clicked accidentally
  await page.mouse.move(5, 5);
  await new Promise((r) => setTimeout(r, 1200));

  section('7. COMMENT AFFORDANCES');
  console.log('comment controls:', JSON.stringify(structure.commentCtl, null, 2));
  console.log('editables       :', JSON.stringify(structure.editables, null, 2));

  section('8. CANONICAL URN IN THE DOM');
  console.log('attribute names carrying urn:li: ->', structure.urnAttrNames);
  console.log(JSON.stringify(structure.urnCarriers.slice(0, 40), null, 2));

  section('9. COMMENTS-DISABLED SIGNALS');
  console.log(structure.commentsOff.length ? JSON.stringify(structure.commentsOff, null, 2) : '(none on this post)');

  const containerHtml = await page.evaluate(`(() => {
    ${PAGE_HELPERS}
    const el = document.querySelector('[data-urn], [data-id^="urn:li:"], .feed-shared-update-v2, main');
    return el ? el.outerHTML : null;
  })()`) as string | null;
  dump('post-container.html', containerHtml ?? '(not found)');
  dump('full-page.html', await page.content());
  console.log(`\n[dumps] ${outDir}`);

  // =========================================================== PHASE B: ENGAGE
  const postScope = page.locator('div[data-urn][role="article"]').first();

  if (armText) {
    section('A10. COMMENT COMPOSER — armed state (NOTHING IS SUBMITTED)');
    const box = postScope.locator('div.ql-editor[contenteditable="true"][role="textbox"]').first();
    if ((await box.count()) === 0) {
      console.log('composer not rendered inline; the Comment button would have to open it.');
    } else {
      await box.scrollIntoViewIfNeeded();
      await box.click();
      await new Promise((r) => setTimeout(r, 700));
      await page.keyboard.insertText(armText);
      await new Promise((r) => setTimeout(r, 2000));
      const armed = await page.evaluate(`(() => {
        ${PAGE_HELPERS}
        const form = document.querySelector('form.comments-comment-box__form');
        if (!form) return { form: false };
        const ed = form.querySelector('[contenteditable="true"][role="textbox"]');
        return {
          form: true,
          formAttrs: attrs(form),
          editorText: ed ? (ed.innerText || '').trim() : null,
          editorHtml: ed ? ed.innerHTML : null,
          buttons: Array.from(form.querySelectorAll('button')).map((b) => ({
            text: (b.innerText || '').trim(), attrs: attrs(b), disabled: b.disabled, visible: visible(b), path: path(b),
          })),
          formHtmlTail: form.outerHTML.slice(-2500),
        };
      })()`) as any;
      console.log(JSON.stringify({ ...armed, formHtmlTail: undefined }, null, 2));
      dump('composer-armed.json', JSON.stringify(armed, null, 2));
      console.log('\n-- tail of the armed form --\n', clip(armed.formHtmlTail, 2500));
      // Clear the draft; leave the page as we found it.
      await box.click();
      await page.keyboard.press('Control+A');
      await page.keyboard.press('Delete');
      await new Promise((r) => setTimeout(r, 1200));
      console.log('composer cleared:', JSON.stringify(await box.innerText()));
    }
  }

  if (doLike) {
    section('B1. LIKE — before');
    const before = await likeState(page);
    console.log(JSON.stringify(before, null, 2));
    dump('like-before.json', JSON.stringify(before, null, 2));

    if (!before.found) {
      console.log('\n>> react trigger NOT FOUND — refusing to click anything.');
    } else if (before.attrs['aria-pressed'] === 'true') {
      console.log(`\n>> already reacted (${before.attrs['aria-label']}) — NOT clicking; a click would REMOVE it.`);
    } else {
      // Discovered selector, exact aria-label: cannot collide with a comment's own
      // like button ("React Like to <Name>'s comment") nor with the flyout entry
      // (same label, but no aria-pressed).
      const btn = postScope.locator('button[aria-pressed="false"][aria-label="React Like"]').first();
      console.log('matches for the discovered selector:', await postScope.locator('button[aria-pressed="false"][aria-label="React Like"]').count());
      await btn.scrollIntoViewIfNeeded();
      await btn.click();
      await new Promise((r) => setTimeout(r, 5000));
      section('B2. LIKE — after');
      const after = await likeState(page);
      console.log(JSON.stringify(after, null, 2));
      dump('like-after.json', JSON.stringify(after, null, 2));
    }
  }

  if (commentText) {
    section('C1. COMMENT — before');
    const before = await page.evaluate(`(() => {
      ${PAGE_HELPERS}
      return {
        editables: Array.from(document.querySelectorAll('[contenteditable="true"][role="textbox"]'))
          .map((e) => ({ attrs: attrs(e), path: path(e), visible: visible(e), text: (e.innerText||'').trim() })),
        commentArticles: Array.from(document.querySelectorAll('article[data-id^="urn:li:comment:"]'))
          .map((a) => ({ id: a.getAttribute('data-id'), text: (a.innerText||'').replace(/\\n/g,' | ').slice(0,160) })),
      };
    })()`);
    console.log(JSON.stringify(before, null, 2));
    dump('comment-before.json', JSON.stringify(before, null, 2));

    // Open the comment box if it is not already rendered (post detail pages render it
    // inline; the feed does not).
    const box = postScope.locator('div.ql-editor[contenteditable="true"][role="textbox"]').first();
    if ((await box.count()) === 0) {
      await postScope.locator('button[aria-label="Comment"]').first().click();
      await new Promise((r) => setTimeout(r, 3000));
    }
    await box.scrollIntoViewIfNeeded();
    await box.click();
    await new Promise((r) => setTimeout(r, 800));
    await page.keyboard.insertText(commentText);
    await new Promise((r) => setTimeout(r, 2000));

    section('C2. COMMENT — composer armed');
    const armed = await page.evaluate(`(() => {
      ${PAGE_HELPERS}
      const form = document.querySelector('form.comments-comment-box__form') || document;
      const ed = form.querySelector('[contenteditable="true"][role="textbox"]');
      return {
        editorText: ed ? (ed.innerText||'').trim() : null,
        editorHtml: ed ? ed.innerHTML : null,
        formButtons: Array.from(form.querySelectorAll('button')).map((b) => ({
          text: (b.innerText||'').trim(), attrs: attrs(b), disabled: b.disabled, visible: visible(b), path: path(b),
        })),
      };
    })()`) as any;
    console.log(JSON.stringify(armed, null, 2));
    dump('comment-submit-controls.json', JSON.stringify(armed, null, 2));

    if (armed.editorText !== commentText) {
      console.log(`\n>> composer text is ${JSON.stringify(armed.editorText)}, expected ${JSON.stringify(commentText)} — NOT submitting.`);
    } else {
      // Discovered 2026-08-02: the submit control carries NO aria-label and its only
      // accessible name is the inner text "Comment" — not "Post". It does not exist at
      // all until the editor has text, so its presence IS the armed signal. Scoping to
      // the form is mandatory: the action bar's own "Comment" button shares the name.
      const submit = postScope.locator('form.comments-comment-box__form button')
        .filter({ hasText: /^Comment$/ }).first();
      const n = await submit.count();
      console.log('submit-control matches:', n);
      if (n === 0) {
        console.log('>> no submit control found — NOT submitting.');
      } else {
        await submit.click();
        await new Promise((r) => setTimeout(r, 8000));

        section('C3. COMMENT — after');
        const after = await page.evaluate(`(() => {
          ${PAGE_HELPERS}
          const arts = Array.from(document.querySelectorAll('article[data-id^="urn:li:comment:"]'));
          return {
            commentArticles: arts.map((a) => ({
              id: a.getAttribute('data-id'), attrs: attrs(a),
              text: (a.innerText||'').replace(/\\n/g,' | ').slice(0, 300),
            })),
            editorTextNow: Array.from(document.querySelectorAll('[contenteditable="true"][role="textbox"]')).map((e) => (e.innerText||'').trim()),
            firstCommentHtml: arts.length ? arts[0].outerHTML : null,
          };
        })()`) as any;
        console.log(JSON.stringify({ ...after, firstCommentHtml: undefined }, null, 2));
        dump('comment-after.json', JSON.stringify(after, null, 2));
        dump('comment-after-page.html', await page.content());
      }
    }
  }
} catch (e) {
  console.error('[probe-post-engage] ERROR:', (e as Error).message);
  try { writeFileSync(join(outDir, 'error-page.html'), await page.content(), 'utf8'); } catch { /* ignore */ }
} finally {
  await ctx.close();
  console.log('[probe-post-engage] closed.');
}
