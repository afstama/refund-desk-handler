// An independent oracle for the refund decisions. Run it to regenerate test/fixtures/expected-refunds.json:
//   npx tsx scripts/expected-refunds.ts
//
// It reads POLICY.md and Marko's answers a second time, in the simplest way possible, and replays events.ndjson
// in arrival order. It deliberately does NOT import src/policy.ts or src/apply.ts: the tests compare the service
// with this file, so the two must not share code. It only reuses classify() and signatureMatches() to read events.
import fs from "node:fs";
import { getConfig } from "../src/config.js";
import { classify } from "../src/events.js";
import { signatureMatches } from "../src/signature.js";

interface Ref { id: string; order: string; minor: number; cur: string; reason: string; at: Date }
interface Dec { order_id: string; decision: string; reason_code: string; decided_by: string; note: string | null }

const DAY = 24 * 3600 * 1000;
const ELIGIBLE = ["damaged", "wrong_item", "not_received", "missing_item"];
const PERCENT: Record<string, number> = { EUR: 100, USD: 92, GBP: 117 };
const eur = (minor: number, cur: string) => Math.floor((minor * PERCENT[cur]! + 50) / 100);

const orders = new Map<string, { total: number; cur: string; refunded: number }>();
const delivered = new Map<string, Date>();
const cancelled = new Map<string, Date>();
const parked = new Map<string, Ref[]>();
const out: Record<string, Dec> = {};
const seen = new Set<string>();

function decide(r: Ref): Omit<Dec, "order_id"> {
  const o = orders.get(r.order)!;
  const cancelledAt = cancelled.get(r.order);
  if (cancelledAt !== undefined && cancelledAt.getTime() <= r.at.getTime()) {
    return { decision: "rejected", reason_code: "ORDER_CANCELLED", decided_by: "policy", note: null };
  }
  const mismatch = r.cur !== o.cur;
  if (!mismatch && r.minor > o.total - o.refunded) return { decision: "rejected", reason_code: "EXCEEDS_BALANCE", decided_by: "policy", note: null };
  // A currency problem makes the 20 EUR rule unconfirmable: it fails at its own place in the order, not before it.
  const problem = mismatch ? "currency_mismatch" : !Object.hasOwn(PERCENT, r.cur) ? "unsupported_currency" : null;
  const d = delivered.get(r.order);
  const isDelivered = d !== undefined && d.getTime() <= r.at.getTime();
  const inWindow = isDelivered && r.at.getTime() - d!.getTime() <= 30 * DAY;
  const small = problem === null && eur(r.minor, r.cur) <= 2000;
  const eligible = ELIGIBLE.includes(r.reason);
  if (isDelivered && inWindow && small && eligible) {
    o.refunded += r.minor;
    return { decision: "auto_approved", reason_code: "AUTO_OK", decided_by: "policy", note: null };
  }
  if (!isDelivered) return { decision: "queued", reason_code: "NOT_DELIVERED", decided_by: "none", note: problem };
  if (!inWindow) return { decision: "queued", reason_code: "WINDOW_EXPIRED", decided_by: "none", note: problem };
  if (!small) return { decision: "queued", reason_code: "OVER_THRESHOLD", decided_by: "none", note: problem };
  return { decision: "queued", reason_code: "REASON_NOT_ELIGIBLE", decided_by: "none", note: null };
}

const secret = getConfig().WEBHOOK_SECRET;
for (const line of fs.readFileSync(new URL("../events.ndjson", import.meta.url), "utf8").split("\n").filter(Boolean)) {
  const d = JSON.parse(line) as { event_id: string; signature: string; body: string };
  if (!signatureMatches(secret, Buffer.from(d.body, "utf8"), d.signature)) continue;
  let body: unknown;
  try { body = JSON.parse(d.body); } catch { continue; }
  const c = classify(body);
  if (!c.ok) continue;
  const e = c.event;
  if (e.kind === "order.created") {
    if (orders.has(e.orderId)) continue;
    orders.set(e.orderId, { total: e.totalMinor, cur: e.currency, refunded: 0 });
    for (const r of (parked.get(e.orderId) ?? []).sort((a, b) => a.at.getTime() - b.at.getTime() || a.id.localeCompare(b.id))) {
      out[r.id] = { order_id: r.order, ...decide(r) };
    }
    parked.delete(e.orderId);
  } else if (e.kind === "shipment.delivered") {
    if (!delivered.has(e.orderId)) delivered.set(e.orderId, e.occurredAt);
  } else if (e.kind === "order.cancelled") {
    if (!cancelled.has(e.orderId)) cancelled.set(e.orderId, e.occurredAt);
  } else if (e.kind === "refund.requested") {
    if (seen.has(e.refundId)) continue;
    seen.add(e.refundId);
    const r: Ref = { id: e.refundId, order: e.orderId, minor: e.amountMinor, cur: e.currency, reason: e.reason, at: e.occurredAt };
    if (orders.has(r.order)) out[r.id] = { order_id: r.order, ...decide(r) };
    else {
      out[r.id] = { order_id: r.order, decision: "parked", reason_code: "ORDER_UNKNOWN", decided_by: "none", note: null };
      parked.set(r.order, [...(parked.get(r.order) ?? []), r]);
    }
  }
}

const refunds = Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
const refundedMinor = Object.fromEntries([...orders].filter(([, o]) => o.refunded > 0).sort(([a], [b]) => a.localeCompare(b)).map(([id, o]) => [id, o.refunded]));
const file = new URL("../test/fixtures/expected-refunds.json", import.meta.url);
fs.mkdirSync(new URL("../test/fixtures/", import.meta.url), { recursive: true });
fs.writeFileSync(file, JSON.stringify({ refunds, refunded_minor: refundedMinor }, null, 2) + "\n");

const tally: Record<string, number> = {};
for (const r of Object.values(refunds)) tally[`${r.decision}/${r.reason_code}`] = (tally[`${r.decision}/${r.reason_code}`] ?? 0) + 1;
console.log(`${Object.keys(refunds).length} refunds written to test/fixtures/expected-refunds.json`, tally);
