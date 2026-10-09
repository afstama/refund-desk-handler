import { readdir, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import type pg from "pg";
import { closePool, getPool } from "./db.js";

const migrationsDir = new URL("../migrations/", import.meta.url);

/** Applies migrations/NNN_*.sql that are not recorded yet. Returns the names applied. */
export async function migrate(pool: pg.Pool = getPool()): Promise<string[]> {
  const files = (await readdir(migrationsDir)).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
  const applied: string[] = [];
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Transaction-level lock: safe behind Neon's pooler, and two instances starting together run one after the other.
    await client.query("SELECT pg_advisory_xact_lock(727001)");
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const done = new Set((await client.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
    for (const file of files) {
      if (done.has(file)) continue;
      await client.query(await readFile(new URL(file, migrationsDir), "utf8"));
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
      applied.push(file);
    }
    await client.query("COMMIT");
    return applied;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// `npm run migrate`
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const applied = await migrate();
    console.log(applied.length ? `applied: ${applied.join(", ")}` : "nothing to apply");
  } catch (err) {
    console.error("migration failed:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}
