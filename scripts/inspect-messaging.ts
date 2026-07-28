// Read-only discovery for the MESSAGE flow (design spike, 2026-07-28):
// 1. On a 1st-degree profile: where is the Message button, what does clicking it open
//    (overlay composer vs /messaging/ page), what marks the composer + send button?
//    Opens the composer but NEVER types or sends.
// 2. On a non-connected (invite-pending) profile: what does the top card show instead,
//    so "not a 1st-degree" is detectable BEFORE any message attempt?
// 3. On /messaging/: the conversation-list DOM, to judge whether reply-checking can be
//    a single-page scan.
// Run (app stopped): npx tsx scripts/inspect-messaging.ts <outDir> [firstDegreeSlug] [pendingSlug]
import { launchPersistentContext } from 'cloakbrowser';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BROWSER_PROFILE_DIR } from '../src/config.js';

const outDir = process.argv[2];
if (!outDir) { console.error('usage: inspect-messaging.ts <outDir> [slug1st] [slugPending]'); process.exit(1); }
mkdirSync(outDir, { recursive: true });
const slug1st = process.argv[3] ?? 'vipulgupta0a9a02';
const slugPending = process.argv[4] ?? 'tanner-f-6830a1236';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const findings: Record<string, unknown> = {};

const ctx = await launchPersistentContext({
  userDataDir: BROWSER_PROFILE_DIR, headless: false, humanize: true,
  locale: 'en-US', viewport: { width: 1280, height: 900 },
});
await ctx.addCookies([
  { name: 'lang', value: 'v=2&lang=en-US', domain: '.linkedin.com', path: '/' },
  { name: 'lang', value: 'v=2&lang=en-US', domain: '.www.linkedin.com', path: '/' },
]);
const page = ctx.pages()[0] ?? (await ctx.newPage());

/** Top-card snapshot: degree token, action buttons, message-button details. */
async function inspectTopCard() {
  return page.evaluate(() => {
    // tsx/esbuild keep-names injects __name() calls; the helper doesn't exist in-page.
    (globalThis as { __name?: unknown }).__name = (t: unknown) => t;
    const attrs = (el: Element) => ({
      tag: el.tagName.toLowerCase(),
      text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60),
      ariaLabel: el.getAttribute('aria-label'),
      id: el.id || null,
      class: (el.className || '').toString().slice(0, 120),
      disabled: (el as HTMLButtonElement).disabled ?? null,
    });
    const main = document.querySelector('main');
    const topCard = main?.querySelector('section');
    const degreeRe = /^(·\s*)?(1st|2nd|3rd)\+?$/i;
    const degree = Array.from(topCard?.querySelectorAll('span,div') || [])
      .map((el) => Array.from(el.childNodes).filter((n) => n.nodeType === 3)
        .map((n) => n.textContent || '').join('').trim())
      .filter((t) => degreeRe.test(t));
    const buttons = Array.from(topCard?.querySelectorAll('button, a.artdeco-button') || []).map(attrs);
    const msgBtn = Array.from(topCard?.querySelectorAll('button, a.artdeco-button') || [])
      .find((b) => /message/i.test(b.getAttribute('aria-label') || b.textContent || ''));
    return {
      htmlLang: document.documentElement.lang,
      url: location.href,
      degreeTokens: [...new Set(degree)],
      topCardButtons: buttons,
      messageButton: msgBtn ? { ...attrs(msgBtn), outerHTML: msgBtn.outerHTML.slice(0, 600) } : null,
    };
  });
}

/** Composer snapshot after clicking Message — structure only, no typing. */
async function inspectComposer() {
  return page.evaluate(() => {
    (globalThis as { __name?: unknown }).__name = (t: unknown) => t;
    const overlays = Array.from(document.querySelectorAll('[class*="msg-overlay"]'))
      .map((el) => (el.className || '').toString().slice(0, 150));
    const editable = Array.from(document.querySelectorAll('div[contenteditable="true"]')).map((el) => ({
      role: el.getAttribute('role'),
      ariaLabel: el.getAttribute('aria-label'),
      class: (el.className || '').toString().slice(0, 150),
    }));
    const form = document.querySelector('form[class*="msg-form"], .msg-form');
    const formButtons = Array.from((form || document).querySelectorAll('button'))
      .filter((b) => /send|close|attach/i.test((b.getAttribute('aria-label') || b.textContent || '')))
      .map((b) => ({
        text: (b.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40),
        ariaLabel: b.getAttribute('aria-label'),
        type: b.getAttribute('type'),
        class: (b.className || '').toString().slice(0, 150),
        disabled: (b as HTMLButtonElement).disabled,
      }));
    const inMail = /inmail/i.test(document.querySelector('[class*="msg-overlay"], .msg-form')?.textContent || '');
    const headerButtons = Array.from(document.querySelectorAll('[class*="msg-overlay"] header button'))
      .map((b) => ({ ariaLabel: b.getAttribute('aria-label'), class: (b.className || '').toString().slice(0, 100) }));
    return { url: location.href, overlays, editable, formButtons, headerButtons, inMailMarker: inMail };
  });
}

