// Replays events.ndjson against a running server.
//   npm run replay -- --url http://localhost:3000 [--limit 40]
import { httpSender, loadDeliveries, replay } from "../test/helpers/replay.js";

const args = process.argv.slice(2);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const url = option("--url") ?? "http://localhost:3000";
const limitArg = option("--limit");
const limit = limitArg ? Number(limitArg) : undefined;
if (limit !== undefined && !Number.isInteger(limit)) {
  console.error("--limit must be a whole number");
  process.exit(1);
}

const deliveries = await loadDeliveries();
console.log(`replaying ${limit ?? deliveries.length} of ${deliveries.length} deliveries to ${url}`);
const started = Date.now();
const results = await replay(httpSender(url), deliveries, { limit });

const byStatus = new Map<string, number>();
for (const r of results) {
  const key = r.error ? `no answer (${r.error})` : String(r.status);
  byStatus.set(key, (byStatus.get(key) ?? 0) + 1);
}
console.log(`done in ${((Date.now() - started) / 1000).toFixed(1)} s`);
for (const [status, count] of [...byStatus].sort()) console.log(`  ${status}: ${count}`);

const notOk = results.filter((r) => r.status < 200 || r.status >= 300);
if (notOk.length) {
  console.log(`non-2xx (${notOk.length}), first 20:`);
  for (const r of notOk.slice(0, 20)) console.log(`  ${r.event_id} -> ${r.error ?? r.status}`);
}
