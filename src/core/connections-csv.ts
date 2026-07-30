import { parseCsv } from './csv.js';
import { normalizeProfileUrl } from './url.js';
import type { ConnectionInput } from '../types.js';

const MONTHS: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

/**
 * LinkedIn writes "Connected On" as "04 Mar 2024". Some exports use an ISO date.
 * Anything else returns null — a wrong connection date is worse than none, and this
 * column is the ONLY source of connected_on we will ever have (Apify does not return it).
 */
export function parseConnectedOn(raw: string | undefined | null): string | null {
  const s = (raw ?? '').trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})$/);
  if (!m) return null;
  const month = MONTHS[m[2].toLowerCase()];
  if (!month) return null;
  return `${m[3]}-${month}-${m[1].padStart(2, '0')}`;
}

/** Index of the header row (the first row carrying a "URL" column), or -1. */
function findHeaderRow(rows: string[][]): number {
  return rows.findIndex((r) => {
    const cells = r.map((c) => c.trim().toLowerCase());
    return cells.includes('url') && (cells.includes('first name') || cells.includes('last name'));
  });
}

/** True if the text is a LinkedIn Connections export rather than a bare URL list. */
export function looksLikeConnectionsCsv(text: string): boolean {
  return findHeaderRow(parseCsv(text)) !== -1;
}

export interface ConnectionsCsvResult {
  rows: ConnectionInput[];
  /** Data rows dropped because they had no usable LinkedIn profile URL. */
  skipped: number;
}

/**
 * Parse a LinkedIn Connections.csv export. Columns are mapped by header NAME, not
 * position — LinkedIn has reordered and added columns before, and an export missing
 * "Email Address" is common. The preamble ("Notes:", a quoted paragraph, a blank line)
 * is skipped by scanning for the header row rather than assuming a fixed offset.
 */
export function parseConnectionsCsv(text: string): ConnectionsCsvResult {
  const table = parseCsv(text);
  const headerIdx = findHeaderRow(table);
  if (headerIdx === -1) {
    throw new Error('No Connections.csv header row found (expected a "URL" column alongside "First Name"/"Last Name")');
  }
  const header = table[headerIdx].map((c) => c.trim().toLowerCase());
  const col = (name: string): number => header.indexOf(name);
  const iUrl = col('url');
  const iFirst = col('first name');
  const iLast = col('last name');
  const iCompany = col('company');
  const iPosition = col('position');
  const iConnected = col('connected on');
  const cell = (row: string[], i: number): string | null => {
    if (i === -1) return null;
    const v = (row[i] ?? '').trim();
    return v === '' ? null : v;
  };

  const rows: ConnectionInput[] = [];
  let skipped = 0;
  for (const row of table.slice(headerIdx + 1)) {
    const url = normalizeProfileUrl(row[iUrl] ?? '');
    if (!url) { skipped++; continue; }
    const first = cell(row, iFirst);
    const last = cell(row, iLast);
    rows.push({
      profile_url: url,
      first_name: first,
      last_name: last,
      full_name: [first, last].filter(Boolean).join(' ') || null,
      current_company: cell(row, iCompany),
      current_title: cell(row, iPosition),
      connected_on: parseConnectedOn(cell(row, iConnected)),
    });
  }
  return { rows, skipped };
}
