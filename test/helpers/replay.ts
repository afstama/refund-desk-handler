import { readFile } from "node:fs/promises";
import type { FastifyInstance } from "fastify";

/** One line of events.ndjson. `body` is the exact request body, byte for byte. */
export interface Delivery {
  event_id: string;
  signature: string;
  body: string;
}

export interface ReplayResult {
  event_id: string;
  status: number;
  error?: string;
}

/** Sends one delivery and reports the HTTP status (0 plus `error` when no answer came). */
export type Sender = (d: Delivery) => Promise<{ status: number; error?: string }>;

const defaultFile = new URL("../../events.ndjson", import.meta.url);

export async function loadDeliveries(file: URL | string = defaultFile): Promise<Delivery[]> {
  const text = await readFile(file, "utf8");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Delivery);
}

function headersFor(d: Delivery) {
  return { "content-type": "application/json", "x-event-id": d.event_id, "x-signature": d.signature };
}

/** In-process: no port, no network. */
export function injectSender(app: FastifyInstance): Sender {
  return async (d) => {
    const res = await app.inject({ method: "POST", url: "/webhooks", headers: headersFor(d), payload: d.body });
    return { status: res.statusCode };
  };
}

/** Real HTTP, with the same 3 second limit as Qure's sender. */
export function httpSender(baseUrl: string, timeoutMs = 3000): Sender {
  const url = baseUrl.replace(/\/$/, "") + "/webhooks";
  return async (d) => {
    try {
      const res = await fetch(url, { method: "POST", headers: headersFor(d), body: d.body, signal: AbortSignal.timeout(timeoutMs) });
      await res.arrayBuffer();
      return { status: res.status };
    } catch (err) {
      return { status: 0, error: err instanceof Error ? err.name : String(err) };
    }
  };
}

/** Sends deliveries one after the other, in file order. */
export async function replay(send: Sender, deliveries: Delivery[], opts: { limit?: number } = {}): Promise<ReplayResult[]> {
  const results: ReplayResult[] = [];
  for (const d of deliveries.slice(0, opts.limit ?? deliveries.length)) {
    results.push({ event_id: d.event_id, ...(await send(d)) });
  }
  return results;
}
