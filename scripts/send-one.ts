// One-off: send a single real connection request to ONE queued/scheduled profile,
// using its cohort note, then update the DB exactly like the batch sender (status
// sent + sent_at + event) so the profile leaves the queue. Bypasses caps/guardrails
// by design — for targeted verification only. Requires the app stopped (profile lock).
// Run: npx tsx scripts/send-one.ts [urlSubstring]
import { LinkedInDriver } from '../src/browser/linkedin-driver.js';
import { openDatabase } from '../src/db/database.js';
import { Repos } from '../src/db/repositories.js';
import { selectNoteSource } from '../src/core/message.js';
import { DB_PATH } from '../src/config.js';

const match = process.argv[2] ?? 'mcsweeneychristy';
const repos = new Repos(openDatabase(DB_PATH));
const driver = new LinkedInDriver();
const now = new Date();

try {
  const candidates = [...repos.profiles.byStatus('scheduled'), ...repos.profiles.byStatus('queued')];
  const p = candidates.find((x) => x.profile_url.includes(match));
  if (!p) throw new Error(`no queued/scheduled profile matching "${match}"`);
  const cohort = repos.cohorts.findById(p.cohort_id)!;
  const note = selectNoteSource(p.custom_message, cohort.message_template);

  console.log(`profile #${p.id} ${p.profile_url}`);
  console.log(`note: ${note === null ? '(no note)' : note}`);

  const outcome = await driver.sendConnectionRequest(p.profile_url, note);
  console.log('OUTCOME:', JSON.stringify(outcome));

  if (outcome.result === 'sent') {
    repos.profiles.setStatus(p.id, 'sent', { sent_at: now.toISOString(), first_name: outcome.firstName ?? null });
    repos.events.recordSend(p.id, 'sent');
    console.log(`DB: profile #${p.id} -> sent (removed from queue).`);
  } else {
    console.log(`not sent (result=${outcome.result}); DB left unchanged.`);
  }
} catch (e) {
  console.error('ERROR:', (e as Error).message);
  process.exitCode = 1;
} finally {
  await driver.close();
  console.log('done.');
}
