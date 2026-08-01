# Campaign-kind validation: one source of truth, reject the unknown

**Date:** 2026-08-01
**Status:** approved for implementation
**Scope:** item 1 of a 4-item extensibility list (items 2–4 deferred — see Non-goals)

## Problem

`CampaignKind` is `'invite' | 'message'`. Three API endpoints parse a caller-supplied
`kind` with the same ternary:

```ts
const kind: CampaignKind = kindRaw === 'message' ? 'message' : 'invite';
```

This conflates two distinct cases:

- **absent** → `'invite'`. Deliberate and correct. It is the backward-compatible default,
  and `POST /api/cohorts` depends on distinguishing absent from present via
  `kindRaw !== undefined` (server.ts:288, :294).
- **present but unrecognized** → `'invite'`. A bug.

Adding a third kind to the union produces **no compile error** at any of these sites: the
else-branch is still a valid `CampaignKind`, just the wrong one. TypeScript cannot help,
because nothing here is exhaustive over the union.

The consequence is not cosmetic. `POST /api/profiles` with `kind: 'like'` would create an
`invite` row, and the sender would send a real connection request to a real person. That
action is not reversible.

A fourth site has the same shape with a milder failure. `GET /api/profiles`
(server.ts:492) filters with `if (kind === 'invite' || kind === 'message')`, so an
unrecognized kind silently means "no filter" and returns every kind instead of erroring.

Separately, `planAndAssignToday` iterates the hardcoded literal
`['invite', 'message'] as CampaignKind[]` (scheduler-service.ts:45). A new kind that is
added to the union but missed here is never scheduled at all — silently, with no error.

## Goals

1. An unrecognized `kind` fails loudly with `400` instead of being coerced.
2. Adding a kind requires editing exactly one list, and every consumer picks it up.
3. Today's behaviour for absent and valid values is preserved bit-for-bit.

## Non-goals

Deferred to when engagement actions are actually built:

- **Post-URL normalizer.** `normalizeProfileUrl` returns `null` for anything that is not
  `/in/<slug>`, so ingest rejects post URLs today.
- **Per-kind delay ranges.** `min_delay_ms`/`max_delay_ms` are global; a like should not
  hold the browser lock for 20–90s.
- **Collapsing `runSenderOnce`'s per-kind passes** into a loop over the kind list.

Also explicitly out of scope: *behavioural* branches on kind, which are a different
problem (they need per-kind policy, not input validation):

- `server.ts:196` — `p.kind === 'message' ? msg_counts : counts` buckets a third kind
  into the invite column.
- `server.ts:122`, `:129`, `:160` — `MAX_MESSAGE` vs `MAX_NOTE` length limits.
- `caps.ts:6`, `daily-budget.ts:6` — two-branch caps lookup.

No global rate cap is added. Per-kind caps remain the only ceiling, by decision.

## Design

### New module: `src/core/campaign-kind.ts`

The constant is the single source of truth; the type is derived from it, so the two can
never drift.

```ts
export const CAMPAIGN_KINDS = ['invite', 'message'] as const;
export type CampaignKind = typeof CAMPAIGN_KINDS[number];

/** Runtime membership test — the guard every boundary uses. */
export function isCampaignKind(v: unknown): v is CampaignKind;

/**
 * Parse a caller-supplied `kind`.
 *   absent (undefined)  -> { ok: true, kind: undefined }  — caller applies its default
 *   valid               -> { ok: true, kind }
 *   anything else        -> { ok: false, error }
 */
export type ParsedKind =
  | { ok: true; kind: CampaignKind | undefined }
  | { ok: false; error: string };
export function parseKind(raw: unknown): ParsedKind;
```

`undefined` means absent. Everything else that is not a member — including `null`, a
number, or an unknown string — is invalid. The web UI only ever sends `'invite'`,
`'message'`, or omits the field (app.js:946, and the cohort edit form which omits it), so
rejecting `null` breaks no existing caller.

Returning `kind: undefined` rather than defaulting inside `parseKind` is what preserves
the `/api/cohorts` "was it explicitly stated?" distinction. The default stays at each
call site, where it already lives.

### `src/types.ts`

Re-export the derived type so the ~15 existing `import type { CampaignKind } from
'../types.js'` sites are untouched:

```ts
export type { CampaignKind } from './core/campaign-kind.js';
```

types.ts already imports from `./core/checkpoint.js`, so this dependency direction is
precedented.

### Call sites

Each of the three mutating endpoints becomes:

```ts
const parsed = parseKind(kindRaw);
if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
const kind: CampaignKind = parsed.kind ?? 'invite';
```

`POST /api/cohorts` additionally replaces its two `kindRaw === undefined` /
`kindRaw !== undefined` checks with `parsed.kind === undefined` / `!== undefined`.
Same meaning, now reading from the parsed result.

`GET /api/profiles` (read-only filter) uses the guard:

```ts
if (kind !== undefined) {
  if (!isCampaignKind(kind)) return reply.code(400).send({ error: `unknown kind: ${kind}` });
  conds.push('p.kind = ?'); args.push(kind);
}
```

This is a behaviour change: an unrecognized `?kind=` now 400s instead of silently
returning all kinds. That is the point — a typo'd filter currently reports numbers that
look real.

`scheduler-service.ts:45` iterates `CAMPAIGN_KINDS` instead of the inline literal.

### Error message

`unknown kind: <value>` — the value echoed back so a typo is self-diagnosing. Matches the
existing lowercase, no-trailing-period style of `invalid linkedin profile url`.

## Testing

Unit (`tests/core/campaign-kind.test.ts`):

- `parseKind(undefined)` → `{ ok: true, kind: undefined }`
- `parseKind('invite')` / `parseKind('message')` → the kind
- `parseKind('like')`, `parseKind(null)`, `parseKind(7)`, `parseKind('')` → `ok: false`
- `isCampaignKind` accepts members, rejects non-members
- `CAMPAIGN_KINDS` contains exactly `invite` and `message`

API (`tests/api/server.test.ts`), for each of `/api/profiles`, `/api/lists`,
`/api/cohorts`:

- `kind: 'like'` → 400, and **no row or cohort is created** (the regression that matters —
  asserting the status code alone would pass even if the write still happened)
- omitted `kind` still defaults to `invite` (existing tests cover this; keep them green)
- `GET /api/profiles?kind=nonsense` → 400

Regression guard: the existing suite must pass unchanged. Any test that breaks is a
behaviour change this spec did not intend.

## Risks

- **A caller sending a bogus `kind` today gets an invite row; now it gets a 400.** That is
  the fix, but it is a breaking change for any script relying on the coercion. The web UI
  does not, and this is a single-operator self-hosted app.
- **`GET /api/profiles?kind=` now validates.** Lowest-risk of the four, but it is the one
  an operator could hit by hand-editing a URL.
