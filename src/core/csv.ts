/**
 * Minimal RFC4180-subset CSV reader — enough for LinkedIn's Connections.csv export,
 * whose Company and Position fields routinely contain commas and quotes.
 * Handles: quoted fields, "" escapes, embedded newlines, CRLF. Drops fully blank lines
 * (LinkedIn's export has one between its preamble and the header).
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  const endField = (): void => { row.push(field); field = ''; };
  const endRow = (): void => {
    endField();
    if (row.some((c) => c !== '')) rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { quoted = false; }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === ',') { endField(); continue; }
    if (ch === '\r') continue;             // CRLF: the \n does the work
    if (ch === '\n') { endRow(); continue; }
    field += ch;
  }
  if (field !== '' || row.length > 0) endRow();
  return rows;
}
