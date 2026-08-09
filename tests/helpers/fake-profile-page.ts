/**
 * A fake Playwright Page for driving LinkedInDriver's profile pre-visit paths without a
 * browser. It understands exactly the selector language linkedin-selectors.ts speaks —
 * `[attr*="value"( i)?]` conjunctions with optional tag prefix, top-level commas,
 * `:has-text("…")` — plus getByRole(name, expanded), which is all the relationship
 * classification uses. Anything fancier should fail loudly here rather than pass vacuously.
 *
 * Elements carry a `zone` so scoping works the way the driver relies on it:
 *   'main'  — inside <main> (page.locator('main') scopes here)
 *   'menu'  — inside the expanded "More" overflow (absent until the More button is clicked)
 *   'body'  — outside <main> (e.g. the sticky-header Pending badge duplicate)
 * A synthetic [role="menu"] container appears on expand so SEL.overflowMenu resolves.
 *
 * `evaluate(fn)` runs fn in-process against a minimal DOM: parentElement chain up to
 * MAIN, with the card ancestor exposing an /in/<cardSlug> anchor via querySelector —
 * the shape the driver's nearest-card-slug walk needs (live-verified 2026-08-08 in
 * docs/superpowers/specs/2026-08-08-relationship-probe-findings.md).
 */

export interface FakeElementSpec {
  tag?: string;
  attrs?: Record<string, string>;
  text?: string;
  visible?: boolean;
  zone?: 'main' | 'menu' | 'body';
  /** Slug of the nearest ancestor card's /in/ link; null = no card link (walk finds nothing). */
  cardSlug?: string | null;
}

interface FakeElement extends Required<Omit<FakeElementSpec, 'cardSlug'>> {
  cardSlug: string | null;
}

export interface FakeProfilePageSpec {
  url: string;
  title: string;
  elements?: FakeElementSpec[];
  /** Elements revealed (zone 'menu') when the More button is clicked. */
  overflowOnExpand?: FakeElementSpec[];
  /** Adds a collapsed More button to <main>. */
  hasMoreButton?: boolean;
}

function el(spec: FakeElementSpec): FakeElement {
  return {
    tag: spec.tag ?? 'div',
    attrs: spec.attrs ?? {},
    text: spec.text ?? '',
    visible: spec.visible ?? true,
    zone: spec.zone ?? 'main',
    cardSlug: spec.cardSlug ?? null,
  };
}

