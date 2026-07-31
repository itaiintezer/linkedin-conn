import type { ApifyProfile, ApifyPosition, EnrichedProfile } from '../types.js';
import { firstNameFrom } from './first-name.js';

/** Trim to a non-empty string, or null. Everything downstream expects null, not ''. */
const str = (v: unknown): string | null => {
  const s = typeof v === 'string' ? v.trim() : '';
  return s === '' ? null : s;
};

/** Items in skills/languages arrive as either bare strings or `{ name }` objects. */
const nameOf = (x: unknown): string | null => {
  if (typeof x === 'string') return str(x);
  if (x && typeof x === 'object') return str((x as { name?: unknown }).name);
  return null;
};

const names = (items: unknown, limit: number): string[] =>
  Array.isArray(items) ? items.map(nameOf).filter((v): v is string => v !== null).slice(0, limit) : [];

/** Apify uses `position` for the role title; `title` is a forward-compat fallback. */
const roleTitle = (p: ApifyPosition | null | undefined): string | null =>
  p ? str(p.position) ?? str(p.title) : null;

/** Dates arrive as a string, or as `{ text, year, month }`. */
const dateText = (d: unknown): string | null => {
  if (typeof d === 'string') return str(d);
  if (d && typeof d === 'object') {
    const o = d as { text?: unknown; year?: unknown };
    return str(o.text) ?? (o.year != null ? String(o.year) : null);
  }
  return null;
};

/** A nested location can be a string or `{ linkedinText | text | country }`. */
const locText = (loc: unknown): string | null => {
  if (typeof loc === 'string') return str(loc);
  if (loc && typeof loc === 'object') {
    const o = loc as { linkedinText?: unknown; text?: unknown; country?: unknown };
    return str(o.linkedinText) ?? str(o.text) ?? str(o.country);
  }
  return null;
};

/**
 * Apify's "silent empty" failure: HTTP 200 with a valid-shaped payload where every
 * meaningful field is null. Declared empty ONLY when all identifying signals are missing,
 * so a sparse-but-real profile (a headline and nothing else) is not falsely discarded.
 * Ported from `apify_linkedin.py::is_empty_profile`.
 */
export function isEmptyProfile(raw: ApifyProfile | null | undefined): boolean {
  if (!raw || typeof raw !== 'object') return true;
  const name = `${raw.firstName ?? ''}${raw.lastName ?? ''}${raw.name ?? ''}`.trim();
  return !name
    && !str(raw.headline)
    && !str(raw.about)
    && !(raw.experience?.length)
    && !(raw.education?.length)
    && !(raw.skills?.length);
}

interface LocationParts {
  raw: string | null; city: string | null; region: string | null;
  country: string | null; countryCode: string | null;
}

/**
 * Read the location.
 *
 * Apify PRE-PARSES this into city/state/country/ISO-code and resolves metro-area names
 * ("Greater Leeds Area" → Leeds / England / GB), verified live 2026-07-31. We take those
 * fields verbatim.
 *
 * When `location` is a bare string (older payload shape) we keep it as `raw` and populate
 * nothing else — deliberately. Measured across 6,333 real profiles, the display string is
 * `City, Region, Country` only 67.2% of the time; 29.6% are single-segment metro names and
 * 3.2% are two-segment forms where the second part is a COUNTRY ("Delhi, India"). Splitting
 * positionally would file India as a region. A null beats a wrong value: `raw` still reaches
 * the FTS document, so those people remain findable by text.
 */
function readLocation(loc: ApifyProfile['location']): LocationParts {
  const empty: LocationParts = { raw: null, city: null, region: null, country: null, countryCode: null };
  if (!loc) return empty;
  if (typeof loc === 'string') return { ...empty, raw: str(loc) };

  const p = loc.parsed ?? null;
  return {
    raw: str(loc.linkedinText) ?? str(p?.text),
    city: str(p?.city),
    region: str(p?.state),
    // `country` is sometimes an abbreviation ("UK"); countryFull is the display name.
    country: str(p?.countryFull) ?? str(p?.country),
    countryCode: str(p?.countryCode) ?? str(loc.countryCode),
  };
}

function trimExperience(items: unknown, limit = 12): Record<string, unknown>[] {
  if (!Array.isArray(items)) return [];
  return items.slice(0, limit).filter((e): e is ApifyPosition => !!e && typeof e === 'object').map((e) => ({
    title: roleTitle(e),
    companyName: str(e.companyName),
    employmentType: str(e.employmentType),
    location: locText(e.location),
    duration: str(e.duration),
    startDate: dateText(e.startDate),
    endDate: dateText(e.endDate),
    description: str(e.description),
  }));
}

