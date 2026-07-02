import { mkdirSync, writeFileSync, readdirSync, readFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { INCIDENTS_DIR } from '../config.js';
import { log } from '../core/log.js';

/**
 * Incident evidence: when the engine halts (checkpoint) or a send fails in a way
 * we can't explain, we snapshot the live page — screenshot + HTML + a meta json —
 * so "what did the browser actually see?" is answerable after the fact.
 * Files live under data/incidents/ as <stamp>-<tag>.{png,html,json}.
 */

/** The slice of Playwright's Page that capture needs (stubable in tests). */
export interface PageEvidenceSource {
  url(): string;
  title(): Promise<string>;
  content(): Promise<string>;
  screenshot(options?: { fullPage?: boolean }): Promise<Buffer>;
}

export interface Evidence {
  base: string;              // file base name, e.g. "2026-07-02T13-02-44-checkpoint"
  screenshot: string | null; // "<base>.png", or null if that capture step failed
  html: string | null;       // "<base>.html", or null if that capture step failed
  pageUrl: string;
  title: string;
  capturedAt: string;        // ISO
}

/** How many incidents to keep on disk (each is up to 3 files). */
const KEEP = 60;

export async function captureEvidence(
  page: PageEvidenceSource,
  tag: string,
  extra: Record<string, unknown> = {},
  dir: string = INCIDENTS_DIR,
  now: Date = new Date(),
): Promise<Evidence | null> {
  try {
    mkdirSync(dir, { recursive: true });
    const stamp = now.toISOString().slice(0, 19).replace(/:/g, '-');
    let base = `${stamp}-${tag}`;
    for (let i = 2; existsSync(join(dir, `${base}.json`)); i++) base = `${stamp}-${tag}-${i}`;

    const pageUrl = page.url();
    const title = await page.title().catch(() => '');

    // Each artifact is best-effort: a dead page must not lose the others.
    let screenshot: string | null = null;
    try {
      writeFileSync(join(dir, `${base}.png`), await page.screenshot({ fullPage: false }));
      screenshot = `${base}.png`;
    } catch { /* page gone mid-capture */ }

    let html: string | null = null;
    try {
      writeFileSync(join(dir, `${base}.html`), await page.content());
      html = `${base}.html`;
    } catch { /* page gone mid-capture */ }

    const evidence: Evidence = { base, screenshot, html, pageUrl, title, capturedAt: now.toISOString() };
    writeFileSync(join(dir, `${base}.json`), JSON.stringify({ tag, ...extra, ...evidence }, null, 2));
    prune(dir);
    log.info('evidence', 'captured', { tag, url: pageUrl, screenshot: screenshot ?? 'failed' });
    return evidence;
  } catch (e) {
    log.warn('evidence', 'capture failed', { tag, error: (e as Error).message });
    return null;
  }
}

/** Parsed incident metas, newest first. */
export function listIncidents(dir: string = INCIDENTS_DIR, limit = 20): Record<string, unknown>[] {
  try {
    const names = readdirSync(dir).filter((f) => f.endsWith('.json')).sort().reverse().slice(0, limit);
    const rows: Record<string, unknown>[] = [];
    for (const name of names) {
      try { rows.push(JSON.parse(readFileSync(join(dir, name), 'utf8'))); } catch { /* skip corrupt */ }
    }
    return rows;
  } catch {
    return []; // no incidents dir yet
  }
}

/** Keep only the newest KEEP incidents (json + their png/html siblings). */
function prune(dir: string): void {
  const jsons = readdirSync(dir).filter((f) => f.endsWith('.json')).sort().reverse();
  for (const name of jsons.slice(KEEP)) {
    const base = name.slice(0, -'.json'.length);
    for (const ext of ['.json', '.png', '.html']) {
      try { unlinkSync(join(dir, base + ext)); } catch { /* already gone */ }
    }
  }
}