try {
  // --- 1st-degree profile: top card + composer ---
  await page.goto(`https://www.linkedin.com/in/${slug1st}`, { waitUntil: 'domcontentloaded' });
  await sleep(8000);
  findings.firstDegreeTopCard = await inspectTopCard();
  await page.screenshot({ path: join(outDir, '1st-profile.png') });

  const clicked = await page.evaluate(() => {
    const topCard = document.querySelector('main section');
    const btn = Array.from(topCard?.querySelectorAll('button, a.artdeco-button') || [])
      .find((b) => /message/i.test(b.getAttribute('aria-label') || b.textContent || ''));
    if (btn) { (btn as HTMLElement).click(); return true; }
    return false;
  });
  if (clicked) {
    await sleep(5000);
    findings.composer = await inspectComposer();
    await page.screenshot({ path: join(outDir, 'composer.png') });
    // Close the overlay so the next navigation starts clean (best effort).
    await page.evaluate(() => {
      const close = Array.from(document.querySelectorAll('[class*="msg-overlay"] header button'))
        .find((b) => /close/i.test(b.getAttribute('aria-label') || ''));
      (close as HTMLElement | undefined)?.click();
    });
    await sleep(1500);
  } else {
    findings.composer = { error: 'Message button not found in top card' };
  }

  // --- Invite-pending (NOT connected) profile: top card only, no clicks ---
  await page.goto(`https://www.linkedin.com/in/${slugPending}`, { waitUntil: 'domcontentloaded' });
  await sleep(8000);
  findings.pendingTopCard = await inspectTopCard();
  await page.screenshot({ path: join(outDir, 'pending-profile.png') });

  // --- Messaging inbox: conversation-list structure, read only ---
  await page.goto('https://www.linkedin.com/messaging/', { waitUntil: 'domcontentloaded' });
  await sleep(8000);
  findings.inbox = await page.evaluate(() => {
    (globalThis as { __name?: unknown }).__name = (t: unknown) => t;
    const list = document.querySelector('ul[class*="conversations-list"], .msg-conversations-container__conversations-list');
    const rows = Array.from(list?.querySelectorAll(':scope > li') || []).slice(0, 4);
    return {
      url: location.href,
      listClass: list ? (list.className || '').toString().slice(0, 150) : null,
      rowCount: list?.querySelectorAll(':scope > li').length ?? 0,
      rows: rows.map((li) => ({
        class: (li.className || '').toString().slice(0, 150),
        name: (li.querySelector('[class*="participant-names"], h3')?.textContent || '').trim().slice(0, 40),
        snippet: (li.querySelector('[class*="message-snippet"], p')?.textContent || '').trim().slice(0, 80),
        time: (li.querySelector('time')?.textContent || '').trim(),
        unreadMarkers: Array.from(li.querySelectorAll('[class*="unread"], .notification-badge'))
          .map((el) => (el.className || '').toString().slice(0, 80)),
        link: li.querySelector('a')?.getAttribute('href')?.slice(0, 120) ?? null,
      })),
      sampleRowHtml: rows[0] ? rows[0].outerHTML.slice(0, 2500) : null,
    };
  });
  await page.screenshot({ path: join(outDir, 'inbox.png') });

  writeFileSync(join(outDir, 'findings.json'), JSON.stringify(findings, null, 2));
  console.log(JSON.stringify(findings, null, 2));
} catch (e) {
  console.error('[inspect-messaging] ERROR:', (e as Error).message);
  writeFileSync(join(outDir, 'findings.json'), JSON.stringify(findings, null, 2));
} finally {
  await ctx.close();
  console.log('[inspect-messaging] closed (nothing typed, nothing sent).');
}
