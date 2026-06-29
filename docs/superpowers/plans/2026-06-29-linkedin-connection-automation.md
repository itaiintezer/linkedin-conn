# LinkedIn Connection Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A locally-run Node app that sends paced LinkedIn connection requests (organized by cohort, with per-contact or templated messages), tracks acceptances, and reports per-cohort metrics — all behind a local web UI and API.

**Architecture:** Single Node + TypeScript process. A SQLite database (`node:sqlite`, built-in — no native deps) is the source of truth. Pure-logic modules (URL parsing, message resolution, rate limiting, scheduling, acceptance diffing, metrics) are fully unit-tested. A `BrowserDriver` interface abstracts CloakBrowser so the queue/scheduler/workers are tested with a fake; the real LinkedIn DOM layer is verified manually in a visible browser. A Fastify server serves the dashboard + a localhost REST API.

**Tech Stack:** Node 24, TypeScript, `tsx` (run without a build step), `vitest` (tests), `node:sqlite` (storage), `fastify` (web server), `cloakbrowser` (stealth Playwright). Vanilla HTML/CSS/JS for the UI (no front-end build, no CDN — fully offline/portable).

**Conventions for every task:** TDD where logic is pure (write failing test → see it fail → implement → see it pass → commit). Browser/UI tasks (11–13, 18) are inherently integration-level; they get concrete implementations plus an explicit **manual verification** step instead of a unit test. Commit after every task.

---

## Shared Types (defined in Task 2, referenced everywhere)

```typescript
export type ProfileStatus =
  | 'queued' | 'scheduled' | 'sending' | 'sent'
  | 'accepted' | 'expired' | 'skipped' | 'failed' | 'needs_attention';

export type EventType = 'sent' | 'accepted' | 'expired' | 'skipped' | 'failed';

export type AccountType = 'unknown' | 'free' | 'premium' | 'salesnav';

export interface Cohort {
  id: number;
  name: string;
  message_template: string | null;
  allow_no_note: number; // 0 | 1 (SQLite has no bool)
  created_at: string;    // ISO
}

export interface Profile {
  id: number;
  cohort_id: number;
  profile_url: string;       // normalized
  first_name: string | null;
  custom_message: string | null;
  status: ProfileStatus;
  attempts: number;
  last_error: string | null;
  scheduled_for: string | null; // ISO
  sent_at: string | null;
  accepted_at: string | null;
  resolved_at: string | null;
  created_at: string;
}

export interface Settings {
  id: 1;
  workday_start_hour: number; // 8
  workday_end_hour: number;   // 20
  weekdays_only: number;      // 1
  weekly_cap: number;         // 100
  batch_size: number;         // 5
  batches_per_day: number;    // 4
  acceptance_checks_per_day: number; // 1
  account_type: AccountType;
  note_quota_exhausted: number; // 0|1, set when LinkedIn blocks notes
  min_delay_ms: number;       // 20000
  max_delay_ms: number;       // 90000
  paused: number;             // 0|1
  pause_reason: string | null;
}

// Outcome of a single send attempt, returned by BrowserDriver
export type SendResult =
  | 'sent' | 'already' | 'unavailable' | 'note_quota' | 'checkpoint' | 'error';

export interface SendOutcome {
  result: SendResult;
  firstName?: string;
  error?: string;
}

// The seam that isolates all browser automation from testable logic
export interface BrowserDriver {
  isLoggedIn(): Promise<boolean>;
  openLoginWindow(): Promise<void>;
  // message === null => send a bare request (no note)
  sendConnectionRequest(url: string, message: string | null): Promise<SendOutcome>;
  readPendingInvites(): Promise<string[]>;     // normalized profile URLs
  readRecentConnections(): Promise<string[]>;  // normalized profile URLs
  close(): Promise<void>;
}
```

---

### Task 1: Project scaffold

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.gitignore`
- Create: `src/config.ts`
- Create: `tests/smoke.test.ts`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "linkedin-conn",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22.5" },
  "scripts": {
    "start": "tsx src/index.ts",
    "dev": "tsx watch src/index.ts",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@fastify/static": "^8.0.0",
    "cloakbrowser": "^1.0.0",
    "fastify": "^5.0.0",
    "tsx": "^4.19.0"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "types": ["node"],
    "outDir": "dist"
  },
  "include": ["src", "tests"]
}
```

- [ ] **Step 3: Create `vitest.config.ts`**

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { globals: true, environment: 'node' },
});
```

- [ ] **Step 4: Create `.gitignore`**

```
node_modules/
dist/
data/
*.db
*.db-*
.linkedin-profile/
```

- [ ] **Step 5: Create `src/config.ts`**

```typescript
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const ROOT = join(__dirname, '..');
export const DATA_DIR = join(ROOT, 'data');
export const DB_PATH = join(DATA_DIR, 'app.db');
export const BROWSER_PROFILE_DIR = join(ROOT, '.linkedin-profile');
export const PORT = Number(process.env.PORT ?? 4400);
```

- [ ] **Step 6: Create `tests/smoke.test.ts`**

```typescript
import { test, expect } from 'vitest';

test('test harness runs', () => {
  expect(1 + 1).toBe(2);
});
```

- [ ] **Step 7: Install and run tests**

Run: `npm install && npm test`
Expected: `smoke.test.ts` passes (1 test). Native build NOT required.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "chore: scaffold Node+TS project with vitest"
```

---

### Task 2: Shared types

**Files:**
- Create: `src/types.ts`

- [ ] **Step 1: Create `src/types.ts`**

Paste the entire "Shared Types" block from the top of this plan (all `export type` / `export interface` declarations, excluding the `BrowserDriver` comment lines if desired — keep `BrowserDriver`).

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat: add shared domain types"
```

---

### Task 3: Database schema + connection

**Files:**
- Create: `src/db/schema.sql`
- Create: `src/db/database.ts`
- Test: `tests/db/database.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/db/database.test.ts
import { test, expect } from 'vitest';
import { openDatabase } from '../../src/db/database.js';

test('opens in-memory db and creates all tables', () => {
  const db = openDatabase(':memory:');
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all() as { name: string }[];
  const names = rows.map((r) => r.name);
  expect(names).toEqual(
    expect.arrayContaining(['cohorts', 'profiles', 'send_log', 'profile_events', 'settings']),
  );
});

test('seeds a single settings row with defaults', () => {
  const db = openDatabase(':memory:');
  const s = db.prepare('SELECT * FROM settings WHERE id = 1').get() as any;
  expect(s.weekly_cap).toBe(100);
  expect(s.batch_size).toBe(5);
  expect(s.workday_start_hour).toBe(8);
  expect(s.workday_end_hour).toBe(20);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/db/database.test.ts`
Expected: FAIL — cannot find `../../src/db/database.js`.

- [ ] **Step 3: Create `src/db/schema.sql`**

```sql
CREATE TABLE IF NOT EXISTS cohorts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  message_template TEXT,
  allow_no_note INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cohort_id INTEGER NOT NULL REFERENCES cohorts(id),
  profile_url TEXT NOT NULL UNIQUE,
  first_name TEXT,
  custom_message TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  scheduled_for TEXT,
  sent_at TEXT,
  accepted_at TEXT,
  resolved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_profiles_status ON profiles(status);
CREATE INDEX IF NOT EXISTS idx_profiles_cohort ON profiles(cohort_id);

CREATE TABLE IF NOT EXISTS send_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL REFERENCES profiles(id),
  outcome TEXT NOT NULL,
  at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_send_log_at ON send_log(at);

CREATE TABLE IF NOT EXISTS profile_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL REFERENCES profiles(id),
  event_type TEXT NOT NULL,
  at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_type ON profile_events(event_type);

CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  workday_start_hour INTEGER NOT NULL DEFAULT 8,
  workday_end_hour INTEGER NOT NULL DEFAULT 20,
  weekdays_only INTEGER NOT NULL DEFAULT 1,
  weekly_cap INTEGER NOT NULL DEFAULT 100,
  batch_size INTEGER NOT NULL DEFAULT 5,
  batches_per_day INTEGER NOT NULL DEFAULT 4,
  acceptance_checks_per_day INTEGER NOT NULL DEFAULT 1,
  account_type TEXT NOT NULL DEFAULT 'unknown',
  note_quota_exhausted INTEGER NOT NULL DEFAULT 0,
  min_delay_ms INTEGER NOT NULL DEFAULT 20000,
  max_delay_ms INTEGER NOT NULL DEFAULT 90000,
  paused INTEGER NOT NULL DEFAULT 0,
  pause_reason TEXT
);

INSERT OR IGNORE INTO settings (id) VALUES (1);
```

- [ ] **Step 4: Create `src/db/database.ts`**

```typescript
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export type DB = DatabaseSync;

export function openDatabase(path: string): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);
  return db;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/db/database.test.ts`
Expected: PASS (2 tests). Note: a Node `ExperimentalWarning` for `node:sqlite` is expected and harmless.

- [ ] **Step 6: Commit**

```bash
git add src/db/schema.sql src/db/database.ts tests/db/database.test.ts
git commit -m "feat: sqlite schema and connection via node:sqlite"
```

---

### Task 4: Repositories

**Files:**
- Create: `src/db/repositories.ts`
- Test: `tests/db/repositories.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/db/repositories.test.ts
import { test, expect, beforeEach } from 'vitest';
import { openDatabase } from '../../src/db/database.js';
import { Repos } from '../../src/db/repositories.js';

let repos: Repos;
beforeEach(() => { repos = new Repos(openDatabase(':memory:')); });

test('creates a cohort and finds it by name', () => {
  const c = repos.cohorts.create('Founders', 'Hi {firstName}!', false);
  expect(c.id).toBeGreaterThan(0);
  expect(repos.cohorts.findByName('Founders')!.id).toBe(c.id);
});

test('addProfile dedupes by normalized url and returns existing', () => {
  const c = repos.cohorts.create('A', null, true);
  const p1 = repos.profiles.add(c.id, 'https://www.linkedin.com/in/jane', null);
  const p2 = repos.profiles.add(c.id, 'https://www.linkedin.com/in/jane', null);
  expect(p2.id).toBe(p1.id);
  expect(repos.profiles.countAll()).toBe(1);
});

