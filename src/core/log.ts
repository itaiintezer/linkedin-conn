import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from './logger.js';
import { LOG_PATH } from '../config.js';

// Most workers/api routes log through this shared singleton with no way to inject a
// test logger, so importing them under vitest — which every test file that touches the
// worker/api layer does — silently wrote real entries into the production relay.log.
// Redirect to a scratch file instead: vitest sets process.env.VITEST for the whole run.
const path = process.env.VITEST ? join(tmpdir(), 'linkedin-conn-test.log') : LOG_PATH;

/** Process-wide logger. Import this everywhere except tests (which build their own). */
export const log = createLogger(path, { echo: !process.env.VITEST });
