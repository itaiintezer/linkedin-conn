import { openDatabase, snapshotOnce } from './db/database.js';
import { Repos } from './db/repositories.js';
import { seedConnectionsFromProfiles } from './db/seed-connections.js';
import { LinkedInDriver } from './browser/linkedin-driver.js';
import { Orchestrator } from './worker/orchestrator.js';
import { buildServer } from './api/server.js';
import { Mutex } from './core/mutex.js';
import { DB_PATH, PORT } from './config.js';
import { log } from './core/log.js';

// Last-resort safety net: a stray rejection/exception (e.g. a browser launch failing in a
// background task) must be logged, not crash the whole server. The real handling lives at
// each periodic tick (see Orchestrator.handleTickError); this keeps the daemon alive if
// something slips through. Node's default for an unhandled rejection is to terminate.
process.on('unhandledRejection', (reason) => {
  log.error('app', 'unhandledRejection', { error: reason instanceof Error ? reason.message : String(reason) });
});
process.on('uncaughtException', (err) => {
  log.error('app', 'uncaughtException', { error: err instanceof Error ? err.message : String(err) });
});

const repos = new Repos(openDatabase(DB_PATH));
// One-time roster back-fill from campaign data that already proves a connection.
// No-op after the first run (gated on app_state.connections_seeded_at).
const seeded = seedConnectionsFromProfiles(repos, new Date().toISOString());
if (seeded > 0) log.info('roster', 'seeded connections from existing profiles', { seeded });

// One-time repair of names written before sanitisation existed. Cheap and idempotent after
// the first pass (it only writes rows whose value would change), and it snapshots the
// database first — but only on a run that actually has rows to repair, so a fresh install
// never copies its database to guard a migration it does not need.
const repaired = repos.connections.backfillFirstNames(
  () => { snapshotOnce(repos.db, DB_PATH, 'pre-firstname-backup'); },
);
if (repaired > 0) log.info('roster', 'repaired first names', { repaired });

const driver = new LinkedInDriver();
// One lock shared between the scheduler and the API so the periodic sender, the acceptance
// reader, the reply reader and the manual "run now" trigger never drive the browser at once.
const browserLock = new Mutex();
const orchestrator = new Orchestrator(repos, driver, browserLock);
const app = buildServer(repos, driver, browserLock);

orchestrator.start();
app
  .listen({ port: PORT, host: '127.0.0.1' })
  .then(() => {
    log.info('app', 'started', { port: PORT });
    console.log(`LinkedIn Connector running at http://localhost:${PORT}`);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });

const shutdown = async (): Promise<void> => {
  log.info('app', 'shutting down');
  orchestrator.stop();
  await driver.close();
  await app.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
