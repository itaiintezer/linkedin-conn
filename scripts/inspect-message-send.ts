// LIVE message-send discovery (design spike, 2026-07-28). Sends ONE real message to the
// explicitly approved test profile — never point this at anyone else.
// Flow mirrors the future driver: profile page → verify "· 1st" degree badge → extract the
// /messaging/compose/ deep link → navigate to it (stable msg-form overlay) → type → Send →
// verify (composer cleared + our text in the thread's last event).
// Run (app stopped): npx tsx scripts/inspect-message-send.ts <outDir> <slug> "<text>"
import { launchPersistentContext } from 'cloakbrowser';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BROWSER_PROFILE_DIR } from '../src/config.js';

const [outDir, slug, text] = process.argv.slice(2);
if (!outDir || !slug || !text) {
  console.error('usage: inspect-message-send.ts <outDir> <slug> "<message text>"');
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });
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

try {
  // --- Step 1: profile page — degree gate + compose link, exactly as the driver would. ---
  await page.goto(`https://www.linkedin.com/in/${slug}`, { waitUntil: 'domcontentloaded' });
  await sleep(8000);
  findings.gate = await page.evaluate(() => {
    (globalThis as { __name?: unknown }).__name = (t: unknown) => t;
    // Name = first h2 that sits inside a link to this very profile (the top-card pattern).
    const nameEl = document.querySelector('main h2') ?? document.querySelector('h2');
    // Degree: walk up from the name until an ancestor contains a <p> whose exact text is
    // "· 1st" (the badge renders as a sibling <p> a few levels above the h2). Capped walk
    // so a page-wide search can never match some other profile's badge in the right rail.
    let firstDegree = false;
    let cur: Element | null = nameEl;
    for (let i = 0; cur && i < 8 && !firstDegree; i++, cur = cur.parentElement) {
      firstDegree = Array.from(cur.querySelectorAll('p'))
        .some((p) => /^·\s*1st$/.test((p.textContent || '').trim()));
    }
    const composeHref = document.querySelector('a[href*="/messaging/compose/"]')?.getAttribute('href') ?? null;
    return { name: (nameEl?.textContent || '').trim(), firstDegree, composeHref, url: location.href };
  });
  await page.screenshot({ path: join(outDir, 'send1-profile.png') });
  const gate = findings.gate as { firstDegree: boolean; composeHref: string | null };
  if (!gate.composeHref) throw new Error('no compose deep link on profile');
  if (!gate.firstDegree) throw new Error('degree gate says NOT 1st — refusing to send');

  // --- Step 2: compose route → stable msg-form overlay. ---
  await page.goto(`https://www.linkedin.com${gate.composeHref}`, { waitUntil: 'domcontentloaded' });
  await sleep(7000);
  const sendBtnSel = 'button.msg-form__send-button';
  const boxSel = 'div.msg-form__contenteditable[contenteditable="true"]';
  findings.beforeTyping = {
    sendDisabled: await page.locator(sendBtnSel).isDisabled(),
    boxVisible: await page.locator(boxSel).isVisible(),
  };

  // --- Step 3: type like a human; send button should flip to enabled. ---
  await page.locator(boxSel).click();
  await page.keyboard.type(text, { delay: 45 });
  await sleep(1500);
  findings.afterTyping = { sendDisabled: await page.locator(sendBtnSel).isDisabled() };
  await page.screenshot({ path: join(outDir, 'send2-typed.png') });

  // --- Step 4: SEND (approved test profile only), then verify. ---
  await page.locator(sendBtnSel).click();
  await sleep(5000);
  findings.afterSend = await page.evaluate((sent) => {
    (globalThis as { __name?: unknown }).__name = (t: unknown) => t;
    const box = document.querySelector('div.msg-form__contenteditable');
    const events = Array.from(document.querySelectorAll('[class*="msg-s-event"]'))
      .map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 140));
    return {
      composerCleared: !(box?.textContent || '').includes(sent.slice(0, 30)),
      lastEvents: events.slice(-3),
      sentTextAppearsInThread: events.some((e) => e.includes(sent.slice(0, 40))),
      failureMarker: /failed to send|couldn.t send|message not sent/i.test(document.body.textContent || ''),
      sendButtonDisabledAgain: (document.querySelector('button.msg-form__send-button') as HTMLButtonElement | null)?.disabled ?? null,
    };
  }, text);
  await page.screenshot({ path: join(outDir, 'send3-after-send.png') });

  writeFileSync(join(outDir, 'send-findings.json'), JSON.stringify(findings, null, 2));
  console.log(JSON.stringify(findings, null, 2));
} catch (e) {
  console.error('[inspect-message-send] ERROR:', (e as Error).message);
  writeFileSync(join(outDir, 'send-findings.json'), JSON.stringify(findings, null, 2));
  await page.screenshot({ path: join(outDir, 'send-error.png') }).catch(() => {});
} finally {
  await ctx.close();
  console.log('[inspect-message-send] closed.');
}
