// @vitest-environment jsdom
/// <reference lib="dom" />
/**
 * The note glyph on an "Up next" cohort row.
 *
 * These exist because of a shipped layout bug with a one-word cause. The glyph's
 * "this row has no note" modifier was the bare class `empty` — which styles.css also
 * defines, at the same specificity and further down the file, as the page-level
 * empty-state block (`.empty { padding: 48px 20px }`). The block rule therefore won the
 * padding cascade, and because the button is border-box its `height: 30px` was clamped up
 * to that padding: a ~98px glyph inside a ~114px row. It stayed invisible while every
 * queued cohort carried a message template (a templated row renders the OTHER glyph);
 * the first note-less campaign turned all 55 of its rows into banners.
 *
 * jsdom does no layout, so height can't be asserted here. The class can — and the class
 * IS the bug. The second test is the general form: nothing the queue renders may borrow
 * a block class as a modifier, whatever new modifiers get added later.
 */
import { test, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadApp, byId, stubFetchRoutes, type AppInternals } from './helpers/load-app.js';

let app: AppInternals;
const realFetch = globalThis.fetch;

beforeEach(() => { app = loadApp(); });
afterEach(() => { globalThis.fetch = realFetch; });

const flush = () => new Promise((r) => setTimeout(r, 0));

const profile = (id: number, note: string | null) => ({
  id, profile_url: `https://www.linkedin.com/in/person-${id}`,
  kind: 'invite', status: 'queued', scheduled_for: null, note,
});

/** A cohort sending bare connection requests — the shape that exposed the bug. */
const queue = (notes: (string | null)[]) => ({
  events: [],
  cohorts: [{
    id: 15,
    name: 'EXPORT_top200 (empty message)',
    count: notes.length,
    profiles: notes.map((n, i) => profile(600 + i, n)),
  }],
});

test('a note-less row marks its glyph without borrowing the empty-state block class', async () => {
  stubFetchRoutes({ '/api/queue/grouped': { body: queue([null, 'Hi {firstName}, good to connect']) } });
  await app.refreshQueue();
  await flush();

  const [bare, noted] = [...byId('queueGroups').querySelectorAll('.note-btn')];
  expect(bare.classList.contains('is-empty')).toBe(true);
  // The whole bug in one assertion: `.empty` is a 48px-padding page block, not a modifier.
  expect(bare.classList.contains('empty')).toBe(false);
  expect(noted.classList.contains('is-empty')).toBe(false);
  // The distinction the glyph exists to draw still reaches a screen reader.
  expect(bare.getAttribute('aria-label')).toBe('No note — bare request');
});

test('no queue row reuses a styles.css block class as a modifier', async () => {
  stubFetchRoutes({ '/api/queue/grouped': { body: queue([null, 'a note']) } });
  await app.refreshQueue();
  await flush();

  // Single-class rules whose padding is BLOCK-sized (>= 24px on any edge): `.empty`,
  // `.markdown`, and friends. A component's own base class pads in single digits —
  // `.pill` at 4px, `.note-btn` at 0 — so the threshold separates "this element's own
  // box" from "a page block whose box got borrowed", which is the bug being guarded.
  const css = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'web', 'styles.css'),
    'utf8',
  ).replace(/\/\*[\s\S]*?\*\//g, '');
  // Selector chars exclude braces, so each rule's match starts cleanly after the previous
  // rule's `}` and nested (@media) rules are picked up as themselves.
  const blocks = new Set<string>();
  for (const [, sel, body] of css.matchAll(/([^{};]*)\{([^{}]*)\}/g)) {
    const cls = /^\.([a-z0-9-]+)$/i.exec(sel.trim());
    const padding = /(?:^|;)\s*padding\s*:([^;]+)/.exec(body);
    if (!cls || !padding) continue;
    const px = [...padding[1].matchAll(/(\d+(?:\.\d+)?)px/g)].map((p) => Number(p[1]));
    if (px.some((v) => v >= 24)) blocks.add(cls[1]);
  }
  expect(blocks.has('empty')).toBe(true); // the guard is only worth anything if it sees them

  const offenders = [...byId('queueGroups').querySelectorAll<HTMLElement>('*')]
    .flatMap((n) => [...n.classList].map((c) => ({ c, on: n.className })))
    // A class is only a modifier when it rides alongside another one; an element whose
    // sole class is `.empty` IS the empty state.
    .filter(({ c, on }) => blocks.has(c) && on.trim().split(/\s+/).length > 1);
  expect(offenders).toEqual([]);
});
