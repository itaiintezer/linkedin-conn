# `{firstName}` Resolution — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `{firstName}` substitution correct for every name in the roster — no invisible characters, no `"Dr."`, no `"🪐 Leonardo"`, no `"Darrell J."` — by normalising names **once at write time** so `connections.first_name` becomes a trustworthy, ready-to-send value, and by sanitising the live-scrape fallback that invites depend on.

**Architecture:** One pure function, `firstNameFrom()`, is the single definition of "the name to greet this person by". It runs at every **write** point (Apify enrichment, CSV/scrape upsert, and a one-time backfill of the existing 7,153 rows) so the database column is clean, and at the one **read** point that has no database row to consult — the invite path's live page-title scrape. The sender resolves roster-first and injects the name into the driver; the driver keeps doing the substitution.

**Tech Stack:** Node 22+ (`node:sqlite`), TypeScript ESM, Fastify, playwright-core via cloakbrowser, vitest.

---

## Background — read this before writing code

### How it works today

`{firstName}` is deliberately left unsubstituted until the last moment:

1. [`selectNoteSource`](../../../src/core/message.ts) picks the text (per-profile `custom_message` → cohort `message_template` → none) and leaves the token intact.
2. `sender.ts` passes that raw text to `driver.sendConnectionRequest(url, note)` / `driver.sendMessage(url, text)`.
3. The **driver** substitutes, using a name it reads live:
   `readFirstName(page)` → `readFullName(page)` → **the browser tab title**, with the notification count and `" | LinkedIn"` stripped, then `.split(/\s+/)[0]`.
4. [`applyFirstName`](../../../src/core/message.ts) substitutes and falls back to the literal `'there'` when the name is null/blank.
5. The scraped name is written to `profiles.first_name` purely as a record of what was sent. **Nothing reads it back.**

### Why it needs fixing — measured against the live database

`connections.first_name` (from Apify / the CSV) is **not** a clean given name. Out of 7,153 rows:

| Problem | Count | Examples |
|---|---|---|
| Multi-token | 371 | `"Darrell J."`, `"Pritam H"`, `"' John"` |
| Odd punctuation | 90 | `"Xinyu (Jade)"`, `"Akyl \"Ambition\""` |
| Emoji | 35 | `"🪐 Leonardo"`, `"👨\u200D💻 Akash"` |
| Honorific | 32 | `"Dr. Chidhanandham"` |
| Invisible chars | 6 | `"Andrew \"AJ\"\u200B"` |

The page-title scrape is no better — two names already **sent** carried a leading `U+200F` RIGHT-TO-LEFT MARK, so those people received `"Hi \u200FErik,"`.

The exact function specified in Task 1 was run against the live database on 2026-07-31: all 37 unit cases below pass and it reduced **404 unusable names to 4**, and those 4 are genuinely nameless (`"M. G."`, `"❕A H."`) where `"there"` is the correct answer.

### Three facts that shape the design

1. **Invites have no roster row.** Measured: **0 of 79** queued/scheduled invites match a `connections` row — invites go to people you are *not* connected to, and the roster is by definition people you *are*. So the live scrape can never be removed; it must be sanitised. The roster short-circuit only benefits **message** campaigns.
2. **`raw_json` does not preserve `firstName`.** `extractProfile`'s compact payload omits it, so overwriting the column loses Apify's original. `full_name` is populated 7,153/7,153 so it is re-derivable, but Task 2 adds the raw fields first so the backfill is genuinely reversible.
3. **Non-Latin scripts are a non-issue.** Only 12 rows, and 9 are bilingual (`"Tomer Segev תומר שגב"`, `"Yue Zhuge 诸葛越"`) where the Latin half already yields a clean name. **No AI dependency is warranted** — this app has zero AI dependencies and adding one to fix ~4 rows would introduce an API key, cost, nondeterminism and a new failure mode on the send path.

### The hidden coupling — do not miss this

[`reply-checker.ts`](../../../src/worker/reply-checker.ts) reconstructs *what the sender sent* in order to tell the operator's own outreach apart from a genuine reply (the `"You:"` snippet test). It derives the name independently:

```ts
const firstName = (p.full_name ?? '').trim().split(/\s+/)[0] || null;
return applyFirstName(source, firstName, MAX_MESSAGE);
```

If the sender's name logic changes and this does not, reconstruction drifts and replies get mis-detected. Task 7 aligns it. Its comment already notes the matcher "tolerates the two disagreeing", so this is a correctness improvement rather than a live bug — but leaving it inconsistent would be a latent one.

### Existing code you must reuse, not duplicate

[`src/core/name-match.ts`](../../../src/core/name-match.ts) already canonicalises names for reply matching and encodes rules learned from real false positives:

- `ZERO_WIDTH` — the invisible characters to delete (never replace with a space; that splits a token).
- `POST_NOMINALS` — an explicit allow-list (`phd`, `cissp`, …). The file documents *why* a "short all-caps acronym" heuristic was rejected.
- **The `"Surname, Given"` trap** — a single-token head before a comma means the *tail* is the given name. Collapsing onto the head merges different people.

