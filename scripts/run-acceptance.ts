// Run the real acceptance checker against the local DB and print the before/after profile
// statuses. Run: npx tsx scripts/run-acceptance.ts
//
// No browser and no network. Since the phase-3 cutover the acceptance pass is a pure DB read
// that resolves sent invites against the connection roster; scraping the connections page is
// roster-sync's job now. This script used to open the persistent browser and pass the driver
// into runAcceptanceCheck, which stopped compiling when that argument was dropped — it went
// unnoticed because tsconfig did not include `scripts/`. It does now.
import { openDatabase } from '../src/db/database.js';
import { Repos } from '../src/db/repositories.js';
import { runAcceptanceCheck } from '../src/worker/acceptance-checker.js';
import { DB_PATH } from '../src/config.js';

const repos = new Repos(openDatabase(DB_PATH));
const snap = () => repos.profiles.all().map((p) => ({ url: p.profile_url, status: p.status }));
try {
  console.log('BEFORE:', JSON.stringify(snap()));
  await runAcceptanceCheck(repos, new Date());
  console.log('AFTER :', JSON.stringify(snap()));
} catch (e) {
  console.error('ERROR:', (e as Error).message);
} finally {
  console.log('done.');
}