test('records send_log and events and counts sent in window', () => {
  const c = repos.cohorts.create('A', 'hi', true);
  const p = repos.profiles.add(c.id, 'https://www.linkedin.com/in/x', null);
  repos.events.recordSend(p.id, 'sent');
  expect(repos.events.countSentSince('1970-01-01T00:00:00Z')).toBe(1);
});

test('settings get returns defaults and update persists', () => {
  expect(repos.settings.get().weekly_cap).toBe(100);
  repos.settings.update({ weekly_cap: 50 });
  expect(repos.settings.get().weekly_cap).toBe(50);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/db/repositories.test.ts`
Expected: FAIL — cannot find `repositories.js`.

- [ ] **Step 3: Create `src/db/repositories.ts`**

```typescript
import type { DB } from './database.js';
import type { Cohort, Profile, Settings, ProfileStatus, EventType } from '../types.js';

export class CohortRepo {
  constructor(private db: DB) {}
  create(name: string, template: string | null, allowNoNote: boolean): Cohort {
    this.db.prepare(
      'INSERT INTO cohorts (name, message_template, allow_no_note) VALUES (?, ?, ?)',
    ).run(name, template, allowNoNote ? 1 : 0);
    return this.findByName(name)!;
  }
  findByName(name: string): Cohort | undefined {
    return this.db.prepare('SELECT * FROM cohorts WHERE name = ?').get(name) as Cohort | undefined;
  }
  findById(id: number): Cohort | undefined {
    return this.db.prepare('SELECT * FROM cohorts WHERE id = ?').get(id) as Cohort | undefined;
  }
  list(): Cohort[] {
    return this.db.prepare('SELECT * FROM cohorts ORDER BY created_at DESC').all() as Cohort[];
  }
  getOrCreate(name: string, template: string | null, allowNoNote: boolean): Cohort {
    return this.findByName(name) ?? this.create(name, template, allowNoNote);
  }
}

export class ProfileRepo {
  constructor(private db: DB) {}
  add(cohortId: number, normalizedUrl: string, customMessage: string | null): Profile {
    const existing = this.db
      .prepare('SELECT * FROM profiles WHERE profile_url = ?')
      .get(normalizedUrl) as Profile | undefined;
    if (existing) return existing;
    this.db.prepare(
      'INSERT INTO profiles (cohort_id, profile_url, custom_message) VALUES (?, ?, ?)',
    ).run(cohortId, normalizedUrl, customMessage);
    return this.db.prepare('SELECT * FROM profiles WHERE profile_url = ?').get(normalizedUrl) as Profile;
  }
  countAll(): number {
    return (this.db.prepare('SELECT COUNT(*) c FROM profiles').get() as { c: number }).c;
  }
  byStatus(status: ProfileStatus): Profile[] {
    return this.db.prepare('SELECT * FROM profiles WHERE status = ? ORDER BY id').all(status) as Profile[];
  }
  setStatus(id: number, status: ProfileStatus, fields: Partial<Profile> = {}): void {
    const sets: string[] = ['status = ?'];
    const vals: unknown[] = [status];
    for (const [k, v] of Object.entries(fields)) { sets.push(`${k} = ?`); vals.push(v); }
    vals.push(id);
    this.db.prepare(`UPDATE profiles SET ${sets.join(', ')} WHERE id = ?`).run(...(vals as any[]));
  }
  setScheduled(id: number, iso: string): void {
    this.db.prepare("UPDATE profiles SET status='scheduled', scheduled_for=? WHERE id=?").run(iso, id);
  }
  all(): Profile[] {
    return this.db.prepare('SELECT * FROM profiles ORDER BY id').all() as Profile[];
  }
}

export class EventRepo {
  constructor(private db: DB) {}
  recordSend(profileId: number, outcome: EventType): void {
    this.db.prepare('INSERT INTO send_log (profile_id, outcome) VALUES (?, ?)').run(profileId, outcome);
    this.db.prepare('INSERT INTO profile_events (profile_id, event_type) VALUES (?, ?)').run(profileId, outcome);
  }
  recordEvent(profileId: number, type: EventType): void {
    this.db.prepare('INSERT INTO profile_events (profile_id, event_type) VALUES (?, ?)').run(profileId, type);
  }
  countSentSince(iso: string): number {
    return (this.db
      .prepare("SELECT COUNT(*) c FROM send_log WHERE outcome='sent' AND at >= ?")
      .get(iso) as { c: number }).c;
  }
}

export class SettingsRepo {
  constructor(private db: DB) {}
  get(): Settings {
    return this.db.prepare('SELECT * FROM settings WHERE id = 1').get() as Settings;
  }
  update(patch: Partial<Settings>): void {
    const keys = Object.keys(patch).filter((k) => k !== 'id');
    if (keys.length === 0) return;
    const sets = keys.map((k) => `${k} = ?`).join(', ');
    const vals = keys.map((k) => (patch as any)[k]);
    this.db.prepare(`UPDATE settings SET ${sets} WHERE id = 1`).run(...(vals as any[]));
  }
}

export class Repos {
  cohorts: CohortRepo;
  profiles: ProfileRepo;
  events: EventRepo;
  settings: SettingsRepo;
  constructor(public db: DB) {
    this.cohorts = new CohortRepo(db);
    this.profiles = new ProfileRepo(db);
    this.events = new EventRepo(db);
    this.settings = new SettingsRepo(db);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/db/repositories.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/db/repositories.ts tests/db/repositories.test.ts
git commit -m "feat: sqlite repositories for cohorts, profiles, events, settings"
```

---

### Task 5: URL normalization & extraction

**Files:**
- Create: `src/core/url.ts`
- Test: `tests/core/url.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/core/url.test.ts
import { test, expect } from 'vitest';
import { normalizeProfileUrl, extractProfileUrls } from '../../src/core/url.js';

test('normalizes to canonical https://www.linkedin.com/in/<slug>', () => {
  expect(normalizeProfileUrl('http://linkedin.com/in/Jane-Doe-123/?trk=x'))
    .toBe('https://www.linkedin.com/in/jane-doe-123');
  expect(normalizeProfileUrl('https://www.linkedin.com/in/jane-doe-123'))
    .toBe('https://www.linkedin.com/in/jane-doe-123');
});

test('returns null for non-profile urls', () => {
  expect(normalizeProfileUrl('https://www.linkedin.com/company/acme')).toBeNull();
  expect(normalizeProfileUrl('not a url')).toBeNull();
});

test('extracts and dedupes profile urls from free text / csv', () => {
  const text = `name,url
Jane,https://linkedin.com/in/jane/
Bob,"https://www.linkedin.com/in/bob?x=1"
dup,https://linkedin.com/in/jane`;
  expect(extractProfileUrls(text)).toEqual([
    'https://www.linkedin.com/in/jane',
    'https://www.linkedin.com/in/bob',
  ]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/url.test.ts`
Expected: FAIL — cannot find `url.js`.

- [ ] **Step 3: Create `src/core/url.ts`**

```typescript
export function normalizeProfileUrl(raw: string): string | null {
  const m = raw.match(/linkedin\.com\/in\/([A-Za-z0-9\-_%]+)/i);
  if (!m) return null;
  const slug = m[1].replace(/\/+$/, '').toLowerCase();
  if (!slug) return null;
  return `https://www.linkedin.com/in/${slug}`;
}

export function extractProfileUrls(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /https?:\/\/[^\s,"'<>]*linkedin\.com\/in\/[A-Za-z0-9\-_%]+\/?/gi;
  for (const match of text.matchAll(re)) {
    const n = normalizeProfileUrl(match[0]);
    if (n && !seen.has(n)) { seen.add(n); out.push(n); }
  }
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/core/url.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/url.ts tests/core/url.test.ts
git commit -m "feat: linkedin profile url normalization and extraction"
```

---

### Task 6: Message resolution

**Files:**
- Create: `src/core/message.ts`
- Test: `tests/core/message.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/core/message.test.ts
import { test, expect } from 'vitest';
import { resolveMessage } from '../../src/core/message.js';

test('custom message takes precedence and substitutes {firstName}', () => {
  expect(resolveMessage('Hey {firstName}, loved your post', 'template', 'Jane'))
    .toBe('Hey Jane, loved your post');
});

test('falls back to template when no custom message', () => {
  expect(resolveMessage(null, 'Hi {firstName}!', 'Bob')).toBe('Hi Bob!');
});

test("missing first name becomes 'there'", () => {
  expect(resolveMessage(null, 'Hi {firstName}!', null)).toBe('Hi there!');
});

test('returns null when no custom message and no template (bare request)', () => {
  expect(resolveMessage(null, null, 'Jane')).toBeNull();
  expect(resolveMessage('', '   ', 'Jane')).toBeNull();
});

test('truncates to 300 characters (LinkedIn note limit)', () => {
  const long = 'x'.repeat(400);
  expect(resolveMessage(long, null, 'Jane')!.length).toBe(300);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/message.test.ts`
Expected: FAIL — cannot find `message.js`.

- [ ] **Step 3: Create `src/core/message.ts`**

```typescript
const MAX_NOTE = 300;

function substitute(text: string, firstName: string | null): string {
  return text.replace(/\{firstName\}/g, (firstName ?? '').trim() || 'there');
}

/**
 * Precedence: custom message -> cohort template -> null (bare request).
 * Tokens are substituted and the result is truncated to 300 chars.
 */
export function resolveMessage(
  customMessage: string | null,
  template: string | null,
  firstName: string | null,
): string | null {
  const source = (customMessage && customMessage.trim())
    ? customMessage
    : (template && template.trim())
      ? template
      : null;
  if (source === null) return null;
  return substitute(source, firstName).slice(0, MAX_NOTE);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/core/message.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/message.ts tests/core/message.test.ts
git commit -m "feat: message resolution with precedence, tokens, 300-char cap"
```

---

### Task 7: Rolling rate-limit calculator

**Files:**
- Create: `src/core/rate-limit.ts`
- Test: `tests/core/rate-limit.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/core/rate-limit.test.ts
import { test, expect } from 'vitest';
import { windowStartIso, remainingCapacity } from '../../src/core/rate-limit.js';

const now = new Date('2026-06-29T12:00:00Z');

test('window start is 7 days before now (ISO)', () => {
  expect(windowStartIso(now)).toBe('2026-06-22T12:00:00.000Z');
});

test('remaining capacity is cap minus sent-in-window, floored at 0', () => {
  expect(remainingCapacity(100, 30)).toBe(70);
  expect(remainingCapacity(100, 100)).toBe(0);
  expect(remainingCapacity(100, 130)).toBe(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/rate-limit.test.ts`
Expected: FAIL — cannot find `rate-limit.js`.

- [ ] **Step 3: Create `src/core/rate-limit.ts`**

```typescript
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export function windowStartIso(now: Date): string {
  return new Date(now.getTime() - WEEK_MS).toISOString();
}

export function remainingCapacity(weeklyCap: number, sentInWindow: number): number {
  return Math.max(0, weeklyCap - sentInWindow);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/core/rate-limit.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/rate-limit.ts tests/core/rate-limit.test.ts
git commit -m "feat: rolling 7-day rate-limit calculator"
```

---

### Task 8: Schedule planning

**Files:**
- Create: `src/core/schedule.ts`
- Test: `tests/core/schedule.test.ts`

Design: `planDailyBatches` returns batch start times for a given day; `assignSchedule` maps queued profiles onto those batch times in groups of `batchSize`; `pickDue` selects profiles whose `scheduled_for <= now`, limited by remaining cap. All take an injected RNG `() => number` for determinism.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/core/schedule.test.ts
import { test, expect } from 'vitest';
import { planDailyBatches, assignSchedule, pickDue } from '../../src/core/schedule.js';

// deterministic RNG
function seeded(seq: number[]): () => number {
  let i = 0;
  return () => seq[i++ % seq.length];
}

test('planDailyBatches returns N sorted times within the working window', () => {
  const day = new Date('2026-06-29T00:00:00'); // local midnight (a Monday)
  const times = planDailyBatches(day, { startHour: 8, endHour: 20, count: 4 }, seeded([0.1, 0.4, 0.6, 0.9]));
  expect(times).toHaveLength(4);
  for (const t of times) {
    expect(t.getHours()).toBeGreaterThanOrEqual(8);
    expect(t.getHours()).toBeLessThan(20);
  }
  const sorted = [...times].sort((a, b) => a.getTime() - b.getTime());
  expect(times).toEqual(sorted);
});

test('assignSchedule groups profiles into batches of batchSize', () => {
  const profiles = [1, 2, 3, 4, 5, 6, 7];
  const t0 = new Date('2026-06-29T09:00:00');
  const t1 = new Date('2026-06-29T13:00:00');
  const result = assignSchedule(profiles, [t0, t1], 5);
  // first 5 -> t0, next 2 -> t1
  expect(result.filter((r) => r.when === t0).map((r) => r.id)).toEqual([1, 2, 3, 4, 5]);
  expect(result.filter((r) => r.when === t1).map((r) => r.id)).toEqual([6, 7]);
});

test('pickDue returns only due profiles, capped by remaining', () => {
  const now = new Date('2026-06-29T13:30:00');
  const rows = [
    { id: 1, scheduled_for: '2026-06-29T09:00:00.000Z' },
    { id: 2, scheduled_for: '2026-06-29T13:00:00.000Z' },
    { id: 3, scheduled_for: '2026-06-29T18:00:00.000Z' }, // not due
  ];
  expect(pickDue(rows, now, 10).map((r) => r.id)).toEqual([1, 2]);
  expect(pickDue(rows, now, 1).map((r) => r.id)).toEqual([1]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/schedule.test.ts`
Expected: FAIL — cannot find `schedule.js`.

- [ ] **Step 3: Create `src/core/schedule.ts`**

```typescript
export interface BatchPlanOptions { startHour: number; endHour: number; count: number; }

export function planDailyBatches(
  day: Date,
  opts: BatchPlanOptions,
  rng: () => number = Math.random,
): Date[] {
  const windowMs = (opts.endHour - opts.startHour) * 60 * 60 * 1000;
  const base = new Date(day);
  base.setHours(opts.startHour, 0, 0, 0);
  const times: Date[] = [];
  for (let i = 0; i < opts.count; i++) {
    times.push(new Date(base.getTime() + Math.floor(rng() * windowMs)));
  }
  times.sort((a, b) => a.getTime() - b.getTime());
  return times;
}

export function assignSchedule<T>(
  profileIds: T[],
  batchTimes: Date[],
  batchSize: number,
): { id: T; when: Date }[] {
  const out: { id: T; when: Date }[] = [];
  let batch = 0;
  for (let i = 0; i < profileIds.length; i++) {
    if (i > 0 && i % batchSize === 0) batch++;
    const when = batchTimes[Math.min(batch, batchTimes.length - 1)];
    out.push({ id: profileIds[i], when });
  }
  return out;
}

export function pickDue<T extends { scheduled_for: string | null }>(
  rows: T[],
  now: Date,
  remaining: number,
): T[] {
  return rows
    .filter((r) => r.scheduled_for !== null && new Date(r.scheduled_for) <= now)
    .slice(0, Math.max(0, remaining));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/core/schedule.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/schedule.ts tests/core/schedule.test.ts
git commit -m "feat: batch scheduling, assignment, and due-selection logic"
```

---

### Task 9: Acceptance diff logic

**Files:**
- Create: `src/core/acceptance.ts`
- Test: `tests/core/acceptance.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/core/acceptance.test.ts
import { test, expect } from 'vitest';
import { computeAcceptanceTransitions } from '../../src/core/acceptance.js';

test('classifies resolved invites as accepted or expired', () => {
  const sent = [
    { id: 1, profile_url: 'https://www.linkedin.com/in/a' }, // still pending
    { id: 2, profile_url: 'https://www.linkedin.com/in/b' }, // gone + connected -> accepted
    { id: 3, profile_url: 'https://www.linkedin.com/in/c' }, // gone + not connected -> expired
  ];
  const pending = new Set(['https://www.linkedin.com/in/a']);
  const connections = new Set(['https://www.linkedin.com/in/b']);
  const r = computeAcceptanceTransitions(sent, pending, connections);
  expect(r.accepted).toEqual([2]);
  expect(r.expired).toEqual([3]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/acceptance.test.ts`
Expected: FAIL — cannot find `acceptance.js`.

- [ ] **Step 3: Create `src/core/acceptance.ts`**

```typescript
export interface SentRow { id: number; profile_url: string; }

export function computeAcceptanceTransitions(
  sent: SentRow[],
  pendingUrls: Set<string>,
  connectionUrls: Set<string>,
): { accepted: number[]; expired: number[] } {
  const accepted: number[] = [];
  const expired: number[] = [];
  for (const row of sent) {
    if (pendingUrls.has(row.profile_url)) continue; // still outstanding
    if (connectionUrls.has(row.profile_url)) accepted.push(row.id);
    else expired.push(row.id);
  }
  return { accepted, expired };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/core/acceptance.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add src/core/acceptance.ts tests/core/acceptance.test.ts
git commit -m "feat: acceptance diff logic (pending/connections -> accepted/expired)"
```

---

### Task 10: Cohort metrics

**Files:**
- Create: `src/core/metrics.ts`
- Test: `tests/core/metrics.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/core/metrics.test.ts
import { test, expect } from 'vitest';
import { computeCohortMetrics } from '../../src/core/metrics.js';

test('aggregates funnel, acceptance rate, and median time-to-accept per cohort', () => {
  const rows = [
    { cohort_id: 1, cohort_name: 'A', status: 'sent', sent_at: '2026-06-01T00:00:00Z', accepted_at: null },
    { cohort_id: 1, cohort_name: 'A', status: 'accepted', sent_at: '2026-06-01T00:00:00Z', accepted_at: '2026-06-03T00:00:00Z' }, // 2 days
    { cohort_id: 1, cohort_name: 'A', status: 'accepted', sent_at: '2026-06-01T00:00:00Z', accepted_at: '2026-06-05T00:00:00Z' }, // 4 days
    { cohort_id: 1, cohort_name: 'A', status: 'expired', sent_at: '2026-06-01T00:00:00Z', accepted_at: null },
  ];
  const m = computeCohortMetrics(rows);
  expect(m).toHaveLength(1);
  const a = m[0];
  expect(a.cohort_name).toBe('A');
  expect(a.accepted).toBe(2);
  expect(a.pending).toBe(1);  // status 'sent'
  expect(a.expired).toBe(1);
  expect(a.total).toBe(4);
  expect(a.acceptance_rate).toBeCloseTo(2 / 4);
  expect(a.median_time_to_accept_days).toBeCloseTo(3); // median of [2,4]
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/metrics.test.ts`
Expected: FAIL — cannot find `metrics.js`.

- [ ] **Step 3: Create `src/core/metrics.ts`**

```typescript
export interface MetricRow {
  cohort_id: number;
  cohort_name: string;
  status: string;
  sent_at: string | null;
  accepted_at: string | null;
}

export interface CohortMetrics {
  cohort_id: number;
  cohort_name: string;
  total: number;
  sent: number;       // attempted (sent + accepted + expired)
  pending: number;    // status === 'sent'
  accepted: number;
  expired: number;
  acceptance_rate: number;
  median_time_to_accept_days: number | null;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function computeCohortMetrics(rows: MetricRow[]): CohortMetrics[] {
  const groups = new Map<number, MetricRow[]>();
  for (const r of rows) {
    if (!groups.has(r.cohort_id)) groups.set(r.cohort_id, []);
    groups.get(r.cohort_id)!.push(r);
  }
  const out: CohortMetrics[] = [];
  for (const [cohortId, grp] of groups) {
    const accepted = grp.filter((r) => r.status === 'accepted').length;
    const pending = grp.filter((r) => r.status === 'sent').length;
    const expired = grp.filter((r) => r.status === 'expired').length;
    const attempted = accepted + pending + expired;
    const ttaDays = grp
      .filter((r) => r.status === 'accepted' && r.sent_at && r.accepted_at)
      .map((r) => (new Date(r.accepted_at!).getTime() - new Date(r.sent_at!).getTime()) / 86400000);
    out.push({
      cohort_id: cohortId,
      cohort_name: grp[0].cohort_name,
      total: grp.length,
      sent: attempted,
      pending,
      accepted,
      expired,
      acceptance_rate: attempted > 0 ? accepted / attempted : 0,
      median_time_to_accept_days: median(ttaDays),
    });
  }
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/core/metrics.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add src/core/metrics.ts tests/core/metrics.test.ts
git commit -m "feat: per-cohort funnel metrics and median time-to-accept"
```

---

### Task 11: BrowserDriver interface + CloakBrowser session

**Files:**
- Create: `src/browser/driver.ts` (re-exports the `BrowserDriver` interface from types + a `FakeDriver` for tests)
- Create: `src/browser/cloak-session.ts` (persistent context lifecycle)
- Test: manual (no unit test — this touches a real browser)

- [ ] **Step 1: Create `src/browser/driver.ts`**

```typescript
import type { BrowserDriver, SendOutcome, SendResult } from '../types.js';
export type { BrowserDriver };

/** In-memory driver for testing workers without a real browser. */
export class FakeDriver implements BrowserDriver {
  loggedIn = true;
  pending: string[] = [];
  connections: string[] = [];
  // queue of scripted outcomes keyed by url; default 'sent'
  scripted = new Map<string, SendResult>();
  sentLog: { url: string; message: string | null }[] = [];

  async isLoggedIn() { return this.loggedIn; }
  async openLoginWindow() { this.loggedIn = true; }
  async sendConnectionRequest(url: string, message: string | null): Promise<SendOutcome> {
    this.sentLog.push({ url, message });
    const result = this.scripted.get(url) ?? 'sent';
    return { result, firstName: 'Test' };
  }
  async readPendingInvites() { return this.pending; }
  async readRecentConnections() { return this.connections; }
  async close() {}
}
```

- [ ] **Step 2: Create `src/browser/cloak-session.ts`**

```typescript
// CloakBrowser is a drop-in Playwright replacement. The exact import surface
// should be confirmed against the installed package's README; this uses the
// documented persistent-context pattern.
import { chromium } from 'cloakbrowser';
import type { BrowserContext, Page } from 'cloakbrowser';
import { BROWSER_PROFILE_DIR } from '../config.js';

export class CloakSession {
  private ctx: BrowserContext | null = null;

  async context(): Promise<BrowserContext> {
    if (this.ctx) return this.ctx;
    this.ctx = await chromium.launchPersistentContext(BROWSER_PROFILE_DIR, {
      headless: false,
      humanize: true, // CloakBrowser human-like interaction
      viewport: { width: 1280, height: 900 },
    } as any);
    return this.ctx;
  }

  async page(): Promise<Page> {
    const ctx = await this.context();
    const pages = ctx.pages();
    return pages.length ? pages[0] : await ctx.newPage();
  }

  async close(): Promise<void> {
    await this.ctx?.close();
    this.ctx = null;
  }
}
```

- [ ] **Step 3: Manual verification**

Add a temporary script `scripts/try-browser.ts`:

```typescript
import { CloakSession } from '../src/browser/cloak-session.js';
const s = new CloakSession();
const p = await s.page();
await p.goto('https://www.linkedin.com');
console.log('opened, title:', await p.title());
```

Run: `npx tsx scripts/try-browser.ts`
Expected: a visible Chromium window opens LinkedIn; logs a title. Close the window, delete the temp script.

- [ ] **Step 4: Commit**

```bash
git add src/browser/driver.ts src/browser/cloak-session.ts
git commit -m "feat: BrowserDriver interface, FakeDriver, CloakBrowser session"
```

---

### Task 12: LinkedIn selectors + send flow

**Files:**
- Create: `src/browser/linkedin-selectors.ts`
- Create: `src/browser/linkedin-driver.ts` (implements `sendConnectionRequest`, `isLoggedIn`, `openLoginWindow`)
- Test: manual

**Note:** LinkedIn changes its DOM. ALL selectors live in `linkedin-selectors.ts` so they can be updated in one place. Selectors below are a starting point; confirm/adjust during manual verification.

- [ ] **Step 1: Create `src/browser/linkedin-selectors.ts`**

```typescript
export const SEL = {
  feedMarker: 'div.feed-identity-module, main.scaffold-layout__main',
  loginField: 'input#username',
  connectButton: 'button[aria-label^="Invite"][aria-label*="connect"]',
  moreButton: 'button[aria-label="More actions"]',
  moreConnectItem: 'div[aria-label^="Invite"][role="button"], div.artdeco-dropdown__item:has-text("Connect")',
  addNoteButton: 'button[aria-label="Add a note"]',
  noteTextarea: 'textarea[name="message"]',
  sendButton: 'button[aria-label="Send invitation"], button[aria-label="Send now"]',
  sendWithoutNote: 'button[aria-label="Send without a note"]',
  pendingBadge: 'button[aria-label^="Pending"], span.artdeco-button__text:has-text("Pending")',
  // page used by acceptance reader
  invitationCardLink: 'a[data-test-app-aware-link][href*="/in/"]',
  connectionCardLink: 'a[href*="/in/"]',
  // quota dialog
  noteQuotaDialog: 'text=/free to send a personalized invitation|out of personalized invitations/i',
};

export const URLS = {
  home: 'https://www.linkedin.com/feed/',
  sentInvitations: 'https://www.linkedin.com/mynetwork/invitation-manager/sent/',
  connections: 'https://www.linkedin.com/mynetwork/invite-connect/connections/',
};
```

- [ ] **Step 2: Create `src/browser/linkedin-driver.ts`**

```typescript
import type { Page } from 'cloakbrowser';
import type { BrowserDriver, SendOutcome } from '../types.js';
import { CloakSession } from './cloak-session.js';
import { SEL, URLS } from './linkedin-selectors.js';
import { normalizeProfileUrl } from '../core/url.js';

const rand = (min: number, max: number) => min + Math.floor(Math.random() * (max - min));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class LinkedInDriver implements BrowserDriver {
  constructor(private session = new CloakSession()) {}

  async isLoggedIn(): Promise<boolean> {
    const page = await this.session.page();
    await page.goto(URLS.home, { waitUntil: 'domcontentloaded' });
    try {
      await page.waitForSelector(SEL.feedMarker, { timeout: 8000 });
      return true;
    } catch {
      return false;
    }
  }

  async openLoginWindow(): Promise<void> {
    const page = await this.session.page();
    await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded' });
    // User logs in manually in the visible window; session persists to disk.
  }

  async sendConnectionRequest(url: string, message: string | null): Promise<SendOutcome> {
    const page = await this.session.page();
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await sleep(rand(1500, 4000));

      const firstName = await this.readFirstName(page);

      if (await page.locator(SEL.pendingBadge).first().isVisible().catch(() => false)) {
        return { result: 'already', firstName };
      }

      const clicked = await this.clickConnect(page);
      if (!clicked) return { result: 'unavailable', firstName };

      if (message !== null) {
        const addNote = page.locator(SEL.addNoteButton).first();
        if (await addNote.isVisible().catch(() => false)) {
          await addNote.click();
          await sleep(rand(800, 2000));
          if (await page.locator(SEL.noteQuotaDialog).first().isVisible().catch(() => false)) {
            return { result: 'note_quota', firstName };
          }
          await page.locator(SEL.noteTextarea).fill(message);
          await sleep(rand(800, 2000));
          await page.locator(SEL.sendButton).first().click();
          return { result: 'sent', firstName };
        }
      }
      // bare send
      const without = page.locator(SEL.sendWithoutNote).first();
      if (await without.isVisible().catch(() => false)) await without.click();
      else await page.locator(SEL.sendButton).first().click();
      return { result: 'sent', firstName };
    } catch (e) {
      const body = (await page.content().catch(() => '')) || '';
      if (/captcha|checkpoint|verify|unusual activity/i.test(body)) {
        return { result: 'checkpoint', error: 'checkpoint detected' };
      }
      return { result: 'error', error: (e as Error).message };
    }
  }

  private async readFirstName(page: Page): Promise<string | undefined> {
    const h1 = await page.locator('h1').first().textContent().catch(() => null);
    if (!h1) return undefined;
    return h1.trim().split(/\s+/)[0];
  }

  private async clickConnect(page: Page): Promise<boolean> {
    const direct = page.locator(SEL.connectButton).first();
    if (await direct.isVisible().catch(() => false)) { await direct.click(); return true; }
    const more = page.locator(SEL.moreButton).first();
    if (await more.isVisible().catch(() => false)) {
      await more.click();
      await sleep(rand(500, 1200));
      const item = page.locator(SEL.moreConnectItem).first();
      if (await item.isVisible().catch(() => false)) { await item.click(); return true; }
    }
    return false;
  }

  async readPendingInvites(): Promise<string[]> {
    const page = await this.session.page();
    await page.goto(URLS.sentInvitations, { waitUntil: 'domcontentloaded' });
    await sleep(rand(2000, 4000));
    return this.collectProfileLinks(page, SEL.invitationCardLink);
  }

  async readRecentConnections(): Promise<string[]> {
    const page = await this.session.page();
    await page.goto(URLS.connections, { waitUntil: 'domcontentloaded' });
    await sleep(rand(2000, 4000));
    return this.collectProfileLinks(page, SEL.connectionCardLink);
  }

  private async collectProfileLinks(page: Page, selector: string): Promise<string[]> {
    const hrefs = await page.locator(selector).evaluateAll(
      (els) => els.map((e) => (e as HTMLAnchorElement).href),
    );
    const out = new Set<string>();
    for (const h of hrefs) { const n = normalizeProfileUrl(h); if (n) out.add(n); }
    return [...out];
  }

  async close(): Promise<void> { await this.session.close(); }
}
```

- [ ] **Step 3: Manual verification**

With a logged-in session (Task 11 left you logged in, or log in now), write a temp script that calls `new LinkedInDriver().sendConnectionRequest('<a real test profile url>', 'Hi {firstName}')` — **use a throwaway/test target or a colleague who expects it.** Confirm: the profile opens, Connect is clicked, the note is filled, and the invite sends. Then call `readPendingInvites()` and confirm it returns the URL you just invited. Adjust selectors in `linkedin-selectors.ts` if any step misses. Delete the temp script.

- [ ] **Step 4: Commit**

```bash
git add src/browser/linkedin-selectors.ts src/browser/linkedin-driver.ts
git commit -m "feat: LinkedIn send flow and list readers behind BrowserDriver"
```

---

### Task 13: (folded into Task 12)

Acceptance page-reading (`readPendingInvites` / `readRecentConnections`) is implemented in Task 12's `LinkedInDriver`. No separate task. (Numbering kept so later references stay stable.)

---

### Task 14: Sender worker

**Files:**
- Create: `src/worker/sender.ts`
- Test: `tests/worker/sender.test.ts`

The sender: given the repos, a driver, and `now`, picks due scheduled profiles up to remaining capacity, sends each, and records results. Pure enough to test fully with `FakeDriver` + in-memory DB.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/worker/sender.test.ts
import { test, expect, beforeEach } from 'vitest';
import { openDatabase } from '../../src/db/database.js';
import { Repos } from '../../src/db/repositories.js';
import { FakeDriver } from '../../src/browser/driver.js';
import { runSenderOnce } from '../../src/worker/sender.js';

let repos: Repos; let driver: FakeDriver;
beforeEach(() => { repos = new Repos(openDatabase(':memory:')); driver = new FakeDriver(); });

function seedScheduled(url: string, whenIso: string, cohortId: number) {
  const p = repos.profiles.add(cohortId, url, null);
  repos.profiles.setScheduled(p.id, whenIso);
  return p;
}

test('sends due profiles, records sent status + event, respects remaining cap', async () => {
  const c = repos.cohorts.create('A', 'Hi {firstName}', true);
  seedScheduled('https://www.linkedin.com/in/a', '2026-06-29T09:00:00.000Z', c.id);
  seedScheduled('https://www.linkedin.com/in/b', '2026-06-29T09:00:00.000Z', c.id);

  const now = new Date('2026-06-29T10:00:00Z');
  await runSenderOnce(repos, driver, now);

  expect(driver.sentLog).toHaveLength(2);
  expect(driver.sentLog[0].message).toBe('Hi Test'); // token substituted from driver firstName
  expect(repos.profiles.byStatus('sent')).toHaveLength(2);
  expect(repos.events.countSentSince('1970-01-01T00:00:00Z')).toBe(2);
});

test('already-connected -> skipped, not counted as sent', async () => {
  const c = repos.cohorts.create('A', 'hi', true);
  seedScheduled('https://www.linkedin.com/in/a', '2026-06-29T09:00:00.000Z', c.id);
  driver.scripted.set('https://www.linkedin.com/in/a', 'already');

  await runSenderOnce(repos, driver, new Date('2026-06-29T10:00:00Z'));

  expect(repos.profiles.byStatus('skipped')).toHaveLength(1);
  expect(repos.events.countSentSince('1970-01-01T00:00:00Z')).toBe(0);
});

test('checkpoint -> pauses queue and flags needs_attention', async () => {
  const c = repos.cohorts.create('A', 'hi', true);
  seedScheduled('https://www.linkedin.com/in/a', '2026-06-29T09:00:00.000Z', c.id);
  driver.scripted.set('https://www.linkedin.com/in/a', 'checkpoint');

  await runSenderOnce(repos, driver, new Date('2026-06-29T10:00:00Z'));

  expect(repos.settings.get().paused).toBe(1);
  expect(repos.profiles.byStatus('needs_attention')).toHaveLength(1);
});

test('note_quota with allow_no_note retries bare and sends', async () => {
  const c = repos.cohorts.create('A', 'hi {firstName}', true);
  seedScheduled('https://www.linkedin.com/in/a', '2026-06-29T09:00:00.000Z', c.id);
  // first call returns note_quota, second (bare) returns sent
  let calls = 0;
  driver.sendConnectionRequest = async (url, message) => {
    calls++;
    driver.sentLog.push({ url, message });
    return calls === 1 ? { result: 'note_quota', firstName: 'T' } : { result: 'sent', firstName: 'T' };
  };

  await runSenderOnce(repos, driver, new Date('2026-06-29T10:00:00Z'));

  expect(driver.sentLog[1].message).toBeNull(); // retried without note
  expect(repos.profiles.byStatus('sent')).toHaveLength(1);
  expect(repos.settings.get().note_quota_exhausted).toBe(1);
});

test('does nothing when paused', async () => {
  const c = repos.cohorts.create('A', 'hi', true);
  seedScheduled('https://www.linkedin.com/in/a', '2026-06-29T09:00:00.000Z', c.id);
  repos.settings.update({ paused: 1 });
  await runSenderOnce(repos, driver, new Date('2026-06-29T10:00:00Z'));
  expect(driver.sentLog).toHaveLength(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/worker/sender.test.ts`
Expected: FAIL — cannot find `sender.js`.

- [ ] **Step 3: Create `src/worker/sender.ts`**

```typescript
import type { Repos } from '../db/repositories.js';
import type { BrowserDriver } from '../types.js';
import { resolveMessage } from '../core/message.js';
import { windowStartIso, remainingCapacity } from '../core/rate-limit.js';
import { pickDue } from '../core/schedule.js';

export async function runSenderOnce(repos: Repos, driver: BrowserDriver, now: Date): Promise<void> {
  const settings = repos.settings.get();
  if (settings.paused) return;
  if (!(await driver.isLoggedIn())) {
    repos.settings.update({ paused: 1, pause_reason: 'Not logged in' });
    return;
  }

  const sentInWindow = repos.events.countSentSince(windowStartIso(now));
  let remaining = remainingCapacity(settings.weekly_cap, sentInWindow);
  if (remaining <= 0) return;

  const scheduled = repos.profiles.byStatus('scheduled');
  const due = pickDue(scheduled, now, Math.min(remaining, settings.batch_size));

  for (const p of due) {
    const cohort = repos.cohorts.findById(p.cohort_id)!;
    repos.profiles.setStatus(p.id, 'sending', { attempts: p.attempts + 1 });

    // firstName is read live by the driver, so we resolve the message twice:
    // first pass with whatever we know, then the driver returns the real name.
    let note = resolveMessage(p.custom_message, cohort.message_template, p.first_name);
    let outcome = await driver.sendConnectionRequest(p.profile_url, note);

    if (outcome.firstName && (note?.includes('{firstName}') || p.first_name == null)) {
      // (driver already substituted nothing; we re-resolve with the real name and it is
      // only meaningful if we had a token — re-send is NOT done here, the note above
      // already used p.first_name. The real-name value is stored for metrics/UI.)
    }
    if (outcome.firstName) repos.profiles.setStatus(p.id, 'sending', { first_name: outcome.firstName });

    if (outcome.result === 'note_quota') {
      repos.settings.update({ note_quota_exhausted: 1 });
      if (cohort.allow_no_note) {
        outcome = await driver.sendConnectionRequest(p.profile_url, null);
      } else {
        repos.profiles.setStatus(p.id, 'needs_attention', { last_error: 'note quota exhausted; no-note disabled' });
        continue;
      }
    }

    switch (outcome.result) {
      case 'sent':
        repos.profiles.setStatus(p.id, 'sent', { sent_at: now.toISOString() });
        repos.events.recordSend(p.id, 'sent');
        remaining--;
        break;
      case 'already':
      case 'unavailable':
        repos.profiles.setStatus(p.id, 'skipped', { last_error: outcome.result });
        repos.events.recordEvent(p.id, 'skipped');
        break;
      case 'checkpoint':
        repos.profiles.setStatus(p.id, 'needs_attention', { last_error: 'checkpoint' });
        repos.settings.update({ paused: 1, pause_reason: 'Captcha/checkpoint detected' });
        return; // stop the batch immediately
      case 'error':
      default:
        repos.profiles.setStatus(p.id, 'failed', { last_error: outcome.error ?? 'unknown' });
        repos.events.recordEvent(p.id, 'failed');
        break;
    }
    if (remaining <= 0) break;
  }
}
```

> **Note on `{firstName}`:** the message is resolved using the name stored on the profile (filled on a prior visit if available). On the very first contact the stored name is usually null, so the token falls back to "there". A future enhancement could do a pre-visit to capture the name before composing the note; that is intentionally out of scope. The live name returned by the driver is persisted for metrics/UI. Remove the dead `if (outcome.firstName && ...)` block — it documents the decision but does nothing; keep only the persistence line.

- [ ] **Step 4: Clean up the dead block**

Delete the `if (outcome.firstName && (...)) { ... }` no-op block noted above, keeping the line that persists `first_name`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/worker/sender.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add src/worker/sender.ts tests/worker/sender.test.ts
git commit -m "feat: sender worker with caps, skip/quota/checkpoint handling"
```

---

### Task 15: Acceptance-checker worker

**Files:**
- Create: `src/worker/acceptance-checker.ts`
- Test: `tests/worker/acceptance-checker.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/worker/acceptance-checker.test.ts
import { test, expect, beforeEach } from 'vitest';
import { openDatabase } from '../../src/db/database.js';
import { Repos } from '../../src/db/repositories.js';
import { FakeDriver } from '../../src/browser/driver.js';
import { runAcceptanceCheck } from '../../src/worker/acceptance-checker.js';

let repos: Repos; let driver: FakeDriver;
beforeEach(() => { repos = new Repos(openDatabase(':memory:')); driver = new FakeDriver(); });

function seedSent(url: string, cohortId: number) {
  const p = repos.profiles.add(cohortId, url, null);
  repos.profiles.setStatus(p.id, 'sent', { sent_at: '2026-06-20T00:00:00Z' });
  return p;
}

test('marks accepted and expired based on driver pages', async () => {
  const c = repos.cohorts.create('A', 'hi', true);
  const a = seedSent('https://www.linkedin.com/in/a', c.id); // still pending
  const b = seedSent('https://www.linkedin.com/in/b', c.id); // accepted
  const cc = seedSent('https://www.linkedin.com/in/c', c.id); // expired

  driver.pending = ['https://www.linkedin.com/in/a'];
  driver.connections = ['https://www.linkedin.com/in/b'];

  const now = new Date('2026-06-29T12:00:00Z');
  await runAcceptanceCheck(repos, driver, now);

  expect(repos.profiles.byStatus('sent').map((p) => p.id)).toEqual([a.id]);
  const accepted = repos.profiles.byStatus('accepted');
  expect(accepted.map((p) => p.id)).toEqual([b.id]);
  expect(accepted[0].accepted_at).toBe(now.toISOString());
  expect(repos.profiles.byStatus('expired').map((p) => p.id)).toEqual([cc.id]);
});

test('skips when paused', async () => {
  const c = repos.cohorts.create('A', 'hi', true);
  seedSent('https://www.linkedin.com/in/a', c.id);
  repos.settings.update({ paused: 1 });
  driver.connections = ['https://www.linkedin.com/in/a'];
  await runAcceptanceCheck(repos, driver, new Date());
  expect(repos.profiles.byStatus('accepted')).toHaveLength(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/worker/acceptance-checker.test.ts`
Expected: FAIL — cannot find `acceptance-checker.js`.

- [ ] **Step 3: Create `src/worker/acceptance-checker.ts`**

```typescript
import type { Repos } from '../db/repositories.js';
import type { BrowserDriver } from '../types.js';
import { computeAcceptanceTransitions } from '../core/acceptance.js';

export async function runAcceptanceCheck(repos: Repos, driver: BrowserDriver, now: Date): Promise<void> {
  if (repos.settings.get().paused) return;
  if (!(await driver.isLoggedIn())) return;

  const sent = repos.profiles.byStatus('sent').map((p) => ({ id: p.id, profile_url: p.profile_url }));
  if (sent.length === 0) return;

  const pending = new Set(await driver.readPendingInvites());
  const connections = new Set(await driver.readRecentConnections());
  const { accepted, expired } = computeAcceptanceTransitions(sent, pending, connections);

  const iso = now.toISOString();
  for (const id of accepted) {
    repos.profiles.setStatus(id, 'accepted', { accepted_at: iso, resolved_at: iso });
    repos.events.recordEvent(id, 'accepted');
  }
  for (const id of expired) {
    repos.profiles.setStatus(id, 'expired', { resolved_at: iso });
    repos.events.recordEvent(id, 'expired');
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/worker/acceptance-checker.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/worker/acceptance-checker.ts tests/worker/acceptance-checker.test.ts
git commit -m "feat: acceptance-checker worker"
```

---

### Task 16: Scheduler service + worker orchestrator

**Files:**
- Create: `src/worker/scheduler-service.ts` (assigns `scheduled_for` to queued profiles)
- Create: `src/worker/orchestrator.ts` (timer loops; thin glue)
- Test: `tests/worker/scheduler-service.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/worker/scheduler-service.test.ts
import { test, expect, beforeEach } from 'vitest';
import { openDatabase } from '../../src/db/database.js';
import { Repos } from '../../src/db/repositories.js';
import { planAndAssignToday } from '../../src/worker/scheduler-service.js';

let repos: Repos;
beforeEach(() => { repos = new Repos(openDatabase(':memory:')); });

test('moves queued profiles to scheduled with future timestamps within today', () => {
  const c = repos.cohorts.create('A', 'hi', true);
  for (let i = 0; i < 12; i++) repos.profiles.add(c.id, `https://www.linkedin.com/in/p${i}`, null);
  const now = new Date('2026-06-29T08:00:00'); // Monday 8am local
  const seq = [0.1, 0.3, 0.5, 0.7];
  planAndAssignToday(repos, now, () => seq[Math.floor(Math.random() * seq.length)]);

  const scheduled = repos.profiles.byStatus('scheduled');
  expect(scheduled.length).toBe(12); // capacity allows
  for (const p of scheduled) expect(p.scheduled_for).not.toBeNull();
  expect(repos.profiles.byStatus('queued')).toHaveLength(0);
});

test('does not schedule beyond remaining weekly capacity', () => {
  const c = repos.cohorts.create('A', 'hi', true);
  for (let i = 0; i < 5; i++) repos.profiles.add(c.id, `https://www.linkedin.com/in/p${i}`, null);
  repos.settings.update({ weekly_cap: 2 });
  planAndAssignToday(repos, new Date('2026-06-29T08:00:00'));
  expect(repos.profiles.byStatus('scheduled').length).toBe(2);
  expect(repos.profiles.byStatus('queued').length).toBe(3);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/worker/scheduler-service.test.ts`
Expected: FAIL — cannot find `scheduler-service.js`.

- [ ] **Step 3: Create `src/worker/scheduler-service.ts`**

```typescript
import type { Repos } from '../db/repositories.js';
import { planDailyBatches, assignSchedule } from '../core/schedule.js';
import { windowStartIso, remainingCapacity } from '../core/rate-limit.js';

export function planAndAssignToday(repos: Repos, now: Date, rng: () => number = Math.random): void {
  const s = repos.settings.get();
  if (s.weekdays_only && (now.getDay() === 0 || now.getDay() === 6)) return;

  const sentInWindow = repos.events.countSentSince(windowStartIso(now));
  const remaining = remainingCapacity(s.weekly_cap, sentInWindow);
  if (remaining <= 0) return;

  const queued = repos.profiles.byStatus('queued').slice(0, remaining);
  if (queued.length === 0) return;

  // Only plan batch times still in the future today; fall back to now+a bit.
  const allTimes = planDailyBatches(now, {
    startHour: s.workday_start_hour, endHour: s.workday_end_hour, count: s.batches_per_day,
  }, rng);
  const future = allTimes.filter((t) => t.getTime() > now.getTime());
  const times = future.length ? future : [new Date(now.getTime() + 60_000)];

  const assignments = assignSchedule(queued.map((p) => p.id), times, s.batch_size);
  for (const a of assignments) repos.profiles.setScheduled(a.id, a.when.toISOString());
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/worker/scheduler-service.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Create `src/worker/orchestrator.ts`** (thin timer glue; verified via integration in Task 19)

```typescript
import type { Repos } from '../db/repositories.js';
import type { BrowserDriver } from '../types.js';
import { planAndAssignToday } from './scheduler-service.js';
import { runSenderOnce } from './sender.js';
import { runAcceptanceCheck } from './acceptance-checker.js';

export class Orchestrator {
  private timers: NodeJS.Timeout[] = [];
  private lastAcceptanceDay = '';

  constructor(private repos: Repos, private driver: BrowserDriver) {}

  start(): void {
    // Plan immediately, then re-plan hourly (covers day rollover).
    planAndAssignToday(this.repos, new Date());
    this.timers.push(setInterval(() => planAndAssignToday(this.repos, new Date()), 60 * 60 * 1000));

    // Sender tick every 60s.
    this.timers.push(setInterval(() => { void runSenderOnce(this.repos, this.driver, new Date()); }, 60 * 1000));

    // Acceptance check: at most once per local day, triggered on a 30-min tick.
    this.timers.push(setInterval(() => {
      const day = new Date().toDateString();
      const s = this.repos.settings.get();
      if (day !== this.lastAcceptanceDay && !s.paused) {
        this.lastAcceptanceDay = day;
        void runAcceptanceCheck(this.repos, this.driver, new Date());
      }
    }, 30 * 60 * 1000));
  }

  stop(): void { this.timers.forEach(clearInterval); this.timers = []; }
}
```

- [ ] **Step 6: Commit**

```bash
git add src/worker/scheduler-service.ts src/worker/orchestrator.ts tests/worker/scheduler-service.test.ts
git commit -m "feat: scheduler service and worker orchestrator"
```

---

### Task 17: API server + routes

**Files:**
- Create: `src/api/server.ts`
- Test: `tests/api/server.test.ts`

Endpoints:
- `POST /api/profiles` `{ url, cohort, message? }` → enqueue (get-or-create cohort, normalize+dedupe).
- `POST /api/lists` `{ cohort, text, message_template?, allow_no_note? }` → bulk add from pasted text/CSV.
- `GET /api/status` → counts by status + rolling weekly sent + paused flag.
- `GET /api/cohorts` / `POST /api/cohorts` → list / create-or-update.
- `GET /api/metrics` → `computeCohortMetrics` output.
- `POST /api/pause` / `POST /api/resume`.
- `POST /api/login` → triggers `driver.openLoginWindow()`.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/api/server.test.ts
import { test, expect, beforeEach } from 'vitest';
import { openDatabase } from '../../src/db/database.js';
import { Repos } from '../../src/db/repositories.js';
import { FakeDriver } from '../../src/browser/driver.js';
import { buildServer } from '../../src/api/server.js';

let app: ReturnType<typeof buildServer>;
let repos: Repos;
beforeEach(() => {
  repos = new Repos(openDatabase(':memory:'));
  app = buildServer(repos, new FakeDriver());
});

test('POST /api/profiles enqueues a normalized profile and creates the cohort', async () => {
  const res = await app.inject({
    method: 'POST', url: '/api/profiles',
    payload: { url: 'https://linkedin.com/in/Jane/', cohort: 'Founders', message: 'Hi!' },
  });
  expect(res.statusCode).toBe(200);
  expect(repos.cohorts.findByName('Founders')).toBeDefined();
  const p = repos.profiles.all();
  expect(p[0].profile_url).toBe('https://www.linkedin.com/in/jane');
  expect(p[0].custom_message).toBe('Hi!');
});

test('POST /api/lists bulk-adds from pasted text, deduping', async () => {
  const text = 'https://linkedin.com/in/a\nhttps://linkedin.com/in/b\nhttps://linkedin.com/in/a';
  const res = await app.inject({
    method: 'POST', url: '/api/lists',
    payload: { cohort: 'C', text, message_template: 'Hi {firstName}', allow_no_note: true },
  });
  expect(res.statusCode).toBe(200);
  expect(JSON.parse(res.body).added).toBe(2);
  expect(repos.profiles.countAll()).toBe(2);
});

test('GET /api/status reports counts and paused flag', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/status' });
  expect(res.statusCode).toBe(200);
  const body = JSON.parse(res.body);
  expect(body).toHaveProperty('paused');
  expect(body).toHaveProperty('weekly_sent');
  expect(body).toHaveProperty('counts');
});

test('POST /api/pause and /api/resume toggle paused', async () => {
  await app.inject({ method: 'POST', url: '/api/pause' });
  expect(repos.settings.get().paused).toBe(1);
  await app.inject({ method: 'POST', url: '/api/resume' });
  expect(repos.settings.get().paused).toBe(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/api/server.test.ts`
Expected: FAIL — cannot find `server.js`.

- [ ] **Step 3: Create `src/api/server.ts`**

```typescript
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Repos } from '../db/repositories.js';
import type { BrowserDriver } from '../types.js';
import { normalizeProfileUrl, extractProfileUrls } from '../core/url.js';
import { computeCohortMetrics, type MetricRow } from '../core/metrics.js';
import { windowStartIso } from '../core/rate-limit.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function buildServer(repos: Repos, driver: BrowserDriver): FastifyInstance {
  const app = Fastify({ logger: false });

  app.register(fastifyStatic, { root: join(__dirname, '..', 'web'), prefix: '/' });

  app.post('/api/profiles', async (req, reply) => {
    const { url, cohort, message } = req.body as { url: string; cohort: string; message?: string };
    const normalized = normalizeProfileUrl(url ?? '');
    if (!normalized) return reply.code(400).send({ error: 'invalid linkedin profile url' });
    const c = repos.cohorts.getOrCreate(cohort, null, false);
    const p = repos.profiles.add(c.id, normalized, message ?? null);
    return { id: p.id, profile_url: p.profile_url };
  });

  app.post('/api/lists', async (req) => {
    const { cohort, text, message_template, allow_no_note } =
      req.body as { cohort: string; text: string; message_template?: string; allow_no_note?: boolean };
    const c = repos.cohorts.getOrCreate(cohort, message_template ?? null, !!allow_no_note);
    if (message_template !== undefined || allow_no_note !== undefined) {
      // refresh cohort message config if provided
      repos.db.prepare('UPDATE cohorts SET message_template = ?, allow_no_note = ? WHERE id = ?')
        .run(message_template ?? c.message_template, allow_no_note ? 1 : c.allow_no_note, c.id);
    }
    const urls = extractProfileUrls(text ?? '');
    let added = 0;
    const before = repos.profiles.countAll();
    for (const u of urls) repos.profiles.add(c.id, u, null);
    added = repos.profiles.countAll() - before;
    return { added, found: urls.length };
  });

  app.get('/api/status', async () => {
    const counts: Record<string, number> = {};
    for (const p of repos.profiles.all()) counts[p.status] = (counts[p.status] ?? 0) + 1;
    const s = repos.settings.get();
    return {
      paused: s.paused,
      pause_reason: s.pause_reason,
      weekly_sent: repos.events.countSentSince(windowStartIso(new Date())),
      weekly_cap: s.weekly_cap,
      counts,
    };
  });

  app.get('/api/cohorts', async () => repos.cohorts.list());

  app.post('/api/cohorts', async (req) => {
    const { name, message_template, allow_no_note } =
      req.body as { name: string; message_template?: string; allow_no_note?: boolean };
    const c = repos.cohorts.getOrCreate(name, message_template ?? null, !!allow_no_note);
    repos.db.prepare('UPDATE cohorts SET message_template = ?, allow_no_note = ? WHERE id = ?')
      .run(message_template ?? null, allow_no_note ? 1 : 0, c.id);
    return repos.cohorts.findById(c.id);
  });

  app.get('/api/metrics', async () => {
    const rows = repos.db.prepare(`
      SELECT p.cohort_id, c.name AS cohort_name, p.status, p.sent_at, p.accepted_at
      FROM profiles p JOIN cohorts c ON c.id = p.cohort_id
    `).all() as MetricRow[];
    return computeCohortMetrics(rows);
  });

  app.get('/api/profiles', async () =>
    repos.db.prepare(`
      SELECT p.id, p.profile_url, p.status, p.scheduled_for, p.sent_at, p.accepted_at,
             p.last_error, c.name AS cohort_name
      FROM profiles p JOIN cohorts c ON c.id = p.cohort_id
      ORDER BY p.id DESC LIMIT 500
    `).all());

  app.get('/api/settings', async () => repos.settings.get());
  app.post('/api/settings', async (req) => { repos.settings.update(req.body as any); return repos.settings.get(); });

  app.post('/api/pause', async () => { repos.settings.update({ paused: 1, pause_reason: 'Manual pause' }); return { ok: true }; });
  app.post('/api/resume', async () => { repos.settings.update({ paused: 0, pause_reason: null }); return { ok: true }; });

  app.post('/api/login', async () => { void driver.openLoginWindow(); return { ok: true }; });
  app.get('/api/login-status', async () => ({ loggedIn: await driver.isLoggedIn() }));

  return app;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/api/server.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/api/server.ts tests/api/server.test.ts
git commit -m "feat: fastify api server with profiles, lists, status, metrics, settings"
```

---

### Task 18: Web UI

**Files:**
- Create: `src/web/index.html`
- Create: `src/web/app.js`
- Create: `src/web/styles.css`
- Test: manual

The UI is a single page with tabs: **Dashboard**, **Add List**, **Cohorts**, **Metrics**, **Settings**. Plain `fetch` against the API. No build step, no CDN.

- [ ] **Step 1: Create `src/web/index.html`**

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>LinkedIn Connector</title>
  <link rel="stylesheet" href="/styles.css" />
</head>
<body>
  <header>
    <h1>LinkedIn Connector</h1>
    <div id="login-bar"></div>
    <div id="pause-banner" class="banner hidden"></div>
  </header>
  <nav>
    <button data-tab="dashboard" class="active">Dashboard</button>
    <button data-tab="add">Add List</button>
    <button data-tab="cohorts">Cohorts</button>
    <button data-tab="metrics">Metrics</button>
    <button data-tab="settings">Settings</button>
  </nav>
  <main>
    <section id="dashboard" class="tab active">
      <div id="status-cards"></div>
      <div class="controls">
        <button id="pause-btn">Pause</button>
        <button id="resume-btn">Resume</button>
      </div>
      <table id="queue-table"><thead><tr>
        <th>Profile</th><th>Cohort</th><th>Status</th><th>Scheduled</th><th>Error</th>
      </tr></thead><tbody></tbody></table>
    </section>

    <section id="add" class="tab">
      <label>Cohort name <input id="add-cohort" /></label>
      <label>Message template (use {firstName}) <textarea id="add-template" maxlength="300"></textarea></label>
      <label><input type="checkbox" id="add-nonote" /> Allow sending with no note</label>
      <label>Paste URLs or CSV/TXT content <textarea id="add-text" rows="8"></textarea></label>
      <input type="file" id="add-file" accept=".csv,.txt" />
      <button id="add-submit">Add to queue</button>
      <div id="add-result"></div>
    </section>

    <section id="cohorts" class="tab"><div id="cohorts-list"></div></section>
    <section id="metrics" class="tab"><div id="metrics-table"></div></section>
    <section id="settings" class="tab"><div id="settings-form"></div></section>
  </main>
  <script src="/app.js"></script>
</body>
</html>
```

- [ ] **Step 2: Create `src/web/styles.css`**

```css
* { box-sizing: border-box; }
body { font-family: system-ui, sans-serif; margin: 0; color: #1d2b3a; background: #f4f6f8; }
header { background: #0a66c2; color: #fff; padding: 12px 20px; display: flex; align-items: center; gap: 16px; }
header h1 { font-size: 18px; margin: 0; }
nav { display: flex; gap: 4px; padding: 8px 20px; background: #fff; border-bottom: 1px solid #e0e0e0; }
nav button { border: none; background: none; padding: 8px 14px; cursor: pointer; border-radius: 6px; }
nav button.active { background: #eaf1fb; color: #0a66c2; font-weight: 600; }
main { padding: 20px; max-width: 1000px; margin: 0 auto; }
.tab { display: none; } .tab.active { display: block; }
label { display: block; margin: 10px 0; } input, textarea { width: 100%; padding: 8px; }
input[type=checkbox] { width: auto; }
button { cursor: pointer; padding: 8px 14px; border-radius: 6px; border: 1px solid #0a66c2; background: #0a66c2; color: #fff; }
table { width: 100%; border-collapse: collapse; margin-top: 12px; background: #fff; }
th, td { text-align: left; padding: 8px; border-bottom: 1px solid #eee; font-size: 13px; }
.banner { background: #b3261e; color: #fff; padding: 8px 12px; border-radius: 6px; }
.hidden { display: none; }
#status-cards { display: flex; gap: 12px; flex-wrap: wrap; }
.card { background: #fff; border-radius: 8px; padding: 12px 16px; min-width: 110px; }
.card .n { font-size: 22px; font-weight: 700; }
</style>
```

(Remove the stray `</style>` — CSS files have no tags.)

- [ ] **Step 3: Create `src/web/app.js`**

```javascript
const $ = (s) => document.querySelector(s);
const api = (url, opts) => fetch(url, opts).then((r) => r.json());

document.querySelectorAll('nav button').forEach((b) => b.onclick = () => {
  document.querySelectorAll('nav button').forEach((x) => x.classList.remove('active'));
  document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
  b.classList.add('active');
  $('#' + b.dataset.tab).classList.add('active');
  refresh();
});

async function refreshStatus() {
  const s = await api('/api/status');
  const banner = $('#pause-banner');
  if (s.paused) { banner.textContent = '⏸ Paused: ' + (s.pause_reason || ''); banner.classList.remove('hidden'); }
  else banner.classList.add('hidden');
  const cards = [
    ['This week', `${s.weekly_sent}/${s.weekly_cap}`],
    ['Queued', s.counts.queued || 0], ['Scheduled', s.counts.scheduled || 0],
    ['Sent', s.counts.sent || 0], ['Accepted', s.counts.accepted || 0],
    ['Needs attention', s.counts.needs_attention || 0],
  ];
  $('#status-cards').innerHTML = cards.map(([k, v]) => `<div class="card"><div>${k}</div><div class="n">${v}</div></div>`).join('');
}

async function refreshQueue() {
  const rows = await api('/api/profiles');
  $('#queue-table tbody').innerHTML = rows.map((r) => `<tr>
    <td><a href="${r.profile_url}" target="_blank">${r.profile_url.split('/in/')[1]}</a></td>
    <td>${r.cohort_name}</td><td>${r.status}</td>
    <td>${r.scheduled_for ? new Date(r.scheduled_for).toLocaleString() : ''}</td>
    <td>${r.last_error || ''}</td></tr>`).join('');
}

async function refreshLogin() {
  const { loggedIn } = await api('/api/login-status');
  $('#login-bar').innerHTML = loggedIn
    ? '🟢 Logged in'
    : '🔴 Not logged in <button id="login-btn">Connect LinkedIn</button>';
  const lb = $('#login-btn'); if (lb) lb.onclick = () => api('/api/login', { method: 'POST' });
}

async function refreshMetrics() {
  const m = await api('/api/metrics');
  $('#metrics-table').innerHTML = `<table><thead><tr>
    <th>Cohort</th><th>Sent</th><th>Accepted</th><th>Pending</th><th>Expired</th>
    <th>Accept rate</th><th>Median days</th></tr></thead><tbody>` +
    m.map((c) => `<tr><td>${c.cohort_name}</td><td>${c.sent}</td><td>${c.accepted}</td>
      <td>${c.pending}</td><td>${c.expired}</td>
      <td>${(c.acceptance_rate * 100).toFixed(0)}%</td>
      <td>${c.median_time_to_accept_days?.toFixed(1) ?? '—'}</td></tr>`).join('') + '</tbody></table>';
}

async function refreshCohorts() {
  const cs = await api('/api/cohorts');
  $('#cohorts-list').innerHTML = cs.map((c) =>
    `<div class="card" style="width:100%;margin-bottom:8px"><b>${c.name}</b><br>
     <small>${c.message_template || '(no note)'} ${c.allow_no_note ? '· no-note allowed' : ''}</small></div>`).join('');
}

async function refreshSettings() {
  const s = await api('/api/settings');
  $('#settings-form').innerHTML = `
    <label>Weekly cap <input id="set-cap" type="number" value="${s.weekly_cap}"></label>
    <label>Batch size <input id="set-batch" type="number" value="${s.batch_size}"></label>
    <label>Batches/day <input id="set-bpd" type="number" value="${s.batches_per_day}"></label>
    <label>Work start hour <input id="set-start" type="number" value="${s.workday_start_hour}"></label>
    <label>Work end hour <input id="set-end" type="number" value="${s.workday_end_hour}"></label>
    <label>Account type
      <select id="set-acct">${['unknown','free','premium','salesnav'].map((t) =>
        `<option ${t === s.account_type ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
    <button id="set-save">Save</button>`;
  $('#set-save').onclick = async () => {
    await api('/api/settings', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        weekly_cap: +$('#set-cap').value, batch_size: +$('#set-batch').value,
        batches_per_day: +$('#set-bpd').value, workday_start_hour: +$('#set-start').value,
        workday_end_hour: +$('#set-end').value, account_type: $('#set-acct').value }) });
    alert('Saved');
  };
}

$('#pause-btn').onclick = () => api('/api/pause', { method: 'POST' }).then(refreshStatus);
$('#resume-btn').onclick = () => api('/api/resume', { method: 'POST' }).then(refreshStatus);

$('#add-file').onchange = async (e) => {
  const f = e.target.files[0]; if (f) $('#add-text').value = await f.text();
};
$('#add-submit').onclick = async () => {
  const res = await api('/api/lists', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      cohort: $('#add-cohort').value, text: $('#add-text').value,
      message_template: $('#add-template').value || undefined, allow_no_note: $('#add-nonote').checked }) });
  $('#add-result').textContent = `Added ${res.added} of ${res.found} found.`;
  refresh();
};

function refresh() {
  refreshLogin(); refreshStatus();
  if ($('#dashboard').classList.contains('active')) refreshQueue();
  if ($('#metrics').classList.contains('active')) refreshMetrics();
  if ($('#cohorts').classList.contains('active')) refreshCohorts();
  if ($('#settings').classList.contains('active')) refreshSettings();
}
refresh();
setInterval(() => { refreshLogin(); refreshStatus(); if ($('#dashboard').classList.contains('active')) refreshQueue(); }, 15000);
```

- [ ] **Step 4: Manual verification**

After Task 19 wires the entrypoint, run `npm start`, open `http://localhost:4400`, and confirm: tabs switch; Add List accepts pasted URLs and a file; Dashboard shows status cards + queue; Pause/Resume toggle the banner; Settings save; Connect-LinkedIn button opens the browser.

- [ ] **Step 5: Commit**

```bash
git add src/web/
git commit -m "feat: web UI (dashboard, add list, cohorts, metrics, settings)"
```

---

### Task 19: Entrypoint wiring + README

**Files:**
- Create: `src/index.ts`
- Create: `README.md`
- Test: manual end-to-end

- [ ] **Step 1: Create `src/index.ts`**

```typescript
import { openDatabase } from './db/database.js';
import { Repos } from './db/repositories.js';
import { LinkedInDriver } from './browser/linkedin-driver.js';
import { Orchestrator } from './worker/orchestrator.js';
import { buildServer } from './api/server.js';
import { DB_PATH, PORT } from './config.js';

const repos = new Repos(openDatabase(DB_PATH));
const driver = new LinkedInDriver();
const orchestrator = new Orchestrator(repos, driver);
const app = buildServer(repos, driver);

orchestrator.start();
app.listen({ port: PORT, host: '127.0.0.1' }).then(() => {
  console.log(`LinkedIn Connector running at http://localhost:${PORT}`);
});

const shutdown = async () => { orchestrator.stop(); await driver.close(); await app.close(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
```

- [ ] **Step 2: Create `README.md`**

````markdown
# LinkedIn Connector

Local, paced LinkedIn connection-request sender with cohorts, per-contact messages,
acceptance tracking, and per-cohort metrics. Runs entirely on your machine against your
own LinkedIn account.

## Requirements
- Node.js >= 22.5 (uses the built-in `node:sqlite` — no native build step).

## Setup
```bash
npm install
npm start
```
Open http://localhost:4400.

## First run
1. Click **Connect LinkedIn** — a browser window opens; log in manually. Your session
   persists in `.linkedin-profile/`.
2. Go to **Add List**, name a cohort, set a message template (use `{firstName}`), paste
   URLs or upload a CSV/TXT.
3. The app schedules sends at randomized times within your working hours (default
   8am–8pm weekdays), 5 per batch, max 100 per rolling 7 days.

## Safety
- If LinkedIn shows a captcha/checkpoint, the queue auto-pauses and the dashboard shows a
  banner. Resolve it in the browser window, then click **Resume**.
- Acceptance tracking reads two list pages ~once/day; it does not consume your weekly cap.

## API (localhost)
- `POST /api/profiles` `{ url, cohort, message? }` — enqueue one profile (for AI agents).
- `GET /api/status` — queue + weekly count.

## Tests
```bash
npm test
```

## Maintenance
LinkedIn changes its HTML periodically. All selectors live in
`src/browser/linkedin-selectors.ts` — update them there if sends start failing.
````

- [ ] **Step 3: Run the full test suite**

Run: `npm test`
Expected: ALL tests pass across db, core, worker, api suites.

- [ ] **Step 4: Manual end-to-end verification**

Run `npm start`. Confirm the server logs the URL, the UI loads, login works, adding a small test list schedules profiles (visible in the queue), and (optionally, with a throwaway target) a send completes and appears as `sent`. Confirm the acceptance check can be triggered (temporarily lower nothing needed — just verify no errors in console over a tick).

- [ ] **Step 5: Commit**

```bash
git add src/index.ts README.md
git commit -m "feat: entrypoint wiring and README"
```

---

## Self-Review

**Spec coverage check:**
- Accept list of URLs (paste/upload CSV/TXT) → Tasks 5, 17 (`/api/lists`), 18. ✓
- Cohort name + per-cohort message → Tasks 4, 17 (`/api/cohorts`), 18. ✓
- Per-contact message (AI agent via API) → Tasks 4 (precedence), 17 (`/api/profiles`). ✓
- Send connection request w/ note, {firstName}, ≤300 → Tasks 6, 12. ✓
- Continuous periodic queue → Tasks 16 (orchestrator timers). ✓
- Batch 5 / ≤100 rolling week / randomized times / working hours → Tasks 7, 8, 16. ✓
- Stealth browser (CloakBrowser), visible, pre-login persistent → Tasks 11, 12. ✓
- SQLite, portable, per-teammate → Tasks 1, 3 (`node:sqlite`), 19 (README). ✓
- Captcha/checkpoint pause + needs_attention → Task 14. ✓
- Free/Premium note-quota fallback → Task 14 (note_quota handling). ✓
- Acceptance tracking (light, once/day, off-budget) → Tasks 9, 12, 15, 16. ✓
- Per-cohort metrics (funnel, rate, median time-to-accept) → Tasks 10, 17, 18. ✓
- Progress UI → Task 18. ✓
- Out of scope (follow-up messaging, multi-account, cloud) → not implemented. ✓

**Placeholder scan:** No TBD/TODO. The one no-op block in Task 14 is explicitly called out and removed in Task 14 Step 4. The stray `</style>` in Task 18 Step 2 is explicitly called out for removal.

**Type consistency:** `BrowserDriver` methods (`isLoggedIn`, `openLoginWindow`, `sendConnectionRequest`, `readPendingInvites`, `readRecentConnections`, `close`) match across `FakeDriver` (11), `LinkedInDriver` (12), and all callers (14, 15, 17). `SendResult` values (`sent|already|unavailable|note_quota|checkpoint|error`) match the sender's switch. Repo method names (`getOrCreate`, `setScheduled`, `setStatus`, `byStatus`, `countSentSince`, `recordSend`, `recordEvent`) are used consistently. `computeCohortMetrics` field names match the UI render in Task 18.
```