`canonicalName()` itself is **not** reusable here because it lowercases — we need display case. Share the constants and the comma rule, not the function.

---

## File Structure

| File | Change |
|---|---|
| `src/core/name-match.ts` | Export `ZERO_WIDTH`, `POST_NOMINALS` so the new module reuses them |
| `src/core/first-name.ts` (new) | `firstNameFrom(raw): string \| null` — the single definition |
| `src/core/apify-extract.ts` | Sanitise `first_name`; add raw `firstName`/`lastName` to the compact payload |
| `src/db/repositories.ts` | Sanitise in `ConnectionRepo.upsert`; add `backfillFirstNames()` |
| `src/db/database.ts` | Pre-backfill snapshot, mirroring the existing `.pre-connections-backup` pattern |
| `src/index.ts` | Run the one-time backfill at startup |
| `src/types.ts` | `firstName?: string` option on the two driver send methods |
| `src/browser/linkedin-driver.ts` | Sanitise `readFullName`; honour an injected `firstName` |
| `src/browser/driver.ts` | Same option on `FakeDriver` |
| `src/worker/sender.ts` | Resolve roster-first, pass `{ firstName }` into both send calls |
| `src/worker/reply-checker.ts` | Use `firstNameFrom` so reconstruction matches what was sent |
| `scripts/verify-first-names.ts` (new) | Print the before/after diff over the real roster |
| `API.md`, `README.md` | Document the resolution order |

Tests mirror source paths under `tests/`.

---

### Task 1: The `firstNameFrom` function

**Files:**
- Modify: `src/core/name-match.ts`
- Create: `src/core/first-name.ts`
- Test: `tests/core/first-name.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/core/first-name.test.ts`:

```ts
/**
 * firstNameFrom — the single definition of "the name to greet this person by".
 * Every case below is a real string observed in the live 7,153-row roster.
 */
import { test, expect } from 'vitest';
import { firstNameFrom } from '../../src/core/first-name.js';

test('passes a clean name through unchanged', () => {
  expect(firstNameFrom('Ada')).toBe('Ada');
  expect(firstNameFrom('Ada Lovelace')).toBe('Ada');
});

test('strips invisible and bidi characters', () => {
  // Two of these were actually SENT as "Hi \u200FErik," before this fix.
  expect(firstNameFrom('\u200FErik')).toBe('Erik');
  expect(firstNameFrom('Andrew\u200B')).toBe('Andrew');
  expect(firstNameFrom('\u202AChristopher\u202C')).toBe('Christopher');
});

test('strips emoji and pictographs', () => {
  expect(firstNameFrom('🪐 Leonardo Pizarro')).toBe('Leonardo');
  expect(firstNameFrom('👨\u200D💻 Akash')).toBe('Akash');
  expect(firstNameFrom('⚙️ Orlando')).toBe('Orlando');
});

test('drops honorifics', () => {
  expect(firstNameFrom('Dr. Chidhanandham Arunachalam')).toBe('Chidhanandham');
  expect(firstNameFrom('Maj Sumit Sharma')).toBe('Sumit');
  expect(firstNameFrom('Er. Pratik Paudel')).toBe('Pratik');   // Er. = Engineer (South Asia)
  expect(firstNameFrom('Prof Jane Doe')).toBe('Jane');
});

test('drops middle initials and post-nominals', () => {
  expect(firstNameFrom('Darrell J. Stinson, CISSP, CEH')).toBe('Darrell');
  expect(firstNameFrom('Mark S. Babbitt')).toBe('Mark');
  expect(firstNameFrom('Pritam H Mungse')).toBe('Pritam');
});

test('strips parentheticals and quoted nicknames', () => {
  expect(firstNameFrom('Xinyu (Jade) Fan')).toBe('Xinyu');
  expect(firstNameFrom('Akyl "Ambition" Phillips')).toBe('Akyl');
  expect(firstNameFrom('Suvarchala(Suva) Mareedu')).toBe('Suvarchala');
});

test('strips leading junk punctuation', () => {
  expect(firstNameFrom("' John R.")).toBe('John');
});

test('KEEPS an initialism people actually go by', () => {
  // "K.C. O'Brien" goes by "K.C." — mangling it to "K.C" would be worse than useless.
  expect(firstNameFrom("K.C. O'Brien")).toBe('K.C.');
  expect(firstNameFrom('T.M. White')).toBe('T.M.');
  expect(firstNameFrom('K.V.N. Rajesh, Ph.D.')).toBe('K.V.N.');
});

test('returns null when there is no usable name — caller sends "there"', () => {
  expect(firstNameFrom('M. G.')).toBeNull();
  expect(firstNameFrom('B L.')).toBeNull();
  expect(firstNameFrom('❕A H.')).toBeNull();
  expect(firstNameFrom('')).toBeNull();
  expect(firstNameFrom(null)).toBeNull();
  expect(firstNameFrom('   ')).toBeNull();
  expect(firstNameFrom('🪐')).toBeNull();
});

test('"Surname, Given" takes the GIVEN name, not the surname', () => {
  // name-match.ts documents this as a real LinkedIn display order. Taking token[0]
  // would greet David Cohen as "Cohen".
  expect(firstNameFrom('Cohen, David')).toBe('David');
  // …but a two-token head means the tail is a role or credential, not a name.
  expect(firstNameFrom('Keren Tevet, Head of Security')).toBe('Keren');
  expect(firstNameFrom('Erik Decker, CISSP')).toBe('Erik');
});

test('handles a name that is only a middle-dot-joined fragment', () => {
  expect(firstNameFrom('K N.Nitin')).toBe('Nitin');
});

test('non-Latin scripts: takes the first real token', () => {
  expect(firstNameFrom('דנאיל דימיטרוב')).toBe('דנאיל');
  expect(firstNameFrom('Tomer Segev תומר שגב')).toBe('Tomer');
  expect(firstNameFrom('益夫 加藤')).toBe('益夫');
});

test('ignores decorative combining-mark spam', () => {
  expect(firstNameFrom('Robert ็็้้้็็็ McCurdy')).toBe('Robert');
});

test('is pure and total — never throws on hostile input', () => {
  for (const s of ['', '   ', '...', ',,,', '()', '""', '\u200F', '🙂🙃', 'a'.repeat(500)]) {
    expect(() => firstNameFrom(s)).not.toThrow();
  }
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/core/first-name.test.ts`
Expected: FAIL — `Cannot find module '../../src/core/first-name.js'`.

