/**
 * Compare the live roster against a pre-migration backup, to prove the first-name backfill
 * changed what it promised and nothing else.
 *
 *   npx tsx scripts/verify-backfill.ts [backupFile]
 *
 * Defaults to `<db>.pre-firstname-backup`, the snapshot the backfill takes for itself. Opens
 * both databases READ-ONLY and writes nothing, so it is safe to run at any time.
 *
 * The property that matters: `full_name` is the verbatim display name that search, the UI and
 * the reply matcher all depend on. The repair must not have touched a single one.
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { DB_PATH } from '../src/config.js';

const backupPath = process.argv[2] ?? `${DB_PATH}.pre-firstname-backup`;
if (!existsSync(backupPath)) {
  console.error(`no backup at ${backupPath}`);
  console.error('(the backfill only writes one on a run that actually had rows to repair)');
  process.exit(1);
}

interface Row { id: number; fn: string | null; fl: string | null }
const QUERY = 'SELECT id, first_name AS fn, full_name AS fl FROM connections';

const live = new DatabaseSync(DB_PATH, { readOnly: true });
const pre = new DatabaseSync(backupPath, { readOnly: true });
const liveRows = live.prepare(QUERY).all() as unknown as Row[];
const preRows = pre.prepare(QUERY).all() as unknown as Row[];

const before = new Map(preRows.map((r) => [r.id, r]));
let fullChanged = 0; let firstChanged = 0; let added = 0; let nulled = 0;
const offenders: string[] = [];
const samples: string[] = [];

for (const now of liveRows) {
  const was = before.get(now.id);
  if (!was) { added++; continue; }            // rows the app inserted after the snapshot
  if (was.fl !== now.fl) {
    fullChanged++;
    if (offenders.length < 10) offenders.push(`  id=${now.id} ${JSON.stringify(was.fl)} -> ${JSON.stringify(now.fl)}`);
  }
  if (was.fn !== now.fn) {
    firstChanged++;
    if (now.fn === null) nulled++;
    if (samples.length < 12) samples.push(`  ${JSON.stringify(was.fl ?? '').slice(0, 40).padEnd(42)} ${JSON.stringify(was.fn).padEnd(22)} -> ${JSON.stringify(now.fn)}`);
  }
}

console.log(`backup             : ${backupPath}`);
console.log(`rows  live/backup  : ${liveRows.length} / ${preRows.length}`);
console.log(`first_name changed : ${firstChanged}   (${nulled} became null -> greeted "there")`);
console.log(`rows added since   : ${added}`);
console.log(`full_name changed  : ${fullChanged}   <-- MUST be 0`);
if (offenders.length) console.log(offenders.join('\n'));
console.log(`\nsample of the repair:`);
console.log(samples.join('\n'));

live.close(); pre.close();
process.exit(fullChanged === 0 ? 0 : 1);
