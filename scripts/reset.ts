// Empties the database you are connected to (the DATABASE_URL in .env), so you can replay the events from scratch:
//   npm run reset
//   npm run dev            (in another terminal)
//   npm run replay
// It refuses to run when NODE_ENV=production, as the test helper does.
import { closePool } from "../src/db.js";
import { resetDb } from "../test/helpers/db.js";

try {
  await resetDb();
  console.log("the database is empty");
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
} finally {
  await closePool();
}