function trimEducation(items: unknown): Record<string, unknown>[] {
  if (!Array.isArray(items)) return [];
  return items.filter((e) => !!e && typeof e === 'object').map((e) => {
    const o = e as Record<string, unknown>;
    return {
      schoolName: str(o.schoolName) ?? str(o.school),
      degree: str(o.degree),
      fieldOfStudy: str(o.fieldOfStudy),
      startDate: dateText(o.startDate),
      endDate: dateText(o.endDate),
    };
  });
}

function trimCertifications(items: unknown): Record<string, unknown>[] {
  if (!Array.isArray(items)) return [];
  return items.filter((e) => !!e && typeof e === 'object').map((e) => {
    const o = e as Record<string, unknown>;
    return { name: str(o.name) ?? str(o.title), authority: str(o.authority) ?? str(o.issuer) };
  });
}

/**
 * Everything search must be able to reach, flattened into one document.
 *
 * Past roles are included on purpose: `title_any` defaults to current title + headline, but
 * `include_past_roles` widens to history, and free-text `q` should always find "ever worked
 * at Amazon". Newline-joined so FTS5 tokenizes cleanly across field boundaries.
 */
function buildDoc(p: Omit<EnrichedProfile, 'doc'>, raw: ApifyProfile): string {
  const parts: (string | null)[] = [
    p.full_name, p.headline,
    p.location_raw, p.location_city, p.location_region, p.location_country,
    str(raw.about),
  ];
  for (const e of p.compact.experience as Record<string, unknown>[]) {
    parts.push(e.title as string | null, e.companyName as string | null, e.description as string | null);
  }
  for (const e of p.compact.education as Record<string, unknown>[]) {
    parts.push(e.schoolName as string | null, e.degree as string | null, e.fieldOfStudy as string | null);
  }
  parts.push(...(p.compact.skills as string[]));
  parts.push(...(p.compact.topSkills as string[]));
  for (const c of p.compact.certifications as Record<string, unknown>[]) {
    parts.push(c.name as string | null);
  }
  return parts.filter((s): s is string => !!s && s.trim() !== '').join('\n');
}

/**
 * Turn a raw Apify payload into indexed scalars, a compact stored payload, and the FTS
 * document. Pure and total: a malformed payload yields nulls, never a throw — the worker
 * treats a bad shape as data, not as an outage.
 */
export function extractProfile(raw: ApifyProfile): EnrichedProfile {
  const first = str(raw.firstName);
  const last = str(raw.lastName);
  const fullName = str(raw.name) ?? ([first, last].filter(Boolean).join(' ') || null);

  const current = (Array.isArray(raw.currentPosition) ? raw.currentPosition[0] : null)
    ?? (Array.isArray(raw.experience) ? raw.experience[0] : null);

  const loc = readLocation(raw.location);

  const compact: Record<string, unknown> = {
    name: fullName,
    // Kept verbatim so the sanitised first_name column can always be recomputed or undone.
    firstNameRaw: first,
    lastNameRaw: last,
    headline: str(raw.headline),
    about: str(raw.about),
    location: loc.raw,
    linkedinUrl: str(raw.linkedinUrl),
    publicIdentifier: str(raw.publicIdentifier),
    currentPosition: Array.isArray(raw.currentPosition) ? trimExperience(raw.currentPosition, 3) : [],
    experience: trimExperience(raw.experience),
    education: trimEducation(raw.education),
    skills: names(raw.skills, 40),
    topSkills: names(raw.topSkills, 10),
    certifications: trimCertifications(raw.certifications),
    languages: names(raw.languages, 10),
  };

  const base: Omit<EnrichedProfile, 'doc'> = {
    linkedin_id: str(raw.id),
    public_identifier: str(raw.publicIdentifier),
    full_name: fullName,
    // Sanitised at WRITE time so the column is trustworthy everywhere it is read.
    // Apify's own firstName is a display fragment ("Darrell J.", "🪐 Leonardo"), so it is a
    // candidate, not an answer; the full name is the fallback.
    first_name: firstNameFrom(first) ?? firstNameFrom(fullName),
    last_name: last,
    headline: str(raw.headline),
    location_raw: loc.raw,
    location_city: loc.city,
    location_region: loc.region,
    location_country: loc.country,
    location_country_code: loc.countryCode,
    current_title: roleTitle(current),
    current_company: current ? str(current.companyName) : null,
    compact,
  };

  return { ...base, doc: buildDoc(base, raw) };
}
