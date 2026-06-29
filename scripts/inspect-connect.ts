// Diagnostic v10: open the custom-invite composer, click "Add a note", dump the textarea
// and Send controls. No send (close at end).
import { launchPersistentContext } from 'cloakbrowser';
import { BROWSER_PROFILE_DIR } from '../src/config.js';

const slug = process.argv[2] ?? 'liron-lalezary';
const target = `https://www.linkedin.com/preload/custom-invite/?vanityName=${slug}`;
const ctx = await launchPersistentContext({
  userDataDir: BROWSER_PROFILE_DIR, headless: false, humanize: true,
  viewport: { width: 1280, height: 900 },
});
const page = ctx.pages()[0] ?? (await ctx.newPage());
try {
  await page.goto(target, { waitUntil: 'domcontentloaded' });
  await new Promise((r) => setTimeout(r, 6000));

  const addNote = page.locator('button[aria-label="Add a note"]').first();
  if (await addNote.isVisible().catch(() => false)) {
    await addNote.click();
    await new Promise((r) => setTimeout(r, 2000));
  } else {
    console.log('Add a note button not visible');
  }

  const dump = await page.evaluate(() => {
    const textareas = Array.from(document.querySelectorAll('textarea'))
      .filter((t) => (t as HTMLElement).offsetParent !== null)
      .map((t) => ({ name: t.getAttribute('name'), id: t.id, placeholder: t.getAttribute('placeholder'), maxlen: t.getAttribute('maxlength') }));
    const buttons = Array.from(document.querySelectorAll('button'))
      .filter((b) => (b as HTMLElement).offsetParent !== null)
      .map((b) => ({ aria: b.getAttribute('aria-label'), text: (b.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 30) }))
      .filter((b) => /send|note|invitation/i.test((b.aria || '') + ' ' + b.text));
    return { textareas, buttons };
  });
  console.log(JSON.stringify(dump, null, 2));
  await new Promise((r) => setTimeout(r, 1500));
} catch (e) {
  console.error('[inspect] ERROR:', (e as Error).message);
} finally {
  await ctx.close();
  console.log('[inspect] closed (no invitation sent).');
}
