import { buildApp } from "./app.js";
import { ConfigError, getConfig } from "./config.js";
import { closePool } from "./db.js";
import { migrate } from "./migrate.js";

try {
  const config = getConfig();
  await migrate();
  const app = buildApp({ logger: true });

  const shutdown = async () => {
    await app.close();
    await closePool();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  await app.listen({ port: config.PORT, host: "0.0.0.0" });
} catch (err) {
  console.error(err instanceof ConfigError ? err.message : `startup failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
