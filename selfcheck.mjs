#!/usr/bin/env node
// Public smoke test shipped to candidates. Node 20+, no dependencies.
// Sends the first 40 events and checks the SHAPE of GET /ledger. It does not check your refund decisions.
import fs from "node:fs";

const url = (process.argv.includes("--url") ? process.argv[process.argv.indexOf("--url") + 1] : "http://localhost:3000").replace(/\/$/, "");
const lines = fs.readFileSync(new URL("./events.ndjson", import.meta.url), "utf8").split("\n").filter(Boolean).slice(0, 40);

let failed = 0;
const fail = (m) => { failed++; console.log("  ✗ " + m); };
const ok = (m) => console.log("  ✓ " + m);
const stop = (m) => { console.log("  ✗ " + m + "\n"); process.exit(1); };

// Is anything there at all? A clear sentence beats a stack trace.
try {
  await fetch(url + "/ledger", { signal: AbortSignal.timeout(5000) });
} catch (e) {
  stop(`Nothing answered at ${url} (${e.name === "TimeoutError" ? "timed out" : e.cause?.code || e.message}). Start your service, or pass --url.`);
}

for (const line of lines) {
  const { event_id, signature, body } = JSON.parse(line);
  const res = await fetch(url + "/webhooks", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Event-Id": event_id, "X-Signature": signature },
    body,
    signal: AbortSignal.timeout(3000),
  }).catch((e) => ({ status: e.name }));
  if (!(res.status >= 200 && res.status < 300)) fail(`${event_id} → ${res.status} (expected 2xx)`);
}
if (!failed) ok("40 events accepted with 2xx inside 3 seconds each");

const res = await fetch(url + "/ledger");
if (!(res.status >= 200 && res.status < 300)) stop(`GET /ledger answered ${res.status}. It must answer 200 with the JSON in CONTRACT.md.`);
const body = await res.text();
let ledger;
try { ledger = JSON.parse(body); } catch { stop(`GET /ledger did not return JSON. First 80 characters: ${JSON.stringify(body.slice(0, 80))}`); }
if (!ledger || typeof ledger !== "object" || Array.isArray(ledger)) stop("GET /ledger must return a JSON object.");
const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
for (const k of ["orders", "refunds", "messages"]) isObj(ledger[k]) ? ok(`ledger.${k} is an object`) : fail(`ledger.${k} must be an object keyed by id`);
Array.isArray(ledger.dead_letter) ? ok("ledger.dead_letter is an array") : fail("ledger.dead_letter must be an array");
for (const k of ["duplicates_ignored", "unknown_types_acked"]) Number.isInteger(ledger[k]) ? ok(`ledger.${k} is an integer`) : fail(`ledger.${k} must be an integer`);

const orders = Object.entries(ledger.orders || {});
orders.length === 28 ? ok("28 orders in the ledger") : fail(`expected 28 orders after 40 events, found ${orders.length}`);
for (const [id, o] of orders) {
  if (!["created", "delivered", "cancelled"].includes(o.status)) fail(`${id}.status "${o.status}" is not in the contract`);
  if (!Number.isInteger(o.total_minor)) fail(`${id}.total_minor must be integer cents`);
  if (!Number.isInteger(o.refunded_minor)) fail(`${id}.refunded_minor must be integer cents`);
}
console.log(failed ? `\n${failed} problem(s). The contract is not wired correctly yet.` : "\nShape looks right. Your refund decisions are NOT checked here.");
process.exit(failed ? 1 : 0);
