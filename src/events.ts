import { z } from "zod";
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

// Only whitespace and letter case are normalised (Marko). Ids keep their case.
const trimmed = z.string().transform((s) => s.trim());
const idText = trimmed.pipe(z.string().min(1).max(100));
const currency = trimmed.pipe(z.string().regex(/^[A-Z]{3}$/));
const amount = z.unknown().refine((v) => parseAmountMinor(v) !== null).transform((v) => parseAmountMinor(v) as number);
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
    def(z.object({ order_id: idText, customer_email: trimmed.pipe(z.string().min(1).max(320)), total: amount, currency }), (p, at) => ({
      kind: "order.created",
      occurredAt: at,
      orderId: p.order_id,
      customerEmail: p.customer_email,
      currency: p.currency,
      totalMinor: p.total,
    })),
  ],
  ["shipment.delivered", def(z.object({ order_id: idText }), (p, at) => ({ kind: "shipment.delivered", occurredAt: at, orderId: p.order_id }))],
  ["order.cancelled", def(z.object({ order_id: idText }), (p, at) => ({ kind: "order.cancelled", occurredAt: at, orderId: p.order_id }))],
  [
    "refund.requested",
    def(
      z.object({
        refund_id: idText,
        order_id: idText,
        amount,
        currency,
        reason: trimmed.pipe(z.string().min(1).max(100)).transform((s) => s.toLowerCase()),
      }),
      (p, at) => ({
        kind: "refund.requested",
        occurredAt: at,
        refundId: p.refund_id,
        orderId: p.order_id,
        amountMinor: p.amount,
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
