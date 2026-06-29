import { openDatabase } from './db/database.js';
import { Repos } from './db/repositories.js';
import { LinkedInDriver } from './browser/linkedin-driver.js';
import { Orchestrator } from './worker/orchestrator.js';
import { buildServer } from './api/server.js';
import { DB_PATH, PORT } from './config.js';

const repos = new Repos(openDatabase(DB_PATH));
const driver = new LinkedInDriver();
const orchestrator = new Orchestrator(repos, driver);
const app = buildServer(repos, driver);

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
