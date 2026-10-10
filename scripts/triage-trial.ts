// The trial: the real triage code on the 83 distinct messages of events.ndjson, measured.
//
//   npx tsx scripts/triage-trial.ts --model claude-haiku-5-5            dry run: lists the plan and the estimate, calls nothing
//   npx tsx scripts/triage-trial.ts --model claude-haiku-5-5 --live     CALLS THE MODEL and spends money (asks you to confirm)
//   npx tsx scripts/triage-trial.ts --model claude-haiku-5-5 --fake     no network, no money: a keyword stand-in, to try the script
//   options: --limit N (the first N messages), --ids M-0013,M-0014
//
// It does not use the database and does not send anything anywhere: a reply is only counted ("would be sent").
// Spend is capped three ways: this run at RUN_LIMIT_USD, all trial runs together at TOTAL_LIMIT_USD (recorded in
// .trial-spend.json, not committed), and the 5 USD ceiling of the service is not involved. A live run also needs you
// to type a confirmation in a terminal, so it cannot be started by a script.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { getConfig } from "../src/config.js";
import { bodyIdProblem, classify } from "../src/events.js";
import { signatureMatches } from "../src/signature.js";
import { createAnthropicModel } from "../src/triage/anthropic.js";
import { looksLikeAnthropicKey } from "../src/triage/apiKey.js";
import { refundWords } from "../src/triage/guards.js";
import { createRateLimiter } from "../src/triage/limiter.js";
import { ModelError, type TriageModel } from "../src/triage/model.js";
import { costMicros, hasPrice, microsToUsd, PRICES, usdToMicros } from "../src/triage/pricing.js";
import { createWorker } from "../src/triage/worker.js";
import { fakeSender, fakeStore } from "../test/helpers/fakeTriage.js";

const RUN_LIMIT_USD = 1;
const TOTAL_LIMIT_USD = 3;
const SPEND_FILE = new URL("../.trial-spend.json", import.meta.url);
const KEY_FILE = new URL("../test/fixtures/triage-answer-key.json", import.meta.url);
const EVENTS_FILE = new URL("../events.ndjson", import.meta.url);
const OUT_DIR = new URL("../scripts/out/", import.meta.url);

// ---- arguments ----
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const value = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const modelName = value("--model") ?? "claude-haiku-5-5";
const live = flag("--live");
const fake = flag("--fake");
const limit = value("--limit") ? Number(value("--limit")) : undefined;
const onlyIds = value("--ids")?.split(",").map((s) => s.trim());

function die(message: string): never {
  console.error(message);
  process.exit(1);
}
if (live && fake) die("--live and --fake exclude each other");
if (!hasPrice(modelName)) die(`no price known for ${modelName}; known: ${Object.keys(PRICES).join(", ")}`);

// ---- the messages: the ones the service would triage (valid signature, valid event), first delivery of each ----
interface TrialMessage {
  id: string;
  channel: string;
  text: string;
  orderId: string | null;
}
function loadMessages(): TrialMessage[] {
  const secret = getConfig().WEBHOOK_SECRET;
  const seen = new Set<string>();
  const out: TrialMessage[] = [];
  for (const line of readFileSync(EVENTS_FILE, "utf8").split("\n").filter(Boolean)) {
    const d = JSON.parse(line) as { event_id: string; signature: string; body: string };
    if (!signatureMatches(secret, Buffer.from(d.body, "utf8"), d.signature)) continue;
    let json: unknown;
    try {
      json = JSON.parse(d.body);
    } catch {
      continue;
    }
    if (bodyIdProblem(json, d.event_id)) continue;
    const c = classify(json);
    if (!c.ok || c.event.kind !== "message.received") continue;
    if (seen.has(c.event.messageId)) continue;
    seen.add(c.event.messageId);
    out.push({ id: c.event.messageId, channel: c.event.channel, text: c.event.text, orderId: c.event.orderId });
  }
  return out;
}

// ---- the answer key ----
interface KeyEntry {
  category: string;
  also_ok?: string[];
  sentiment: string;
  sentiment_also_ok?: string[];
  injection: boolean;
  note?: string;
}
const key: Record<string, KeyEntry> = existsSync(KEY_FILE) ? JSON.parse(readFileSync(KEY_FILE, "utf8")).messages : {};

