/**
 * Live verification of the enrichment path against real Apify. Costs ~$0.004 per profile.
 *
 *   npx tsx scripts/verify-enrichment.ts [profileUrl] [--count N]
 *
 * Reads the API key from the database (Settings → Connections) or APIFY_API_KEY.
 * WRITES NOTHING to the database — it fetches, extracts, and prints. Safe against
 * production, and safe to run while the app is up (it never touches the browser session).
 */
import { openDatabase } from '../src/db/database.js';
import { Repos } from '../src/db/repositories.js';
import { HttpApifyClient } from '../src/core/apify-client.js';
import { extractProfile, isEmptyProfile } from '../src/core/apify-extract.js';
import { DB_PATH } from '../src/config.js';

const args = process.argv.slice(2);
const countFlag = args.indexOf('--count');
const count = countFlag === -1 ? 1 : Number(args[countFlag + 1] ?? 1);
const explicitUrl = args.find((a) => a.startsWith('http'));

const repos = new Repos(openDatabase(DB_PATH));
const token = process.env.APIFY_API_KEY ?? repos.settings.get().apify_api_key;
if (!token) {
  console.error('No Apify key. Set APIFY_API_KEY, or save one under Settings → Connections.');
  process.exit(1);
}

// Pick real pending connections when no URL was given, so this exercises the same rows the
// worker would take next.
const targets = explicitUrl
  ? [explicitUrl]
  : repos.db.prepare("SELECT profile_url FROM connections WHERE enrich_status='pending' ORDER BY id LIMIT ?")
      .all(count).map((r) => (r as { profile_url: string }).profile_url);

if (targets.length === 0) {
  console.error('Nothing pending to verify against, and no URL given.');
  process.exit(1);
}

const client = new HttpApifyClient(token);
let ok = 0;
for (const url of targets) {
  const t0 = Date.now();
  try {
    const raw = await client.fetchProfile(url);
    const ms = Date.now() - t0;
    if (isEmptyProfile(raw)) {
      console.log(`EMPTY  ${url}  (${ms}ms) — restricted or deleted profile`);
      continue;
    }
    const p = extractProfile(raw);
    ok++;
    console.log(`OK     ${url}  (${ms}ms)`);
    console.log(`  name     : ${p.full_name}`);
    console.log(`  headline : ${(p.headline ?? '').slice(0, 70)}`);
    console.log(`  role     : ${p.current_title ?? '—'} @ ${p.current_company ?? '—'}`);
    console.log(`  location : ${p.location_raw ?? '—'}  ->  city=${p.location_city ?? '—'} region=${p.location_region ?? '—'} country=${p.location_country ?? '—'} (${p.location_country_code ?? '—'})`);
    console.log(`  id       : ${p.linkedin_id ?? '(none)'}`);
    console.log(`  doc      : ${p.doc.length} chars, ${p.doc.split('\n').length} lines`);
  } catch (e) {
    console.error(`FAIL   ${url} — ${(e as Error).message}`);
  }
}
console.log(`\n${ok}/${targets.length} enriched cleanly. Nothing was written to the database.`);
