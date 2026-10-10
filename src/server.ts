import { buildApp } from "./app.js";
import { ConfigError, getConfig } from "./config.js";
import { closePool } from "./db.js";
import { migrate } from "./migrate.js";
import { startTriage } from "./triage/start.js";
import type { Worker } from "./triage/worker.js";

try {
  const config = getConfig();
  await migrate();

  // The worker is built after the app (it logs through the app's logger), and a stored message wakes it up.
  let triage: Worker | null = null;
  const app = buildApp({ logger: true, onMessageStored: () => void triage?.kick() });

  const shutdown = async () => {
    await triage?.stop();
    await app.close();
    await closePool();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  await app.listen({ port: config.PORT, host: "0.0.0.0" });

  // Only now: the worker POSTs its replies to this service, which must be listening. It also resumes any message
  // that was still pending when the service last stopped.
  triage = startTriage(config, app.log);
  triage?.start();
} catch (err) {
  console.error(err instanceof ConfigError ? err.message : `startup failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