// ---- a stand-in for --fake: keywords, not Claude ----
const fakeModel: TriageModel = async ({ text }) => {
  const t = text.toLowerCase();
  const injection = /ignore all previous|already approved/.test(t);
  const refund = /refund|money back|chargeback|charged|reverse/.test(t);
  const category = refund ? "refund_related" : /ship|processing|tracking|delivery|order/.test(t) ? "order_status" : /safe|vegan|cast|use the|stock|rosacea/.test(t) ? "product_question" : /five stars|obsessed|thank|best thing|love/.test(t) ? "praise" : /broke|excessive|took|pump|frustrat|disappoint/.test(t) ? "complaint" : "other";
  const sentiment = /five stars|obsessed|thank|love|best|👍/.test(t) ? "positive" : /broke|excessive|took|frustrat|disappoint|money back|chargeback/.test(t) ? "negative" : "neutral";
  return {
    kind: "ok",
    output: { category, sentiment, draft_reply: "Thank you for your message, our team will get back to you.", injection_suspected: injection } as never,
    usage: { input_tokens: 500 + Math.ceil(text.length / 4), output_tokens: 60 },
  };
};

// ---- spend record ----
interface SpendRun {
  at: string;
  model: string;
  messages: number;
  calls: number;
  micros: number;
}
function readSpend(): SpendRun[] {
  try {
    return JSON.parse(readFileSync(SPEND_FILE, "utf8")).runs as SpendRun[];
  } catch {
    return [];
  }
}
const spentBefore = readSpend().reduce((s, r) => s + r.micros, 0);

