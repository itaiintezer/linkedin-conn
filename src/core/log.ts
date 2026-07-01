import { createLogger } from './logger.js';
import { LOG_PATH } from '../config.js';

/** Process-wide logger. Import this everywhere except tests (which build their own). */
export const log = createLogger(LOG_PATH);
