// Dev helper: reset all profiles back to 'queued' and clear any pause, so a fresh
// send attempt can be triggered. DB-only, no network. Run: npx tsx scripts/reset-queue.ts
import { openDatabase } from '../src/db/database.js';
import { DB_PATH } from '../src/config.js';

const db = openDatabase(DB_PATH);
const r = db
  .prepare("UPDATE profiles SET status='queued', scheduled_for=NULL, sent_at=NULL, accepted_at=NULL, resolved_at=NULL, last_error=NULL, attempts=0")
  .run();
db.prepare("UPDATE settings SET paused=0, pause_reason=NULL WHERE id=1").run();
console.log('profiles reset to queued:', r.changes);
