import pg from "pg";
import { getConfig } from "./config.js";

// bigint (type 20) comes back from pg as text. Every money column is a whole number of minor units far below
// 2^53 (amounts are capped on the way in), so a JS number is exact and the ledger can return integers.
pg.types.setTypeParser(20, (value: string) => Number(value));

let pool: pg.Pool | undefined;

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: getConfig().DATABASE_URL,
      max: 5,
      // Neon scales to zero when idle, so the first connection after a pause can be slow.
      connectionTimeoutMillis: 15_000,
      idleTimeoutMillis: 30_000,
    });
    // An idle client can be dropped by the server. Without a handler that would crash the process.
    pool.on("error", (err) => console.error("idle database client error:", err.message));
  }
  return pool;
}

export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  const p = pool;
  pool = undefined;
  await p?.end();
}