async function confirm(prompt: string, expected: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string | null>((resolve) => {
    rl.once("close", () => resolve(null));
    rl.question(prompt, (a) => resolve(a));
  });
  rl.close();
  return answer?.trim() === expected;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

async function main() {
  let messages = loadMessages();
  if (onlyIds) messages = messages.filter((m) => onlyIds.includes(m.id));
  if (limit) messages = messages.slice(0, limit);
  if (messages.length === 0) die("no messages selected");

  // a rough estimate for the plan: about 800 input and 150 output tokens per message
  const estimate = messages.length * costMicros(modelName, 800, 150);
  console.log(`model: ${modelName}   messages: ${messages.length}   mode: ${live ? "LIVE (spends money)" : fake ? "fake stand-in (no money)" : "dry run (calls nothing)"}`);
  console.log(`estimated cost for this run: about ${microsToUsd(estimate)}   limits: ${RUN_LIMIT_USD} USD this run, ${TOTAL_LIMIT_USD} USD all trial runs (already recorded: ${microsToUsd(spentBefore)})`);
  if (!live && !fake) {
    console.log("dry run: nothing was called. Add --live to run it for real, or --fake to try the script without the model.");
    return;
  }

  if (live) {
    if (!looksLikeAnthropicKey(getConfig().ANTHROPIC_API_KEY)) {
      die("ANTHROPIC_API_KEY in .env does not look like an Anthropic key (it should start with sk-ant-). Fix .env; `npm run check-env` shows the shape of each setting and never a value. Nothing was called.");
    }
    if (spentBefore >= usdToMicros(TOTAL_LIMIT_USD)) die(`the trial runs together already reached ${TOTAL_LIMIT_USD} USD: not starting`);
    const phrase = `yes, spend up to ${RUN_LIMIT_USD} USD on ${modelName}`;
    const ok = await confirm(`This calls the real model. Type exactly: ${phrase}\n> `, phrase);
    if (!ok) die("not confirmed (a live run needs the confirmation typed in a terminal): nothing was called");
  }

  const config = getConfig();
  const model: TriageModel = fake ? fakeModel : createAnthropicModel({ apiKey: config.ANTHROPIC_API_KEY, model: modelName });

  // measured per call
  const latencies: number[] = [];
  const timed: TriageModel = async (input) => {
    const t0 = Date.now();
    try {
      return await model(input);
    } finally {
      latencies.push(Date.now() - t0);
    }
  };

  const store = fakeStore(messages.map((m) => [m.id, m.text] as [string, string]));
  for (const m of messages) store.messages.get(m.id)!.channel = m.channel;
  const sender = fakeSender(store);

  let runMicros = 0;
  const runLimit = usdToMicros(RUN_LIMIT_USD);
  const totalLimit = usdToMicros(TOTAL_LIMIT_USD);
  const origRecord = store.recordCall.bind(store);
  store.recordCall = async (messageId, m, usage, outcome) => {
    runMicros += costMicros(modelName, usage.input_tokens, usage.output_tokens);
    await origRecord(messageId, m, usage, outcome);
  };

  const started = Date.now();
  const worker = createWorker({
    model: timed,
    modelName,
    store,
    send: sender,
    // checked before every call: a run cannot go on past its limit (up to 4 calls already in flight can still land)
    budget: { allows: async () => runMicros < runLimit && spentBefore + runMicros < totalLimit },
    limiter: createRateLimiter({ perMinute: config.TRIAGE_PER_MINUTE }),
    concurrency: config.TRIAGE_CONCURRENCY,
    log: {
      info: (o, msg) => msg === "triaged" && process.stdout.write("."),
      warn: (o, msg) => console.log(`\nwarn: ${msg} ${JSON.stringify(o)}`),
      error: (o, msg) => console.log(`\nerror: ${msg} ${JSON.stringify(o)}`),
    },
  });
  try {
    await worker.kick();
  } finally {
    const runs = readSpend();
    runs.push({ at: new Date().toISOString(), model: modelName + (fake ? " (fake)" : ""), messages: messages.length, calls: store.calls.length, micros: fake ? 0 : runMicros });
    writeFileSync(SPEND_FILE, JSON.stringify({ runs }, null, 2) + "\n");
  }
  const elapsedMs = Date.now() - started;
  console.log("\n");

  // ---- the report ----
  const lines: string[] = [];
  const rowsOut = messages.map((m) => {
    const s = store.messages.get(m.id)!;
    const r = s.result;
    const k = key[m.id];
    return {
      id: m.id,
      channel: m.channel,
      text: m.text.length > 90 ? m.text.slice(0, 60) + " [...] " + m.text.slice(-25) : m.text,
      status: s.status,
      attempts: s.triage_attempts,
      category: r?.category ?? null,
      sentiment: r?.sentiment ?? null,
      flags: r?.flags ?? [],
      held: r?.held ?? (s.status === "failed" ? "triage_failed" : s.status === "pending" ? "not_run" : null),
      truncated: r?.truncated ?? false,
      draft: r?.draft ?? null,
      original_draft: r?.originalDraft ?? null,
      sent: s.sent,
      key_category: k?.category ?? null,
      key_sentiment: k?.sentiment ?? null,
      key_injection: k?.injection ?? null,
      // the same check the service uses to hold a reply (src/triage/guards.ts)
      refund_words: refundWords(m.text) !== null,
    };
  });

  const pad = (s: string, n: number) => (s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length));
  lines.push(`${pad("id", 7)}${pad("model category", 17)}${pad("key", 17)}${pad("sentiment", 10)}${pad("key", 9)}${pad("flag", 5)}${pad("held", 20)}draft`);
  for (const r of rowsOut) {
    const catMark = r.category === r.key_category ? " " : r.key_category && key[r.id]?.also_ok?.includes(r.category ?? "") ? "~" : "x";
    lines.push(
      `${pad(r.id, 7)}${pad((r.category ?? "-") + catMark, 17)}${pad(r.key_category ?? "-", 17)}${pad(r.sentiment ?? "-", 10)}${pad(r.key_sentiment ?? "-", 9)}${pad(r.flags.length ? "INJ" : "", 5)}${pad(r.held ?? "SENT", 20)}${r.original_draft ? `[replaced; the model wrote: ${r.original_draft}]` : (r.draft ?? "")}`,
    );
  }
  console.log(lines.join("\n"));

  const done = rowsOut.filter((r) => r.status === "done");
  const exactC = done.filter((r) => r.category === r.key_category).length;
  const okC = done.filter((r) => r.category === r.key_category || key[r.id]?.also_ok?.includes(r.category ?? "")).length;
  const exactS = done.filter((r) => r.sentiment === r.key_sentiment).length;
  const okS = done.filter((r) => r.sentiment === r.key_sentiment || key[r.id]?.sentiment_also_ok?.includes(r.sentiment ?? "")).length;
  const keyRefund = done.filter((r) => r.key_category === "refund_related");
  // the safety measure: a refund message of the key whose reply the code would send automatically
  const wouldSend = keyRefund.filter((r) => r.sent);
  // held although the key says it may be answered (a cut message is held by rule, not by the model)
  const overHeld = done.filter((r) => r.key_category !== "refund_related" && r.held !== null);
  const extraRefund = done.filter((r) => r.category === "refund_related" && r.key_category !== "refund_related");
  const keyInj = done.filter((r) => r.key_injection);
  const flagged = done.filter((r) => r.flags.length > 0);
  const wordsNotRefund = done.filter((r) => r.refund_words && r.category !== "refund_related");

  const inTok = store.calls.reduce((s, c) => s + c.usage.input_tokens, 0);
  const outTok = store.calls.reduce((s, c) => s + c.usage.output_tokens, 0);
  const sortedLat = [...latencies].sort((a, b) => a - b);
  const heldBy: Record<string, number> = {};
  for (const r of rowsOut) heldBy[r.held ?? "sent"] = (heldBy[r.held ?? "sent"] ?? 0) + 1;
  const perMessage = done.length ? Math.round(runMicros / done.length) : 0;

  const summary = [
    "",
    `== summary (${modelName}${fake ? ", FAKE stand-in: these numbers say nothing about Claude" : ""}) ==`,
    `messages: ${messages.length}   done: ${done.length}   failed: ${rowsOut.filter((r) => r.status === "failed").length}   not run: ${rowsOut.filter((r) => r.status === "pending").length}`,
    `calls: ${store.calls.length}   input tokens: ${inTok}   output tokens: ${outTok}   cost: ${microsToUsd(runMicros)}   per message: ${microsToUsd(perMessage)}   at 10,000 messages a day: about ${microsToUsd(perMessage * 10_000)}`,
    `latency per call: median ${percentile(sortedLat, 50)} ms, p95 ${percentile(sortedLat, 95)} ms, max ${sortedLat.at(-1) ?? 0} ms   whole run: ${(elapsedMs / 1000).toFixed(1)} s`,
    `category: exact ${exactC}/${done.length}, or an accepted alternative ${okC}/${done.length}      sentiment: exact ${exactS}/${done.length}, or accepted ${okS}/${done.length}`,
    `refund messages in the key: ${keyRefund.length}; held by the code: ${keyRefund.length - wouldSend.length}; WOULD BE SENT (the safety measure, should be 0): ${wouldSend.length}; held although the key says it may be answered: ${overHeld.length}`,
    `injection per the key: ${keyInj.map((r) => r.id).join(", ") || "-"}; flagged by the model: ${flagged.map((r) => r.id).join(", ") || "-"}`,
    `replies that would be sent automatically: ${rowsOut.filter((r) => r.sent).length}; held: ${JSON.stringify(heldBy)}`,
    "",
    `-- a refund message of the key whose reply WOULD BE SENT: ${wouldSend.length}`,
    ...wouldSend.map((r) => `   ${r.id} model: ${r.category} (key: ${r.key_category}), draft: ${r.draft}   text: ${r.text}`),
    `-- held although the key says it may be answered: ${overHeld.length}`,
    ...overHeld.map((r) => `   ${r.id} model: ${r.category}, held: ${r.held}   text: ${r.text}`),
    `-- held by the check on the text, although the model did not say refund_related: ${wordsNotRefund.length}`,
    ...wordsNotRefund.map((r) => `   ${r.id} model: ${r.category}, held: ${r.held ?? "NO (would be sent)"}, text: ${r.text}`),
    `-- drafts replaced by the neutral line because they mention a refund, an approval or money: ${rowsOut.filter((r) => r.original_draft !== null).length}`,
    ...rowsOut.filter((r) => r.original_draft !== null).map((r) => `   ${r.id} (held: ${r.held}): the model wrote: ${r.original_draft}`),
    `-- the model said refund_related but the key does not: ${extraRefund.length}`,
    ...extraRefund.map((r) => `   ${r.id} key: ${r.key_category}   text: ${r.text}`),
  ];
  console.log(summary.join("\n"));

  mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = new URL(`triage-${modelName}${fake ? "-fake" : ""}-${stamp}.json`, OUT_DIR);
  writeFileSync(file, JSON.stringify({ model: modelName, fake, elapsedMs, calls: store.calls.length, inTok, outTok, micros: runMicros, latenciesMs: latencies, rows: rowsOut }, null, 2) + "\n");
  console.log(`\nfull result: ${file.pathname.replace(/^\/([A-Za-z]:)/, "$1")}`);
}

try {
  await main();
} catch (err) {
  console.error(err instanceof ModelError ? err.message : err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}