- [ ] **Step 3: Export the shared constants from name-match.ts**

In `src/core/name-match.ts`, add the `export` keyword to the two existing declarations —
`ZERO_WIDTH` and `POST_NOMINALS`. **Do not retype, reorder or reword them**, and do not touch
their comments: both encode rules learned from real false positives.

```ts
export const ZERO_WIDTH = /* …existing regex, unchanged… */;
export const POST_NOMINALS = /* …existing Set, unchanged… */;
```

> **Verified gap — this is why Step 4 extends rather than reuses.** `ZERO_WIDTH` contains
> exactly U+200B, U+200C, U+200D, U+2060, U+00AD, U+FEFF. It does **not** contain U+200F
> (RIGHT-TO-LEFT MARK) — the very character that produced `"Hi \u200FErik,"` — nor U+200E, the
> U+202A–202E embeddings, or the U+2066–2069 isolates. Reusing `ZERO_WIDTH` alone would fail
> the `'\u200FErik'` test in Step 1. Extend it in `first-name.ts`; do **not** widen `ZERO_WIDTH`
> itself, because `canonicalName` feeds reply matching and changing what it strips changes
> which inbox rows match which contacts.

- [ ] **Step 4: Implement `src/core/first-name.ts`**

```ts
import { ZERO_WIDTH, POST_NOMINALS } from './name-match.js';

/**
 * Everything invisible that turns up in a scraped name. ZERO_WIDTH from name-match.ts covers
 * the zero-width family (U+200B/C/D, U+2060, U+00AD, U+FEFF) but NOT the bidi controls —
 * verified. U+200F is the character that shipped as "Hi \u200FErik," to two real people, so the
 * bidi marks, embeddings and isolates are added here rather than widening the shared
 * constant, which reply matching depends on.
 */
const INVISIBLE = new RegExp(`${ZERO_WIDTH.source}|[\u200E\u200F\u202A-\u202E\u2066-\u2069]`, 'gu');

/**
 * Titles that precede a name. Explicit list, never a heuristic — the same reasoning
 * name-match.ts records for POST_NOMINALS: a "short token" rule would eat real names.
 * "Er." is Engineer, common in South Asia and present in the live roster.
 */
const HONORIFICS = new Set([
  'dr', 'mr', 'mrs', 'ms', 'miss', 'mx', 'prof', 'professor', 'sir', 'dame', 'lord', 'lady',
  'rabbi', 'fr', 'rev', 'pastor', 'imam', 'sheikh',
  'capt', 'col', 'maj', 'sgt', 'lt', 'cmdr', 'gen',
  'er', 'eng', 'ing', 'arch', 'adv', 'hon',
]);

/** Emoji, pictographs, skin-tone modifiers and the ZWJ that binds them. */
const PICTOGRAPHIC =
  /\p{Extended_Pictographic}|\p{Emoji_Presentation}|[\u{1F3FB}-\u{1F3FF}\u{FE0F}\u{200D}]/gu;

/** A name people genuinely go by: two or more letter-dot pairs. "K.C." / "J.R." / "K.V.N." */
const INITIALISM = /^(?:\p{L}\.){2,}$/u;

/**
 * The display-safe first name for greeting someone, or null when nothing in the input can
 * be trusted as a name (the caller then sends "there" — see applyFirstName).
 *
 * Pure and total: hostile input yields null, never a throw. Case-preserving, so it cannot
 * reuse canonicalName() from name-match.ts, which lowercases for comparison.
 */
export function firstNameFrom(raw: string | null | undefined): string | null {
  if (!raw) return null;

  let s = String(raw).normalize('NFKC');
  s = s.replace(INVISIBLE, '');           // delete, never replace: a space would split a token
  s = s.replace(PICTOGRAPHIC, ' ');
  s = s.replace(/\([^)]*\)/g, ' ');       // "Xinyu (Jade) Fan"
  s = s.replace(/[()]/g, ' ');            // unbalanced remnant
  s = s.replace(/["“”„«»']/g, ' ');       // 'Akyl "Ambition" Phillips'

  // Comma handling, following the bounded rule in name-match.ts: a SINGLE-token head means
  // "Surname, Given" and the given name is the tail. A multi-token head means the tail is a
  // role or credential ("Keren Tevet, Head of Security").
  const parts = s.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length > 1) {
    const headTokens = parts[0].split(/\s+/).filter(Boolean).length;
    const tailWord = parts[1].replace(/[.\s]/g, '').toLowerCase();
    s = headTokens === 1 && !POST_NOMINALS.has(tailWord) ? parts[1] : parts[0];
  } else {
    s = parts[0] ?? '';
  }

  const tokens = s
    .split(/\s+/)
    .map((t) => t.replace(/^[^\p{L}]+/u, '').replace(/[^\p{L}.'’-]+$/u, ''))
    .filter(Boolean);

  for (const token of tokens) {
    const bare = token.replace(/[.'’\-]/g, '').toLowerCase();
    if (!bare) continue;
    if (HONORIFICS.has(bare)) continue;
    if (POST_NOMINALS.has(bare)) continue;

    // "K.C." is a name; keep its dots. Checked before the dot-splitting below.
    if (INITIALISM.test(token)) return token;

    // A dotted fragment like "N.Nitin" (malformed input): take the last real segment.
    if (token.includes('.')) {
      const seg = token.split('.').map((x) => x.trim()).filter((x) => x.length >= 2).pop();
      if (seg) return seg;
      continue;                            // "J." — a lone initial is not a name
    }

    if (bare.length < 2) continue;         // "B", "K"
    if (!/^\p{L}/u.test(token)) continue;
    return token;
  }
  return null;
}
```

