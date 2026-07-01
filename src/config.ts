import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const ROOT = join(__dirname, '..');
export const DATA_DIR = join(ROOT, 'data');
export const DB_PATH = join(DATA_DIR, 'app.db');
export const LOG_PATH = join(DATA_DIR, 'relay.log');
export const BROWSER_PROFILE_DIR = join(ROOT, '.linkedin-profile');
export const PORT = Number(process.env.PORT ?? 4400);
