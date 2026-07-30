/**
 * Live, read-only verification of the roster read.
 *
 * Opens the real browser against the persisted LinkedIn session, reads one scroll-loaded
 * page of connections, and prints what it found. WRITES NOTHING to the database — this
 * exercises the driver only, so it is safe to run against production at any time.
 *
 *   npx tsx scripts/verify-roster-sync.ts
 *
 * The app must NOT be running: `.linkedin-profile` is single-instance, and a running
 * server holds it (see RUNBOOK). Stop the app with Ctrl+C first.
 */
import { LinkedInDriver } from '../src/browser/linkedin-driver.js';

const driver = new LinkedInDriver();
try {
  const snap = await driver.readLoginState();
  if (!snap.loggedIn) {
    console.error('Not logged in — start the app and click Connect LinkedIn first.');
    process.exit(1);
  }

  const cards = await driver.readConnectionCards();
  const named = cards.filter((c) => c.name);
  console.log(`read ${cards.length} connection cards (${named.length} with a name)`);
  for (const c of cards.slice(0, 10)) console.log(`  ${c.name ?? '(no name)'} — ${c.url}`);

  if (cards.length === 0) {
    // The empty-read fail-safe means this costs us nothing at runtime — but it also means
    // a silently broken selector looks like "no new connections" forever. Fail loudly here.
    console.error('\nEMPTY READ — the card selector or the wheel-scrolling has drifted.');
    console.error('Fix readConnectionCards before merging. Do NOT relax the empty-read fail-safe.');
    process.exit(1);
  }
  const malformed = cards.filter((c) => !/^https:\/\/www\.linkedin\.com\/in\/[^/]+$/.test(c.url));
  if (malformed.length > 0) {
    console.error(`\n${malformed.length} URL(s) are not in normalized form, e.g. ${malformed[0].url}`);
    process.exit(1);
  }
  console.log('\nOK — non-empty read, all URLs normalized.');
} finally {
  await driver.close();
}
