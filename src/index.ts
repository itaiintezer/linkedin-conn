import { openDatabase } from './db/database.js';
import { Repos } from './db/repositories.js';
import { LinkedInDriver } from './browser/linkedin-driver.js';
import { Orchestrator } from './worker/orchestrator.js';
import { buildServer } from './api/server.js';
import { Mutex } from './core/mutex.js';
import { DB_PATH, PORT } from './config.js';

const repos = new Repos(openDatabase(DB_PATH));
const driver = new LinkedInDriver();
// One lock shared between the scheduler and the API so the periodic sender, the daily
// acceptance reader and the manual "run now" trigger never drive the browser at once.
const browserLock = new Mutex();
const orchestrator = new Orchestrator(repos, driver, browserLock);
const app = buildServer(repos, driver, browserLock);

orchestrator.start();
app
  .listen({ port: PORT, host: '127.0.0.1' })
  .then(() => {
    console.log(`LinkedIn Connector running at http://localhost:${PORT}`);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });

const shutdown = async (): Promise<void> => {
  orchestrator.stop();
  await driver.close();
  await app.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
