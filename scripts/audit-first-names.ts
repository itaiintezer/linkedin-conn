/**
 * Quality audit of first-name resolution — the review pass that `verify-first-names.ts`
 * cannot do on its own.
 *
 *   npx tsx scripts/audit-first-names.ts            # offline: dump for human/AI review
 *   npx tsx scripts/audit-first-names.ts --review   # send to Claude for a verdict per row
 *
 * READ-ONLY against the database. Nothing here is imported by `src/` — the app keeps zero
 * AI dependencies and the send path stays deterministic and offline. This is a bench tool.
 *
 * Two questions, because they fail in opposite directions:
 *
 *   CHANGED   — rows firstNameFrom rewrites. Risk: over-stripping. "Julie Ann" -> "Julie" is
 *               right; mangling a real given name would be worse than the original.
 *   UNCHANGED — rows it leaves alone. Risk: a name that still needs cleaning and now looks
 *               blessed. verify-first-names.ts is blind to these by construction, so the
 *               sample is biased toward the suspicious ones (multi-token, punctuation,
 *               non-Latin, unusual length) rather than uniform — a uniform sample of 7k
 *               mostly-clean names would spend the whole budget confirming "Ada" is fine.
 */
import { DatabaseSync } from 'node:sqlite';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { firstNameFrom } from '../src/core/first-name.js';
import { DB_PATH } from '../src/config.js';

const REVIEW = process.argv.includes('--review');
const OUT = 'data/first-name-audit.json';
/** Rows per model call. Small enough that one bad batch is cheap to re-run. */
const BATCH = 40;

interface Row { fn: string | null; fl: string | null }
interface Case { full: string | null; stored: string | null; next: string | null }

const db = new DatabaseSync(DB_PATH, { readOnly: true });
const rows = db.prepare('SELECT first_name AS fn, full_name AS fl FROM connections')
  .all() as unknown as Row[];

const changed: Case[] = [];
const unchanged: Case[] = [];
for (const r of rows) {
  const next = firstNameFrom(r.fn) ?? firstNameFrom(r.fl);
  (next === r.fn ? unchanged : changed).push({ full: r.fl, stored: r.fn, next });
}

