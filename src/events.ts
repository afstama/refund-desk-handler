import { z } from "zod";
import { minorUnitDigits } from "./currency.js";
import { parseAmountMinor } from "./money.js";
import { parseInstant } from "./time.js";

export type ParsedEvent =
  | { kind: "order.created"; occurredAt: Date; orderId: string; customerEmail: string; currency: string; totalMinor: number }
  | { kind: "shipment.delivered"; occurredAt: Date; orderId: string }
  | { kind: "order.cancelled"; occurredAt: Date; orderId: string }
  | { kind: "refund.requested"; occurredAt: Date; refundId: string; orderId: string; amountMinor: number; currency: string; reason: string }
  | { kind: "message.received"; occurredAt: Date; messageId: string; orderId: string | null; channel: string; text: string }
  | { kind: "unknown"; occurredAt: Date; type: string };

export type Classified = { ok: true; event: ParsedEvent } | { ok: false; detail: string };

/**
 * What an event id may look like: printable ASCII without spaces, 1 to 128 characters. That fits any id scheme a
 * sender is likely to use (evt_0001, UUIDs, base64) and still keeps out control characters, spaces and non-ASCII
 * text. The id is checked on the X-Event-Id header before anything is stored. It is not a defence against hostile
 * text by itself: the ledger is JSON, and the screen shows text with textContent under a strict CSP.
 */
export const EVENT_ID_FORMAT = /^[\x21-\x7e]{1,128}$/;

/**
 * The signature covers the body, not the X-Event-Id header, and we dedupe on the header. The body states its own
 * id, so it must equal the header. Otherwise a captured signed body could be replayed under fresh header ids.
 * Returns the reason to refuse, or null. Bodies that are not objects are left to classify().
 */
export function bodyIdProblem(body: unknown, headerId: string): string | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const id = (body as Record<string, unknown>).id;
  if (typeof id !== "string") return `body id ${id === undefined ? "missing" : id === null ? "null" : "invalid"}`;
  const bodyId = id.trim();
  if (bodyId === headerId) return null;
  // Naming the id the body really carries tells a person which event was replayed. Only if it looks like an id.
  return EVENT_ID_FORMAT.test(bodyId) ? `body id does not match X-Event-Id (body says ${bodyId})` : "body id does not match X-Event-Id";
}

// Only whitespace and letter case are normalised (Marko). Ids keep their case.
const trimmed = z.string().transform((s) => s.trim());
const idText = trimmed.pipe(z.string().min(1).max(100));
// Three ASCII letters in either case, stored in capitals: "eur" can only mean EUR.
const currency = trimmed.pipe(z.string().regex(/^[A-Za-z]{3}$/)).transform((s) => s.toUpperCase());
// An amount is read with the decimals of the currency written next to it (JPY 0, EUR 2, KWD 3), so the field is
// kept as it came and checked together with the currency, at the level of the whole payload.
const amountOf = (value: unknown, currency: string) => parseAmountMinor(value, minorUnitDigits(currency));
const mustReadAs = (field: string) => (p: Record<string, unknown>, ctx: z.RefinementCtx) => {
  if (amountOf(p[field], p.currency as string) === null) ctx.addIssue({ code: "custom", path: [field], message: "unreadable amount" });
};
const instant = z.unknown().refine((v) => parseInstant(v) !== null).transform((v) => parseInstant(v) as Date);

const envelope = z.object({ type: z.string().min(1).max(200), occurred_at: instant });

interface Definition {
  schema: z.ZodType;
  build: (value: unknown, at: Date) => ParsedEvent;
}

function def<S extends z.ZodType>(payload: S, build: (p: z.output<S>, at: Date) => ParsedEvent): Definition {
  return {
    schema: z.object({ payload }),
    build: (value: unknown, at: Date) => build((value as { payload: z.output<S> }).payload, at),
  };
}

