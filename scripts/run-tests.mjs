// Node 20 has no glob for `node --test`, and npm scripts on Windows do not expand globs. So list the files here.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";

const files = readdirSync("test", { recursive: true })
  .map((f) => String(f).replaceAll("\\", "/"))
  .filter((f) => f.endsWith(".test.ts"))
  .sort()
  .map((f) => `test/${f}`);

if (!files.length) {
  console.error("no test files found in test/");
  process.exit(1);
}

// One file at a time: every test file shares the same database.
const result = spawnSync(process.execPath, ["--import", "tsx", "--test", "--test-concurrency=1", ...files], { stdio: "inherit" });
process.exit(result.status ?? 1);