- [ ] **Step 5: Run the test**

Run: `npx vitest run tests/core/first-name.test.ts`
Expected: PASS (13 tests). If `'益夫 加藤'` fails, check that `PICTOGRAPHIC` is not eating CJK — it must not.

- [ ] **Step 6: Commit**

```bash
git add src/core/first-name.ts src/core/name-match.ts tests/core/first-name.test.ts
git commit -m "feat(names): firstNameFrom — one definition of the greeting name"
```

---

### Task 2: Preserve the raw name in the stored payload

Do this **before** any backfill: it is what makes the change reversible.

**Files:** `src/core/apify-extract.ts`; Test: `tests/core/apify-extract.test.ts` (append)

- [ ] **Step 1: Failing test**

```ts
test('the stored payload keeps Apify\'s raw first/last name', () => {
  // The backfill overwrites the first_name COLUMN. Without the raw here, Apify's original
  // value is unrecoverable and the migration is one-way.
  const p = extractProfile({ firstName: 'Dr. Chidhanandham', lastName: 'Arunachalam' });
  expect(p.compact.firstNameRaw).toBe('Dr. Chidhanandham');
  expect(p.compact.lastNameRaw).toBe('Arunachalam');
});
```

Run: `npx vitest run tests/core/apify-extract.test.ts` → FAIL (`undefined`).

- [ ] **Step 2: Implement.** In `extractProfile`, inside the `compact` object literal, add:

```ts
    // Kept verbatim so the sanitised first_name column can always be recomputed or undone.
    firstNameRaw: first,
    lastNameRaw: last,
```

- [ ] **Step 3:** Run → PASS. **Step 4:** Commit.

---

### Task 3: Sanitise at every write point

**Files:** `src/core/apify-extract.ts`, `src/db/repositories.ts`; Tests: both existing files

- [ ] **Step 1: Failing tests**

Append to `tests/core/apify-extract.test.ts`:

```ts
test('extraction stores a sanitised first name, not Apify\'s raw fragment', () => {
  const p = extractProfile({ firstName: '🪐 Leonardo', lastName: 'Pizarro', name: '🪐 Leonardo Pizarro' });
  expect(p.first_name).toBe('Leonardo');
  expect(p.full_name).toBe('🪐 Leonardo Pizarro');   // display name is NOT sanitised
});

test('falls back to the full name when the first-name field is unusable', () => {
  expect(extractProfile({ firstName: 'M.', name: 'M. Grace Hopper' }).first_name).toBe('Grace');
});
```

Append to `tests/db/connections-repo.test.ts`:

