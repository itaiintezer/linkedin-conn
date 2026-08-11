import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const ROOT = join(__dirname, '..');
/**
 * THEMACHINE_DATA_DIR is set by scripts/supervisor.mjs (to the same place by default, so
 * production is unchanged) and is what lets a test harness point the whole app at a temp folder.
 * Without it every path below is a module constant, and a harness writing "test" rows ends up
 * appending to the real data/relay.log — which has happened.
 */
export const DATA_DIR = process.env.THEMACHINE_DATA_DIR ?? join(ROOT, 'data');
export const DB_PATH = join(DATA_DIR, 'app.db');
export const LOG_PATH = join(DATA_DIR, 'relay.log');
export const INCIDENTS_DIR = join(DATA_DIR, 'incidents');
export const BROWSER_PROFILE_DIR = join(ROOT, '.linkedin-profile');
export const PORT = Number(process.env.PORT ?? 4400);
