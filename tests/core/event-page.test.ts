import { describe, it, expect } from 'vitest';
import {
  eventUrnFrom, hasStarted, MEMBER_URN_PATTERN, normalizeEventUrl, parseEventStart,
} from '../../src/core/event-page.js';

describe('normalizeEventUrl', () => {
  it('canonicalises the plain form', () => {
    expect(normalizeEventUrl('https://www.linkedin.com/events/7486088214579982336/'))
      .toBe('https://www.linkedin.com/events/7486088214579982336/');
  });

  it('accepts a slugged url, query string, or missing scheme', () => {
    for (const raw of [
      'https://www.linkedin.com/events/nyc-forum-sales-ops-7486088214579982336/',
      'https://www.linkedin.com/events/7486088214579982336?utm=x',
      'linkedin.com/events/7486088214579982336',
      '  https://LinkedIn.com/events/7486088214579982336/comments/  ',
    ]) {
      expect(normalizeEventUrl(raw)).toBe('https://www.linkedin.com/events/7486088214579982336/');
    }
  });

  it('rejects anything that is not an event url', () => {
    expect(normalizeEventUrl('https://www.linkedin.com/in/keren-tevet-3453a079')).toBeNull();
    expect(normalizeEventUrl('https://www.linkedin.com/events/')).toBeNull();
    expect(normalizeEventUrl('')).toBeNull();
  });

  it('extracts the urn', () => {
    expect(eventUrnFrom('https://www.linkedin.com/events/7486088214579982336/'))
      .toBe('7486088214579982336');
    expect(eventUrnFrom('nonsense')).toBeNull();
  });
});

describe('parseEventStart', () => {
  it('parses the live top-card format', () => {
    // Exactly what the page rendered on 2026-08-01.
    const d = parseEventStart('Thu, Sep 10, 2026, 6:15 PM - 10:30 PM (your local time)')!;
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(8);
    expect(d.getDate()).toBe(10);
    expect(d.getHours()).toBe(18);
    expect(d.getMinutes()).toBe(15);
  });

  it('handles midnight and noon correctly', () => {
    expect(parseEventStart('Mon, Jan 5, 2026, 12:00 AM')!.getHours()).toBe(0);
    expect(parseEventStart('Mon, Jan 5, 2026, 12:30 PM')!.getHours()).toBe(12);
  });

  it('falls back to midnight when only a date is shown', () => {
    const d = parseEventStart('Sat, Jul 18, 2026')!;
    expect(d.getHours()).toBe(0);
    expect(d.getDate()).toBe(18);
  });

  it('refuses a relative date rather than guessing', () => {
    // "Today, 11:00 PM" is what the SIDEBAR event cards render. Accepting it would stamp
    // a neighbouring event's date onto this campaign — and that date decides when the
    // campaign stops inviting.
    expect(parseEventStart('Today, 11:00 PM Snowdon at Night Trek 2026')).toBeNull();
    expect(parseEventStart('Tomorrow, 9:00 AM')).toBeNull();
  });

  it('rejects impossible dates and times', () => {
    expect(parseEventStart('Feb 31, 2026, 1:00 PM')).toBeNull();
    expect(parseEventStart('Sep 10, 2026, 13:00 PM')).toBeNull();
    expect(parseEventStart('Xyz 10, 2026, 1:00 PM')).toBeNull();
  });

  it('returns null for junk', () => {
    expect(parseEventStart('')).toBeNull();
    expect(parseEventStart('Online')).toBeNull();
  });
});

describe('hasStarted', () => {
  const now = new Date('2026-08-01T12:00:00');

  it('is true once the start has passed', () => {
    expect(hasStarted(new Date('2026-07-31T12:00:00').toISOString(), now)).toBe(true);
  });

  it('is false for a future event', () => {
    expect(hasStarted(new Date('2026-09-10T18:15:00').toISOString(), now)).toBe(false);
  });

  it('treats an unknown or unparseable start as NOT started', () => {
    // Closing a campaign because we failed to scrape a date would be the wrong failure.
    expect(hasStarted(null, now)).toBe(false);
    expect(hasStarted('not a date', now)).toBe(false);
  });
});

describe('MEMBER_URN_PATTERN', () => {
  // This exact string is interpolated into the driver's page.evaluate bodies, so what is
  // asserted here is the regex that actually runs — not a lookalike beside it.
  const match = (id: string) => id.match(new RegExp(MEMBER_URN_PATTERN))?.[1] ?? null;

  it('extracts the urn a picker checkbox id embeds', () => {
    expect(match('i18n_checkbox-invitee-suggestion-ACoAAAAADsYBhEcQ-lPhi_BSb3OdkkJtYQPZHgA'))
      .toBe('ACoAAAAADsYBhEcQ-lPhi_BSb3OdkkJtYQPZHgA');
  });

  it('keeps the hyphens and underscores LinkedIn puts in a urn', () => {
    expect(match('x-ACoAABeay8cBDzhFD8ZAeOgksWH8xKhfgJE-k6o'))
      .toBe('ACoAABeay8cBDzhFD8ZAeOgksWH8xKhfgJE-k6o');
  });

  it('finds nothing in an id that carries no urn', () => {
    expect(match('ember195')).toBeNull();
    expect(match('invitee-picker-results-container')).toBeNull();
  });
});