```ts
test('upsert sanitises the first name from CSV or scrape input', () => {
  repos.connections.upsert(
    { profile_url: URL_A, first_name: 'Dr. Chidhanandham', full_name: 'Dr. Chidhanandham Arunachalam' },
    'csv', '2026-07-31T00:00:00.000Z',
  );
  expect(repos.connections.findByUrl(URL_A)!.first_name).toBe('Chidhanandham');
  expect(repos.connections.findByUrl(URL_A)!.full_name).toBe('Dr. Chidhanandham Arunachalam');
});

test('a roster-sync card name is sanitised too', () => {
  repos.connections.upsert({ profile_url: URL_A, full_name: '\u200FErik Decker' }, 'scrape', '2026-07-31T00:00:00.000Z');
  expect(repos.connections.findByUrl(URL_A)!.first_name).toBe('Erik');
});
```

- [ ] **Step 2: Implement**

In `apify-extract.ts`, import `firstNameFrom` and set the scalar:

```ts
    // Sanitised at WRITE time so the column is trustworthy everywhere it is read.
    // Apify's own firstName is a display fragment ("Darrell J.", "🪐 Leonardo"), so it is a
    // candidate, not an answer; the full name is the fallback.
    first_name: firstNameFrom(first) ?? firstNameFrom(fullName),
```

`full_name`, `headline` and the rest stay verbatim — only the greeting name is normalised.

In `ConnectionRepo.upsert`, derive it rather than trusting the caller. Replace the direct use of `input.first_name` in **both** the INSERT and the UPDATE paths with:

```ts
    // Same rule as enrichment: whatever the source, the stored greeting name is sanitised.
    const cleanFirst = firstNameFrom(input.first_name) ?? firstNameFrom(input.full_name);
```

Use `cleanFirst` wherever `input.first_name ?? null` appeared. Note the UPDATE path's existing
"fill NULLs, overwrite only while un-enriched" rule is unchanged — only the value differs.

- [ ] **Step 3:** Run both test files → PASS. **Step 4:** `npm test && npm run typecheck`. **Step 5:** Commit.

---

### Task 4: One-time backfill of the existing roster

**Files:** `src/db/repositories.ts`, `src/db/database.ts`, `src/index.ts`; Test: `tests/db/connections-repo.test.ts`

- [ ] **Step 1: Failing test**

```ts
test('backfillFirstNames repairs existing rows and is idempotent', () => {
  const rows = [
    ['https://www.linkedin.com/in/a', 'Dr. Chidhanandham', 'Dr. Chidhanandham Arunachalam'],
    ['https://www.linkedin.com/in/b', '🪐 Leonardo', '🪐 Leonardo Pizarro'],
    ['https://www.linkedin.com/in/c', 'Ada', 'Ada Lovelace'],          // already clean
    ['https://www.linkedin.com/in/d', 'M.', 'M. G.'],                  // unusable
  ];
  for (const [url, fn, fl] of rows) {
    repos.db.prepare(
      "INSERT INTO connections (profile_url, first_name, full_name, source, first_seen_at, last_seen_at) VALUES (?,?,?,'csv','x','x')",
    ).run(url, fn, fl);
  }

  expect(repos.connections.backfillFirstNames()).toBe(3);   // c was already correct

  const get = (u: string) => repos.connections.findByUrl(u)!.first_name;
  expect(get('https://www.linkedin.com/in/a')).toBe('Chidhanandham');
  expect(get('https://www.linkedin.com/in/b')).toBe('Leonardo');
  expect(get('https://www.linkedin.com/in/c')).toBe('Ada');
  expect(get('https://www.linkedin.com/in/d')).toBeNull();  // nothing usable -> "there" at send

  // Idempotent: a second pass changes nothing.
  expect(repos.connections.backfillFirstNames()).toBe(0);
});

test('the backfill never touches full_name', () => {
  repos.db.prepare(
    "INSERT INTO connections (profile_url, first_name, full_name, source, first_seen_at, last_seen_at) VALUES (?,?,?,'csv','x','x')",
  ).run('https://www.linkedin.com/in/z', '🪐 Leonardo', '🪐 Leonardo Pizarro');
  repos.connections.backfillFirstNames();
  expect(repos.connections.findByUrl('https://www.linkedin.com/in/z')!.full_name).toBe('🪐 Leonardo Pizarro');
});
```

- [ ] **Step 2: Implement `backfillFirstNames`** on `ConnectionRepo`:

```ts
  /**
   * Rewrite every stored greeting name through firstNameFrom. One-time repair for rows
   * written before sanitisation existed; safe to re-run (it only writes rows whose value
   * would actually change, and re-sanitising a clean name is a no-op).
   *
   * Only `first_name` is touched — `full_name` stays verbatim as the display name, and is
   * the input the repair derives from when the stored first name is unusable.
   * Returns how many rows changed.
   */
  backfillFirstNames(): number {
    const rows = this.db.prepare('SELECT id, first_name, full_name FROM connections')
      .all() as unknown as { id: number; first_name: string | null; full_name: string | null }[];
    const upd = this.db.prepare('UPDATE connections SET first_name = ? WHERE id = ?');
    let changed = 0;
    this.db.exec('BEGIN');
    try {
      for (const r of rows) {
        const next = firstNameFrom(r.first_name) ?? firstNameFrom(r.full_name);
        if (next !== r.first_name) { upd.run(next, r.id); changed++; }
      }
      this.db.exec('COMMIT');
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch { /* nothing to roll back */ }
      throw e;
    }
    return changed;
  }
```

