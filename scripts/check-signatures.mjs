import fs from "node:fs";
import crypto from "node:crypto";

const secret = process.env.WEBHOOK_SECRET;
if (!secret) { console.error("WEBHOOK_SECRET is not set"); process.exit(1); }

const bad = [];
let total = 0;
for (const line of fs.readFileSync("events.ndjson", "utf8").split("\n").filter(Boolean)) {
  const { event_id, signature, body } = JSON.parse(line);
  total++;
  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(body, "utf8").digest("hex");
  if (expected !== signature) bad.push(event_id);
}
console.log(`${total} deliveries, ${bad.length} with a bad signature`);
console.log(bad.join("\n"));