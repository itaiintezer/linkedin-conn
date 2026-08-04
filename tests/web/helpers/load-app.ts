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

/** The internals under test. app.js and posts.js declare these as plain function statements. */
export interface AppInternals {
  renderEngine: (status: Record<string, unknown>) => void;
  applyEngineState: (status: Record<string, unknown>) => void;
  loadAttention: () => Promise<void>;
  /** Pure: which table+endpoint an Attention row's Retry/Dismiss must target. */
  attentionActionPath: (row: Record<string, unknown>, action: string) => string;
  attentionRowSource: (row: Record<string, unknown>) => 'profile' | 'engagement';
  renderEngagements: (engagements: Record<string, unknown> | null | undefined) => void;
  refreshEngagementUpNext: () => Promise<void>;
  kindMark: (kind: string) => HTMLElement;
  refreshConnections: () => Promise<void>;
  initConnections: () => void;
  refreshEnrichment: () => Promise<void>;
  initEnrichment: () => void;
  renderApifyKey: (settings: Record<string, unknown>) => void;
  applyEnrichHaltUi: (status: Record<string, unknown>) => void;
  initSearch: () => void;
  /** app.js's module-level `selected` Set of profile URLs (app.js:1879) — the ONE selection
   *  store the Connections bar's three buttons read. */
  searchSelection: () => Set<string>;
  initEvents: () => void;
  initDashboard: () => void;
  refreshQueue: () => Promise<void>;
  evRenderDetail: (detail: Record<string, unknown>) => void;
  evLoadList: () => Promise<void>;
  evOpen: (id: number, quiet?: boolean) => Promise<void>;
  /* ---- src/web/posts.js (loaded into the same scope, see loadApp) ---- */
  initPosts: () => void;
  renderPostsFeed: (payload: Record<string, unknown>, append?: boolean) => void;
  refreshPosts: (append?: boolean) => Promise<void>;
  refreshTracked: () => Promise<void>;
  postsState: { filter: string; selected: Set<number>; cursor: string | null };
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
 * <script> tags in jsdom, which is exactly what we want — app.js and posts.js are loaded
 * explicitly, in that order.
 */
export function loadApp(): AppInternals {
  const html = readFileSync(join(WEB_DIR, 'index.html'), 'utf8');
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html);
  if (!body) throw new Error('could not find <body> in src/web/index.html');
  document.body.innerHTML = body[1];

  // Shadow the prototype getter with an own property (see note above).
  Object.defineProperty(document, 'readyState', { value: 'loading', configurable: true });

  const src = readFileSync(join(WEB_DIR, 'app.js'), 'utf8');
  /* posts.js is concatenated into the SAME function body, in the same order index.html loads
     the two script tags. That is not a convenience: they are classic scripts sharing one
     global lexical scope, so posts.js reads app.js's api/el/$/toast helpers, and a top-level
     name declared in both would throw "Identifier has already been declared" here exactly as
     it does in the browser. Loading them separately would hide that collision from the suite. */
  const postsSrc = readFileSync(join(WEB_DIR, 'posts.js'), 'utf8');
  const factory = new Function(
    'setInterval',
    `${src}\n${postsSrc}\nreturn { renderEngine, applyEngineState, loadAttention, attentionActionPath, attentionRowSource, renderEngagements, refreshEngagementUpNext, kindMark, refreshConnections, initConnections, refreshEnrichment, initEnrichment, renderApifyKey, applyEnrichHaltUi, initSearch, searchSelection, initEvents, initDashboard, refreshQueue, evRenderDetail, evLoadList, evOpen, initPosts, renderPostsFeed, refreshPosts, refreshTracked, postsState, init };`,
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

/**
 * One canned response for a route: a JSON body, or an error to make api() throw.
 *
 * `body` is honoured on failure statuses too — a refusal carries a whole body, not just a
 * message. The run-now buttons read BOTH fields off a 409: `code` picks the short button
 * label and `error` is the sentence they put in the tooltip and speak over aria-live.
 */
export interface RouteStub {
  body?: unknown;
  status?: number;
  error?: string;
}

/** A fetch call the router observed. */
export interface RecordedCall {
  path: string;
  method: string;
  body: unknown;
}

/**
 * Stub `fetch` with a path-prefix router, for controllers that hit several endpoints.
 * Returns the recorded calls so a test can assert what was sent, not just what rendered.
 * An unrouted path rejects loudly rather than silently resolving — a controller quietly
 * calling an endpoint the test never anticipated is a bug worth surfacing.
 */
export function stubFetchRoutes(routes: Record<string, RouteStub>): RecordedCall[] {
  const calls: RecordedCall[] = [];
  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    const path = String(input);
    calls.push({
      path,
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const key = Object.keys(routes)
      .sort((a, b) => b.length - a.length)      // longest prefix wins
      .find((r) => path.startsWith(r));
    if (!key) throw new Error(`unrouted fetch in test: ${path}`);
    const stub = routes[key];
    if (stub.error !== undefined || (stub.status ?? 200) >= 400) {
      const body = stub.body ?? { error: stub.error };
      return { ok: false, status: stub.status ?? 400, statusText: 'Bad Request', json: async () => body };
    }
    return { ok: true, status: 200, json: async () => stub.body };
  }) as unknown as typeof fetch;
  return calls;
}
