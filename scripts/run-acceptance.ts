// Run the real acceptance checker against the live account + local DB, and print the
// before/after profile statuses. Reads LinkedIn pages (no sends); writes local DB.
// Run with the server STOPPED. Run: npx tsx scripts/run-acceptance.ts
import { openDatabase } from '../src/db/database.js';
import { Repos } from '../src/db/repositories.js';
import { LinkedInDriver } from '../src/browser/linkedin-driver.js';
import { runAcceptanceCheck } from '../src/worker/acceptance-checker.js';
import { DB_PATH } from '../src/config.js';

const repos = new Repos(openDatabase(DB_PATH));
const driver = new LinkedInDriver();
const snap = () => repos.profiles.all().map((p) => ({ url: p.profile_url, status: p.status }));
try {
  // Launch the persistent (logged-in) browser so isLoggedIn() sees the cookie.
  await driver.openLoginWindow();
  await new Promise((r) => setTimeout(r, 2500));

  console.log('BEFORE:', JSON.stringify(snap()));
  await runAcceptanceCheck(repos, driver, new Date());
  console.log('AFTER :', JSON.stringify(snap()));
} catch (e) {
  console.error('ERROR:', (e as Error).message);
} finally {
  await driver.close();
  console.log('done.');
}