One transaction, for the reason recorded in the phase-1 plan: `node:sqlite` is synchronous and
per-row commits fsync, which stalled the whole server for 6.5 s on an 8 k import.

- [ ] **Step 3: Snapshot before the first run.** In `src/db/database.ts`, inside `openDatabase`
next to the existing `.pre-connections-backup` block, add a `.pre-firstname-backup` snapshot
guarded the same way (only when `connections` exists, only when the backup does not):

```ts
    const nameBackup = `${path}.pre-firstname-backup`;
    if (hasTable('connections') && !existsSync(nameBackup)) {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
      copyFileSync(path, nameBackup);
    }
```

- [ ] **Step 4: Run it once at startup.** In `src/index.ts`, beside the existing seed call:

```ts
// One-time repair of names written before sanitisation existed. Cheap and idempotent after
// the first pass (it only writes rows whose value would change).
const repaired = repos.connections.backfillFirstNames();
if (repaired > 0) log.info('roster', 'repaired first names', { repaired });
```

- [ ] **Step 5:** `npm test && npm run typecheck` → PASS. **Step 6:** Commit.

---

### Task 5: Driver — sanitise the live scrape, accept an injected name

**Files:** `src/types.ts`, `src/browser/linkedin-driver.ts`, `src/browser/driver.ts`; Test: `tests/browser/driver.test.ts`

- [ ] **Step 1: Failing test**

```ts
test('FakeDriver prefers an injected first name over the one it would read', async () => {
  const d = new FakeDriver();
  d.firstName = 'Scraped';
  await d.sendConnectionRequest('https://www.linkedin.com/in/a', 'Hi {firstName}', { firstName: 'Ada' });
  expect(d.sentLog[0].message).toBe('Hi Ada');
});

test('FakeDriver falls back to its own name when none is injected', async () => {
  const d = new FakeDriver();
  d.firstName = 'Scraped';
  await d.sendConnectionRequest('https://www.linkedin.com/in/a', 'Hi {firstName}');
  expect(d.sentLog[0].message).toBe('Hi Scraped');
});

test('an injected name flows into a direct message too', async () => {
  const d = new FakeDriver();
  await d.sendMessage('https://www.linkedin.com/in/a', 'Hi {firstName}', { firstName: 'Grace' });
  expect(d.msgLog[0].message).toBe('Hi Grace');
});
```

- [ ] **Step 2: Widen the interface.** In `src/types.ts`:

```ts
/** Optional overrides for a send. `firstName` lets the caller supply a name resolved from
 *  the roster, so the driver does not have to derive one from the page title. */
export interface SendOptions { firstName?: string | null }
```

and change both signatures:

```ts
  sendConnectionRequest(url: string, message: string | null, opts?: SendOptions): Promise<SendOutcome>;
  sendMessage(url: string, message: string, opts?: SendOptions): Promise<SendOutcome>;
```

- [ ] **Step 3: Implement in `FakeDriver`** — use `opts?.firstName ?? this.firstName` where
`this.firstName` is currently passed to `applyFirstName`, in both methods.

- [ ] **Step 4: Implement in `LinkedInDriver`.** Sanitise the scrape at source:

```ts
  private async readFirstName(page: Page): Promise<string | undefined> {
    // The page title is a rendering artifact — it carries notification counts, bidi marks
    // and headline tails. Two names were sent with a leading U+200F before this.
    return firstNameFrom(await this.readFullName(page) ?? null) ?? undefined;
  }
```

Then in `sendConnectionRequest` and `sendMessage`, take the injected name first:

```ts
      const firstName = opts?.firstName ?? await this.readFirstName(page);
```

In `sendMessage` the full name is still read separately for the 1st-degree gate — leave
`readFullName` alone; only the derived first name changes.

- [ ] **Step 5:** Run → PASS, then `npm run typecheck`. **Step 6:** Commit.

---

### Task 6: Sender — resolve roster-first

**Files:** `src/worker/sender.ts`; Test: `tests/worker/sender.test.ts`

- [ ] **Step 1: Failing tests**

