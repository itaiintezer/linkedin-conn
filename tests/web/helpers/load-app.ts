/// <reference lib="dom" />
/**
 * Test harness for `src/web/app.js` — the vanilla-JS dashboard controller.
 *
 * app.js is a plain browser script (no module system, no exports), so it can't be
 * imported. This loads the REAL file into a jsdom document built from the REAL
 * `src/web/index.html`, so tests run against the actual element ids and structure the
 * browser sees rather than hand-rolled stub nodes. It exists because a shipped bug
 * (message-side `needs_attention` counted as 0, making those rows invisible AND
 * unreachable) was invisible to a suite that only tested the server.
 *
 * Only callers in tests/web use this. Requires the jsdom environment — put
 * `// @vitest-environment jsdom` at the top of any test file that loads it.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'src', 'web');

/** The internals under test. app.js declares these as plain function statements. */
export interface AppInternals {
  renderEngine: (status: Record<string, unknown>) => void;
  applyEngineState: (status: Record<string, unknown>) => void;
  loadAttention: () => Promise<void>;
  kindMark: (kind: string) => HTMLElement;
  /** The bootstrap. Never called by loadApp — see the readyState note below. */
  init: () => void;
}

/**
 * Populate `document` from index.html and evaluate app.js against it.
 *
 * Two deliberate details:
 *  - `document.readyState` is shadowed to 'loading' so app.js's tail registers a
 *    DOMContentLoaded listener instead of calling init() immediately. Letting init()
 *    run would fire real fetches and register two setIntervals (15s/30s) that outlive
 *    the test. Tests exercise one function at a time; a test that wants the whole
 *    bootstrap can call the returned `init` itself.
 *  - `setInterval` is injected as a no-op purely as a safety net, so a future change
 *    to that tail can't silently start leaking timers into the suite.
 *
 * Scripts referenced by index.html are NOT executed: assigning innerHTML never runs
 * <script> tags in jsdom, which is exactly what we want — app.js is loaded explicitly.
 */
export function loadApp(): AppInternals {
  const html = readFileSync(join(WEB_DIR, 'index.html'), 'utf8');
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html);
  if (!body) throw new Error('could not find <body> in src/web/index.html');
  document.body.innerHTML = body[1];

  // Shadow the prototype getter with an own property (see note above).
  Object.defineProperty(document, 'readyState', { value: 'loading', configurable: true });

  const src = readFileSync(join(WEB_DIR, 'app.js'), 'utf8');
  const factory = new Function(
    'setInterval',
    `${src}\nreturn { renderEngine, applyEngineState, loadAttention, kindMark, init };`,
  ) as (setIntervalStub: () => number) => AppInternals;
  return factory(() => 0);
}

/** textContent of an element by id, for terse assertions. */
export function text(id: string): string {
  const node = document.getElementById(id);
  if (!node) throw new Error(`no element #${id} in index.html`);
  return node.textContent ?? '';
}

/** An element by id, failing loudly if index.html ever drops it. */
export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id) as T | null;
  if (!node) throw new Error(`no element #${id} in index.html`);
  return node;
}

/** Stub `fetch` with one canned JSON body, mirroring what api() consumes (ok + json()). */
export function stubFetchJson(payload: unknown): void {
  globalThis.fetch = (async () => ({ ok: true, json: async () => payload })) as unknown as typeof fetch;
}
