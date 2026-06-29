// Verify the real send flow end-to-end via the actual LinkedInDriver.
// Sends ONE real no-note connection request to the given profile.
// Run: npx tsx scripts/verify-send.ts [profileUrl]
import { LinkedInDriver } from '../src/browser/linkedin-driver.js';

const url = process.argv[2] ?? 'https://www.linkedin.com/in/liron-lalezary';
const driver = new LinkedInDriver();
try {
  console.log('sending no-note connection request to:', url);
  const outcome = await driver.sendConnectionRequest(url, null);
  console.log('OUTCOME:', JSON.stringify(outcome));
} catch (e) {
  console.error('ERROR:', (e as Error).message);
} finally {
  await driver.close();
  console.log('done.');
}
