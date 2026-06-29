// Read-only verification of the acceptance-tracking readers against the live new UI.
// Sends nothing. Run: npx tsx scripts/verify-readers.ts
import { LinkedInDriver } from '../src/browser/linkedin-driver.js';

const d = new LinkedInDriver();
try {
  const pending = await d.readPendingInvites();
  console.log('pending invites:', pending.length);
  console.log('includes liron:', pending.includes('https://www.linkedin.com/in/liron-lalezary'));
  console.log('sample pending:', pending.slice(0, 6));

  const conns = await d.readRecentConnections();
  console.log('connections:', conns.length);
  console.log('sample connections:', conns.slice(0, 6));
} catch (e) {
  console.error('ERROR:', (e as Error).message);
} finally {
  await d.close();
  console.log('done.');
}
