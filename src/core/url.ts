export function normalizeProfileUrl(raw: string): string | null {
  const m = raw.match(/linkedin\.com\/in\/([A-Za-z0-9\-_%]+)/i);
  if (!m) return null;
  const slug = m[1].replace(/\/+$/, '').toLowerCase();
  if (!slug) return null;
  return `https://www.linkedin.com/in/${slug}`;
}

export function extractProfileUrls(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /https?:\/\/[^\s,"'<>]*linkedin\.com\/in\/[A-Za-z0-9\-_%]+\/?/gi;
  for (const match of text.matchAll(re)) {
    const n = normalizeProfileUrl(match[0]);
    if (n && !seen.has(n)) { seen.add(n); out.push(n); }
  }
  return out;
}
