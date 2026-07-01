import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../config.js';

const REGISTRY: Record<string, string> = { api: 'API.md' };

function firstHeading(markdown: string): string | null {
  const m = markdown.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : null;
}

export interface DocMeta { slug: string; title: string; }
export interface Doc extends DocMeta { markdown: string; }

export function listDocs(root: string = ROOT): DocMeta[] {
  return Object.entries(REGISTRY)
    .filter(([, file]) => existsSync(join(root, file)))
    .map(([slug, file]) => ({ slug, title: firstHeading(readFileSync(join(root, file), 'utf8')) ?? slug }));
}

export function readDoc(slug: string, root: string = ROOT): Doc | null {
  const file = REGISTRY[slug];
  if (!file) return null;
  const path = join(root, file);
  if (!existsSync(path)) return null;
  const markdown = readFileSync(path, 'utf8');
  return { slug, title: firstHeading(markdown) ?? slug, markdown };
}
