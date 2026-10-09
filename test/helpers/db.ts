import { getConfig } from "../../src/config.js";
import { getPool } from "../../src/db.js";
import { migrate } from "../../src/migrate.js";

export const TABLES = ["events", "dead_letter", "orders", "order_events", "refunds", "messages"] as const;

/** Makes sure the schema exists, then empties every table. Never runs in production. */
export async function resetDb(): Promise<void> {
  getConfig(); // loads .env first, so NODE_ENV from there is seen by the check below
  if (process.env.NODE_ENV === "production") {
    throw new Error("resetDb refused: NODE_ENV=production");
  }
  await migrate();
  await getPool().query(`TRUNCATE ${TABLES.join(", ")} RESTART IDENTITY`);
}
