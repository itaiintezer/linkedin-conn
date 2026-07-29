// One-shot LIVE check of the real LinkedInDriver messaging path.
//
// Sends ONE message to the single profile the operator approved for testing, then reads
// the inbox. Multi-line on purpose: it exercises the Shift+Enter line-break path (a plain
// keyboard.type would map \n to Enter and could send a truncated message), and the reply
// checker's strongest matching tier needs the inbox rows to carry thread URLs.
//
// Run with the app STOPPED (.linkedin-profile is single-instance):
//   npx tsx scripts/verify-message-send.ts [--gate-only <slug>]
//
// --gate-only <slug> sends NOTHING: it only asserts the 1st-degree gate refuses a
// non-connection (expected verdict: not_connected).
import { LinkedInDriver } from '../src/browser/linkedin-driver.js';

/** The ONLY profile approved for live message tests. Never point a send anywhere else. */
const APPROVED = 'https://www.linkedin.com/in/keren-tevet-3453a079';

const args = process.argv.slice(2);
const gateOnlyIdx = args.indexOf('--gate-only');
const gateOnly = gateOnlyIdx !== -1 ? args[gateOnlyIdx + 1] : null;

const driver = new LinkedInDriver();
try {
  if (gateOnly) {
    const url = `https://www.linkedin.com/in/${gateOnly.replace(/^.*\/in\//, '').replace(/\/$/, '')}`;
    if (url === APPROVED) throw new Error('--gate-only expects a NON-connection slug');
    console.log(`[gate] expecting not_connected for ${url} (nothing will be sent)`);
    const out = await driver.sendMessage(url, 'THIS MUST NOT BE SENT');
    console.log(JSON.stringify(out, null, 2));
    console.log(out.result === 'not_connected'
      ? '[gate] PASS — refused a non-connection, no message sent'
      : `[gate] FAIL — expected not_connected, got ${out.result}`);
  } else {
    const text = [
      'Hi {firstName}, automated test #2 from Itai’s outreach tool — please ignore.',
      '',
      'This message is intentionally multi-line to verify line breaks survive typing.',
    ].join('\n');
    const out = await driver.sendMessage(APPROVED, text);
    console.log('--- sendMessage ---');
    console.log(JSON.stringify(out, null, 2));
  }

  const inbox = await driver.readInboxSnapshot();
  console.log('--- readInboxSnapshot ---');
  console.log(`rows: ${inbox.length}, with threadUrl: ${inbox.filter((r) => r.threadUrl).length}`);
  console.log(JSON.stringify(inbox.slice(0, 4), null, 2));
} catch (e) {
  console.error('[verify] ERROR:', (e as Error).message);
  process.exitCode = 1;
} finally {
  await driver.close();
  console.log('[verify] browser closed.');
}
