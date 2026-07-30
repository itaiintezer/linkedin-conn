import { extractProfileUrls } from './url.js';
import { looksLikeConnectionsCsv, parseConnectionsCsv } from './connections-csv.js';
import type { ConnectionInput } from '../types.js';

export interface RosterInput {
  format: 'csv' | 'urls';
  rows: ConnectionInput[];
  skipped: number;
}

/**
 * Accept either a LinkedIn Connections.csv export or a bare list of profile URLs
 * (newline/comma separated, or pasted prose containing them) and produce roster rows.
 * The CSV path additionally yields name, company, position and connected_on; the URL
 * path yields only the URL, and everything else waits for enrichment.
 */
export function parseRosterInput(text: string): RosterInput {
  if (looksLikeConnectionsCsv(text)) {
    const { rows, skipped } = parseConnectionsCsv(text);
    return { format: 'csv', rows, skipped };
  }
  return {
    format: 'urls',
    rows: extractProfileUrls(text).map((profile_url) => ({ profile_url })),
    skipped: 0,
  };
}
