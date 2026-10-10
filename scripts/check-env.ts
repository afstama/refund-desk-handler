// Says what the settings in .env look like, without ever printing a value:
//   npm run check-env
// For each setting: its length and whether it has the shape it should. Never the value itself.
import { existsSync } from "node:fs";
import { looksLikeAnthropicKey } from "../src/triage/apiKey.js";

if (!existsSync(".env")) {
  console.error("no .env file in this folder");
  process.exit(1);
}
process.loadEnvFile(".env");

interface Check {
  name: string;
  /** What the value should look like, in words, and the test for it. */
  shape: string;
  ok: (v: string) => boolean;
}

const checks: Check[] = [
  { name: "DATABASE_URL", shape: "start with postgres:// or postgresql://", ok: (v) => /^postgres(ql)?:\/\//.test(v) },
  { name: "WEBHOOK_SECRET", shape: "not be empty", ok: (v) => v.length > 0 },
  { name: "APPROVER_TOKEN", shape: "not be empty", ok: (v) => v.length > 0 },
  { name: "ANTHROPIC_API_KEY", shape: "start with sk-ant- and be a long key (about 100 characters)", ok: looksLikeAnthropicKey },
];

let bad = 0;
for (const c of checks) {
  const v = process.env[c.name];
  if (v === undefined) {
    console.log(`${c.name.padEnd(18)} MISSING`);
    bad++;
    continue;
  }
  const ok = c.ok(v);
  if (!ok) bad++;
  const notes = [/\s/.test(v) ? "has whitespace" : "", /["']/.test(v) ? "has a quote" : ""].filter(Boolean).join(", ");
  console.log(`${c.name.padEnd(18)} length ${String(v.length).padStart(3)}   ${ok ? "looks right" : `DOES NOT LOOK RIGHT: it should ${c.shape}`}${notes ? `   (${notes})` : ""}`);
}
console.log(bad ? `\n${bad} setting(s) to fix in .env` : "\nall four settings have the right shape (this does not prove the key works)");
process.exitCode = bad ? 1 : 0;