/** One comma-free selector alternative against one element. */
function matchOne(e: FakeElement, alt: string): boolean {
  const trimmed = alt.trim();
  const tag = trimmed.match(/^[a-z][a-z0-9]*/i)?.[0];
  if (tag && tag.toLowerCase() !== e.tag.toLowerCase()) return false;
  for (const m of trimmed.matchAll(/\[([a-zA-Z-]+)\*="([^"]*)"(\s+i)?\]/g)) {
    const [, attr, value, ci] = m;
    const actual = e.attrs[attr!] ?? '';
    const ok = ci ? actual.toLowerCase().includes(value!.toLowerCase()) : actual.includes(value!);
    if (!ok) return false;
  }
  for (const m of trimmed.matchAll(/\[([a-zA-Z-]+)="([^"]*)"\]/g)) {
    if ((e.attrs[m[1]!] ?? '') !== m[2]) return false;
  }
  const hasText = trimmed.match(/:has-text\("([^"]*)"\)/);
  if (hasText && !e.text.toLowerCase().includes(hasText[1]!.toLowerCase())) return false;
  // A selector this matcher can't see any recognizable test in must not match everything.
  if (!tag && !/\[[a-zA-Z-]+[*]?="/.test(trimmed) && !hasText) {
    throw new Error(`FakeProfilePage cannot parse selector: "${alt}"`);
  }
  return true;
}

function matchesSelector(e: FakeElement, selector: string): boolean {
  // Playwright's text engine ('text=/re/i' or 'text=literal') — used by SEL.noteQuotaDialog.
  if (selector.startsWith('text=')) {
    const body = selector.slice('text='.length);
    const re = body.match(/^\/(.*)\/([a-z]*)$/s);
    return re ? new RegExp(re[1]!, re[2]).test(e.text) : e.text.includes(body);
  }
  return selector.split(',').some((alt) => matchOne(e, alt));
}

/** Minimal DOM node graph for evaluate(fn): el → card (with /in/ anchor) → MAIN. */
function domNodeFor(e: FakeElement): unknown {
  const body = { tagName: 'BODY', parentElement: null, querySelector: () => null };
  const doc = { body };
  const main: Record<string, unknown> = {
    tagName: 'MAIN', parentElement: body, ownerDocument: doc, querySelector: () => null,
  };
  const card = {
    tagName: 'DIV',
    parentElement: main,
    ownerDocument: doc,
    querySelector: (sel: string) =>
      e.cardSlug && sel.includes('/in/')
        ? { getAttribute: (n: string) => (n === 'href' ? `/in/${e.cardSlug}` : null) }
        : null,
  };
  return {
    tagName: e.tag.toUpperCase(),
    parentElement: card,
    ownerDocument: doc,
    querySelector: () => null,
    getAttribute: (n: string) => e.attrs[n] ?? null,
  };
}

class FakeLocator {
  constructor(
    private page: FakeProfilePage,
    private query: (all: FakeElement[]) => FakeElement[],
  ) {}

  private els(): FakeElement[] { return this.query(this.page.currentElements()); }

  first(): FakeLocator { return new FakeLocator(this.page, (all) => this.query(all).slice(0, 1)); }

  locator(selector: string): FakeLocator {
    // Chained from a container match (e.g. SEL.overflowMenu → removeConnection): scope to
    // the zones the matched containers own.
    return new FakeLocator(this.page, (all) => {
      const zones = new Set(this.query(all).map((c) => c.attrs['data-container-for'] ?? c.zone));
      return all.filter((e) => zones.has(e.zone) && matchesSelector(e, selector));
    });
  }

  getByRole(role: string, opts: { name?: RegExp | string; expanded?: boolean } = {}): FakeLocator {
    return new FakeLocator(this.page, (all) => {
      const scoped = this.query(all);
      const zones = new Set(scoped.map((c) => c.attrs['data-container-for'] ?? c.zone));
      return all.filter((e) => {
        if (!zones.has(e.zone)) return false;
        const implicit = e.tag === 'button' ? 'button' : e.tag === 'a' ? 'link' : null;
        if ((e.attrs['role'] ?? implicit) !== role) return false;
        const accessible = e.attrs['aria-label'] || e.text;
        if (opts.name !== undefined) {
          const ok = typeof opts.name === 'string' ? accessible === opts.name : opts.name.test(accessible);
          if (!ok) return false;
        }
        if (opts.expanded !== undefined && (e.attrs['aria-expanded'] === 'true') !== opts.expanded) return false;
        return true;
      });
    });
  }

  async isVisible(): Promise<boolean> { return this.els().some((e) => e.visible); }
  async count(): Promise<number> { return this.els().length; }
  async all(): Promise<FakeLocator[]> {
    return this.els().map((e) => new FakeLocator(this.page, () => [e]));
  }
  async allInnerTexts(): Promise<string[]> { return this.els().map((e) => e.text); }
  async getAttribute(name: string): Promise<string | null> {
    return this.els()[0]?.attrs[name] ?? null;
  }
  async waitFor(opts: { state?: string; timeout?: number } = {}): Promise<void> {
    if (opts.state === 'visible' && !(await this.isVisible())) {
      throw new Error(`Timeout waiting for visible: (fake locator)`);
    }
  }
  async click(): Promise<void> {
    const target = this.els()[0];
    if (target) this.page.onClick(target);
  }
  async fill(_v: string): Promise<void> {}
  async evaluate<T>(fn: (node: never) => T): Promise<T> {
    const target = this.els()[0];
    if (!target) throw new Error('evaluate: no element');
    return fn(domNodeFor(target) as never);
  }
}

export class FakeProfilePage {
  private currentUrl: string;
  private expanded = false;
  gotoLog: string[] = [];

  constructor(private spec: FakeProfilePageSpec) { this.currentUrl = spec.url; }

  currentElements(): FakeElement[] {
    const base = (this.spec.elements ?? []).map(el);
    if (this.spec.hasMoreButton) {
      base.push(el({
        tag: 'button', text: 'More',
        attrs: { 'aria-expanded': this.expanded ? 'true' : 'false' },
        zone: 'main',
      }));
    }
    if (this.expanded) {
      base.push(el({ attrs: { role: 'menu', 'data-container-for': 'menu' }, zone: 'body' }));
      base.push(...(this.spec.overflowOnExpand ?? []).map((s) => el({ ...s, zone: 'menu' })));
    }
    return base;
  }

  onClick(target: FakeElement): void {
    if (target.text === 'More') this.expanded = true;
  }

  // --- Page surface the driver + captureEvidence touch ---
  url(): string { return this.currentUrl; }
  async title(): Promise<string> { return this.spec.title; }
  async content(): Promise<string> { return `<html><body>fake ${this.spec.title}</body></html>`; }
  async screenshot(): Promise<Buffer> { return Buffer.from('fake-png'); }
  async goto(url: string): Promise<void> { this.gotoLog.push(url); this.currentUrl = url; }

  locator(selector: string): FakeLocator {
    if (selector === 'main') {
      // A scope handle: matches nothing itself, but everything chained from it is
      // restricted to zone 'main'.
      return new FakeLocator(this, (all) =>
        [el({ attrs: { 'data-container-for': 'main' }, zone: 'main' }), ...all.filter(() => false)]);
    }
    return new FakeLocator(this, (all) => all.filter((e) => matchesSelector(e, selector)));
  }

  getByRole(role: string, opts?: { name?: RegExp | string; expanded?: boolean }): FakeLocator {
    return new FakeLocator(this, (all) => all).getByRole(role, opts ?? {});
  }

  getByText(pattern: RegExp | string): FakeLocator {
    return new FakeLocator(this, (all) => all.filter((e) =>
      typeof pattern === 'string' ? e.text.includes(pattern) : pattern.test(e.text)));
  }
}
