/**
 * Read-only audit of first-name resolution over the real roster.
 *
 *   npx tsx scripts/verify-first-names.ts [--all]
 *
 * Prints every name the sanitiser would change and the totals. WRITES NOTHING, so it is safe
 * to run against production at any time, including while the app is up.
 */
import { DatabaseSync } from 'node:sqlite';
import { firstNameFrom } from '../src/core/first-name.js';
import { DB_PATH } from '../src/config.js';

const showAll = process.argv.includes('--all');
const db = new DatabaseSync(DB_PATH, { readOnly: true });
const rows = db.prepare('SELECT first_name AS fn, full_name AS fl FROM connections')
  .all() as unknown as { fn: string | null; fl: string | null }[];

let changed = 0; let nulled = 0; const samples: string[] = [];
for (const r of rows) {
  const next = firstNameFrom(r.fn) ?? firstNameFrom(r.fl);
  if (next === r.fn) continue;
  changed++;
  if (next === null) nulled++;
  if (showAll || samples.length < 40) {
    samples.push(`  ${JSON.stringify(r.fl ?? '').slice(0, 44).padEnd(46)} ${JSON.stringify(r.fn).padEnd(24)} -> ${JSON.stringify(next)}`);
  }
}

console.log(`rows                 : ${rows.length}`);
console.log(`would change         : ${changed}`);
console.log(`would become null    : ${nulled}   (these send "there")`);
console.log(`\n  ${'FULL NAME'.padEnd(46)} ${'STORED'.padEnd(24)} -> SANITISED`);
console.log(samples.join('\n'));
if (!showAll && changed > samples.length) console.log(`  …and ${changed - samples.length} more (--all to see them)`);