// A Map, not an object: a type such as "constructor" or "__proto__" must read as unknown, not hit Object.prototype.
const known = new Map<string, Definition>([
  [
    "order.created",
    def(
      z.object({ order_id: idText, customer_email: trimmed.pipe(z.string().min(1).max(320)), total: z.unknown(), currency }).superRefine(mustReadAs("total")),
      (p, at) => ({
        kind: "order.created",
        occurredAt: at,
        orderId: p.order_id,
        customerEmail: p.customer_email,
        currency: p.currency,
        totalMinor: amountOf(p.total, p.currency) as number,
      }),
    ),
  ],
  ["shipment.delivered", def(z.object({ order_id: idText }), (p, at) => ({ kind: "shipment.delivered", occurredAt: at, orderId: p.order_id }))],
  ["order.cancelled", def(z.object({ order_id: idText }), (p, at) => ({ kind: "order.cancelled", occurredAt: at, orderId: p.order_id }))],
  [
    "refund.requested",
    def(
      z
        .object({
          refund_id: idText,
          order_id: idText,
          amount: z.unknown(),
          currency,
          reason: trimmed.pipe(z.string().min(1).max(100)).transform((s) => s.toLowerCase()),
        })
        .superRefine(mustReadAs("amount")),
      (p, at) => ({
        kind: "refund.requested",
        occurredAt: at,
        refundId: p.refund_id,
        orderId: p.order_id,
        amountMinor: amountOf(p.amount, p.currency) as number,
        currency: p.currency,
        reason: p.reason,
      }),
    ),
  ],
  [
    "message.received",
    def(
      z.object({
        message_id: idText,
        order_id: idText.nullish().transform((v) => v ?? null),
        channel: trimmed.pipe(z.string().min(1).max(50)),
        text: z.string(),
      }),
      (p, at) => ({ kind: "message.received", occurredAt: at, messageId: p.message_id, orderId: p.order_id, channel: p.channel, text: p.text }),
    ),
  ],
]);

function valueAt(body: unknown, path: PropertyKey[]): unknown {
  let current = body;
  for (const key of path) {
    if (current !== null && typeof current === "object" && Object.hasOwn(current, key)) current = (current as Record<PropertyKey, unknown>)[key];
    else return undefined;
  }
  return current;
}

/** "refund.requested: payload.amount invalid". Names the field and its state, never the value. */
function describeFirstIssue(error: z.ZodError, body: unknown, label: string): string {
  const path = error.issues[0]?.path ?? [];
  const value = valueAt(body, path);
  const state = value === undefined ? "missing" : value === null ? "null" : "invalid";
  return `${label}: ${path.length ? path.map(String).join(".") : "body"} ${state}`;
}

/**
 * Decides whether a parsed JSON body is a usable event and normalises it.
 * Never throws on odd input and never puts a raw value in `detail`.
 */
export function classify(body: unknown): Classified {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return { ok: false, detail: "body is not a JSON object" };

  const rawType = (body as Record<string, unknown>).type;
  const label = typeof rawType === "string" && known.has(rawType) ? rawType : "event";

  const head = envelope.safeParse(body);
  if (!head.success) return { ok: false, detail: describeFirstIssue(head.error, body, label) };
  const { type, occurred_at: occurredAt } = head.data;

  const definition = known.get(type);
  let event: ParsedEvent;
  if (!definition) {
    event = { kind: "unknown", occurredAt, type };
  } else {
    const full = definition.schema.safeParse(body);
    if (!full.success) return { ok: false, detail: describeFirstIssue(full.error, body, label) };
    event = definition.build(full.data, occurredAt);
  }

  // Postgres text cannot hold a NUL character. An event that carries one would fail on insert every time and be answered with 503, as if the database were down.
  for (const [key, value] of Object.entries(event)) {
    if (typeof value === "string" && value.includes("\u0000")) return { ok: false, detail: `${label}: ${key} contains a NUL character` };
  }
  return { ok: true, event };
}