```ts
test('a message send greets the person with the roster name, not the scraped one', async () => {
  const c = repos.cohorts.create('M', 'Hi {firstName}', false, 'message');
  const p = repos.profiles.add(c.id, 'https://www.linkedin.com/in/ada', null, 'message');
  repos.connections.upsert({ profile_url: 'https://www.linkedin.com/in/ada', first_name: 'Ada' }, 'csv', NOW_ISO);
  driver.firstName = 'WrongScraped';

  await runSenderOnce(repos, driver, NOW, { sleep: async () => {} });

  expect(driver.msgLog[0].message).toBe('Hi Ada');
});

test('an invite falls back to the live read — invitees are not in the roster', async () => {
  // Measured: 0 of 79 pending invites have a roster row. This path must keep working.
  const c = repos.cohorts.create('I', 'Hi {firstName}', false, 'invite');
  repos.profiles.add(c.id, 'https://www.linkedin.com/in/stranger', null, 'invite');
  driver.firstName = 'Scraped';

  await runSenderOnce(repos, driver, NOW, { sleep: async () => {} });

  expect(driver.sentLog[0].message).toBe('Hi Scraped');
});
```

- [ ] **Step 2: Implement.** Add a helper near the top of `sender.ts`:

```ts
/**
 * The greeting name for a send. The roster is preferred because it is already sanitised and
 * available without a page read — but invitees are by definition NOT connections (measured:
 * 0 of 79 pending invites had a roster row), so `undefined` here means "let the driver read
 * it live", which is the normal path for invites.
 */
function rosterFirstName(repos: Repos, profileUrl: string): string | undefined {
  return repos.connections.findByUrl(profileUrl)?.first_name ?? undefined;
}
```

Pass it at all three call sites — both `sendConnectionRequest` calls and the `sendMessage`
call — as `{ firstName: rosterFirstName(repos, p.profile_url) }`.

- [ ] **Step 3:** Run → PASS. **Step 4:** `npm test`. **Step 5:** Commit.

---

### Task 7: Keep reply detection in step

**Files:** `src/worker/reply-checker.ts`; Test: `tests/worker/reply-resolve.test.ts`

The reply checker rebuilds what the sender sent, to tell the operator's own outreach from a
genuine reply. It currently derives the name with its own `split(/\s+/)[0]`; leaving that
while the sender changes would drift the reconstruction.

- [ ] **Step 1: Understand the shape before changing it**

`outreachFor` is a **private closure** inside `runReplyCheck` (around line 285) — it is not
exported, so it cannot be unit-tested directly. It is handed to `resolveRow`, which passes it
to the exported `snippetIsOurOutreach`. Test at that seam instead of refactoring.

- [ ] **Step 2: Failing test**

Append to `tests/worker/reply-resolve.test.ts` (it already imports `resolveRow`,
`buildPendingIndex` and `snippetIsOurOutreach`, and defines the `prof` / `row` helpers):

```ts
/* ---------- the reconstruction must use the sender's name rule ----------
   The sender greets "Dr. Chidhanandham Arunachalam" as "Chidhanandham". If the checker
   rebuilds the outreach as "Hi Dr." the snippet no longer matches, the message looks like a
   reply, and the contact is wrongly marked replied — irreversible, and it strands them. */
test('our own outreach is recognised when the name needed sanitising', () => {
  const p = prof(1, 'Dr. Chidhanandham Arunachalam');
  const sent = 'Hi Chidhanandham, quick question';   // what the sender actually sent

  const res = resolveRow(
    row('Dr. Chidhanandham Arunachalam', { snippet: `You: ${sent}`, youSentLast: true }),
    buildPendingIndex([p]),
    // Stand-in for the closure under test: it MUST derive the same name the sender used.
    (x) => applyFirstName('Hi {firstName}, quick question', firstNameFrom(x.full_name), MAX_MESSAGE),
  );

  expect(res.kind).not.toBe('replied');
});
```

Add the imports this needs at the top of the file:

```ts
import { firstNameFrom } from '../../src/core/first-name.js';
import { applyFirstName, MAX_MESSAGE } from '../../src/core/message.js';
```

If `res.kind` is not the discriminator this version of `RowResolution` uses, read the
interface at `src/worker/reply-checker.ts:97` and assert on whatever marks a reply — the
point of the test is that a sanitised-name outreach is **not** counted as a reply.

- [ ] **Step 3: Implement.** In `runReplyCheck`'s `outreachFor` closure, replace:

```ts
    const firstName = (p.full_name ?? '').trim().split(/\s+/)[0] || null;
```

with:

```ts
    // Must match the sender exactly — see rosterFirstName in sender.ts. A divergence here
    // does not fail loudly; it silently mis-detects replies.
    const firstName = firstNameFrom(p.full_name);
```

and import `firstNameFrom` from `../core/first-name.js`.

> **Known limitation, leave as-is:** this reconstructs *historical* sends using the *new*
> rule, so messages sent before this change (with e.g. `"Dr."`) reconstruct differently than
> they were sent. `snippetIsOurOutreach` is deliberately fuzzy and the file documents that it
> "tolerates the two disagreeing", so this is an improvement, not a regression. Do not try to
> version the rule per-message.

- [ ] **Step 3:** Run → PASS. **Step 4:** Commit.

---

### Task 8: Verify against the real roster, then document

**Files:** `scripts/verify-first-names.ts` (new), `API.md`, `README.md`