/** Anything about an untouched row that could hide a bad greeting name. */
function suspicious(c: Case): boolean {
  const s = c.next ?? '';
  if (!s) return false;                                  // null is audited via the CHANGED set
  return /\s/.test(s)                                    // still multi-token
    || /[^\p{L}\p{M}'’.-]/u.test(s)                      // punctuation or symbols beyond a name's
    || /\./.test(s)                                      // kept dots: initialisms
    || s.length <= 2 || s.length >= 15                   // suspiciously short or long
    || !/^\p{Lu}/u.test(s.normalize('NFC'))              // does not start uppercase (non-cased scripts land here too)
    || /[֐-ࣿ　-鿿가-힯]/u.test(s); // non-Latin scripts
}

const suspects = unchanged.filter(suspicious);

console.log(`rows            : ${rows.length}`);
console.log(`changed         : ${changed.length}`);
console.log(`unchanged       : ${unchanged.length}`);
console.log(`  of which suspicious: ${suspects.length}`);

/**
 * Health of the column AS IT IS STORED RIGHT NOW — not of what the rule would do to it.
 * These are the five defect classes the original design doc measured over the roster; after
 * the backfill they should all read 0. This is the check to re-run when asking "is the
 * database actually clean", because it inspects the values the sender will really send.
 */
const CLASSES: [string, (s: string) => boolean][] = [
  ['multi-token', (s) => /\s/.test(s)],
  ['odd punctuation', (s) => /[^\p{L}\p{M}'’.\-]/u.test(s)],
  ['emoji / pictograph', (s) => /\p{Extended_Pictographic}/u.test(s)],
  ['honorific', (s) => /^(dr|mr|mrs|ms|prof|er|maj|capt|col|sir|rev|ts)\b\.?$/i.test(s.split(/[\s.]/)[0] ?? '')],
  ['invisible / bidi', (s) => /[\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\u00AD\uFEFF]/.test(s)],
  ['lone initial', (s) => /^\p{L}\.?$/u.test(s)],
];
const stored = rows.map((r) => r.fn).filter((s): s is string => s !== null);
console.log(`\nstored column health (${stored.length} non-null of ${rows.length}):`);
let storedDefects = 0;
for (const [label, hit] of CLASSES) {
  const found = stored.filter(hit);
  storedDefects += found.length;
  const eg = found.slice(0, 3).map((s) => JSON.stringify(s)).join(', ');
  console.log(`  ${label.padEnd(20)} ${String(found.length).padStart(5)}${eg ? '   e.g. ' + eg : ''}`);
}
console.log(`  ${'TOTAL DEFECTS'.padEnd(20)} ${String(storedDefects).padStart(5)}`);
console.log(`  ${'null (send "there")'.padEnd(20)} ${String(rows.length - stored.length).padStart(5)}`);

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({ changed, suspects }, null, 2));
console.log(`\nwrote ${OUT} — ${changed.length} changed + ${suspects.length} suspect rows`);

if (!REVIEW) {
  console.log('re-run with --review to have Claude judge each row (needs ANTHROPIC_API_KEY)');
  process.exit(0);
}

const KEY = process.env.ANTHROPIC_API_KEY;
if (!KEY) {
  console.error('\nANTHROPIC_API_KEY is not set — cannot run the model pass.');
  console.error(`The dump at ${OUT} is complete and can be reviewed without it.`);
  process.exit(1);
}

const PROMPT = `You are auditing an automated "first name" extractor for a LinkedIn outreach tool.
Each message it produces starts with "Hi <name>," so the extracted value must be the name that
person would actually want to be greeted by. When nothing usable exists the extractor returns
null and the tool sends "Hi there," which is an acceptable, safe answer.

For each numbered case decide whether the "extracted" value is a GOOD greeting for that person.

Judge by these rules:
- A given name (or the initialism someone genuinely goes by, like "K.C.") is good.
- A surname, honorific ("Dr."), credential ("CISSP"), emoji, initial-only ("J."), role, or
  company name is bad.
- Dropping a middle name or a second given token is GOOD, not a loss ("Julie Ann" -> "Julie").
- null is GOOD when the full name contains no usable given name; bad if a real name was there.
- For a bilingual name ("Tomer Segev תומר שגב"), the Latin given name is good.
- Family-name-first ordering (some CJK names) may make the extractor pick the surname. Flag it
  only if you are confident of the ordering.

Reply with a JSON array, one object per case, no prose:
[{"i": <number>, "ok": <true|false>, "better": <string|null>, "why": "<short>"}]
Set "better" only when ok is false: the value the extractor should have produced.`;

async function judge(cases: Case[], offset: number): Promise<unknown[]> {
  const lines = cases.map((c, k) => `${offset + k}. full=${JSON.stringify(c.full)} extracted=${JSON.stringify(c.next)}`);
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': KEY!,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-opus-4-5',
      max_tokens: 8000,
      system: PROMPT,
      messages: [{ role: 'user', content: lines.join('\n') }],
    }),
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${await res.text()}`);
  const body = await res.json() as { content: { type: string; text?: string }[] };
  const text = body.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const json = text.slice(text.indexOf('['), text.lastIndexOf(']') + 1);
  return JSON.parse(json) as unknown[];
}

const all: Case[] = [...changed, ...suspects];
const verdicts: { i: number; ok: boolean; better: string | null; why: string }[] = [];
for (let i = 0; i < all.length; i += BATCH) {
  const slice = all.slice(i, i + BATCH);
  process.stdout.write(`\rjudging ${i + slice.length}/${all.length}…`);
  verdicts.push(...(await judge(slice, i) as typeof verdicts));
}
console.log();

const bad = verdicts.filter((v) => v && !v.ok);
console.log(`\nmodel judged ${verdicts.length} rows: ${verdicts.length - bad.length} good, ${bad.length} questioned\n`);
for (const v of bad) {
  const c = all[v.i];
  if (!c) continue;
  console.log(`  full=${JSON.stringify(c.full)}`);
  console.log(`    extracted=${JSON.stringify(c.next)} suggested=${JSON.stringify(v.better)} — ${v.why}`);
}
writeFileSync(OUT, JSON.stringify({ changed, suspects, verdicts }, null, 2));
console.log(`\nwrote ${OUT} (now including verdicts)`);