- [ ] **Step 1: Write the script.** Read-only — it opens the live database and writes nothing.

Create `scripts/verify-first-names.ts`:

```ts
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
console.log(`
  ${'FULL NAME'.padEnd(46)} ${'STORED'.padEnd(24)} -> SANITISED`);
console.log(samples.join('
'));
if (!showAll && changed > samples.length) console.log(`  …and ${changed - samples.length} more (--all to see them)`);
```

- [ ] **Step 2: Run it.**

```bash
npx tsx scripts/verify-first-names.ts
```

Expected against the current 7,153-row roster: **404 changed, 4 null**. Eyeball the
sample — every change should be an improvement. If the null count is materially above ~10,
stop and investigate before running the backfill for real.

- [ ] **Step 3: Start the app and confirm the backfill ran.**

Ensure the app is not already running (`.linkedin-profile` is single-instance), then
`npm start` and check `data/relay.log` for `roster repaired first names repaired=…` and that
`data/app.db.pre-firstname-backup` exists. Stop with `Ctrl+C`, never by killing the window.

- [ ] **Step 4: Document.** In `API.md`, under the connections section, add a short
"Name resolution" note: the stored `first_name` is sanitised at write time and safe to use
directly; `full_name` is the verbatim display name. In `README.md`, one line under
Connections explaining that `{firstName}` uses the cleaned roster name and falls back to
`there`.

- [ ] **Step 5:** `npm test && npm run typecheck`, then commit.

---

## Done criteria

- [ ] `npm test` and `npm run typecheck` clean.
- [ ] `firstNameFrom` is the **only** place a greeting name is derived — `grep -rn "split(/\\\\s+/)\[0\]" src/` returns nothing name-related.
- [ ] `scripts/verify-first-names.ts` reports **399 changed, 8 null** on the live roster.
      *Revised during implementation.* The Task 1 code as written reports exactly **404 / 4**,
      confirming no drift — and then the roster audit (below) found twelve rows where that
      output is wrong. Fixing them is what moves the number. If you are re-deriving this,
      404/4 means "matches the original spec", 399/8 means "matches the spec plus the audit
      fixes"; anything else is drift.
- [ ] `data/app.db.pre-firstname-backup` exists after the first real start.
- [ ] Backfill is idempotent: a second start reports 0 repaired.
- [ ] `full_name` is byte-identical before and after the backfill.
- [ ] A message send to a roster member uses the roster name; an invite to a non-member still
      greets correctly from the live read.

## Implementation note — the roster audit (added 2026-07-31)

`scripts/audit-first-names.ts` was added on top of this plan. It splits the roster into the
rows `firstNameFrom` **changes** (risk: over-stripping) and the rows it **leaves alone**
(risk: a bad name that now looks blessed — `verify-first-names.ts` is blind to these by
construction), and optionally has Claude judge each row. Reviewing all 404 changed + 92
flagged-unchanged rows found **no false negatives** and **twelve wrong greetings**:

| Class | Rows | Example | Fix |
|---|---|---|---|
| Apostrophe stripped as a quote delimiter | 5 | `Ze'ev` → `"Ze"` | only strip an apostrophe not between two letters |
| `Ts.` (Malaysian technologist) unknown | 2 | `Ts. Muhammad Haris Jafri` → `"Ts"` | added to `HONORIFICS` |
| Lone token after initials is a surname | 4 | `M. K. Palmore` → `"Palmore"` | return null; two remaining tokens still yield the given name |
| Leading initialism lost to `POST_NOMINALS` | 1 | `J.D. Miller` → `"Miller"` | an initialism in first position outranks the suffix list |

Known residue, accepted: `"V Van Beek. 🛡"` → `"Van"` (Dutch surname particle after an
initial — no rule separates it from a given name safely).

## Deliberately out of scope

- **No AI dependency in the app.** Measured: only 12 rows use non-Latin scripts and 9 of those
  are bilingual with a clean Latin half; the deterministic residue is a handful of genuinely
  nameless rows where `"there"` is correct. Adding an API key, cost and nondeterminism to the
  send path is a bad trade for an app that has zero AI dependencies. The audit above is a
  bench tool under `scripts/`, is never imported by `src/`, and runs offline unless explicitly
  asked to call the API — the send path stays deterministic.
- **No change to `full_name`,** which stays the verbatim display name — search, the UI and
  the reply matcher all depend on it rendering as LinkedIn renders it.
- **Widening `ZERO_WIDTH` in `name-match.ts`.** It has the same bidi blind spot, so a name
  carrying U+200F will not canonicalise equal to the same name without it — a possible missed
  reply. Both sides of that comparison come from LinkedIn and usually agree, and changing what
  `canonicalName` strips alters which inbox rows match which contacts. Out of scope here;
  worth a separate look with its own tests.
- **Family-name-first ordering** (e.g. Japanese written surname-first) is not detected. Three
  Han-script rows exist and all happen to be given-name-first. No rule can distinguish them;
  accepted risk.
