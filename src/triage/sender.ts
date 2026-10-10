import { OUTBOUND_SIGNATURE_HEADER, signOutbound } from "./outboundAuth.js";

export type SendResult =
  | { ok: true; status: "sent" | "already_sent" }
  /** retryable: worth trying again later (our own service did not answer, or could not store). */
  | { ok: false; retryable: boolean; detail: string };

export type Sender = (messageId: string, text: string) => Promise<SendResult>;

/**
 * The README: "the reply sent immediately by POSTing it to your own /outbound endpoint and recording it".
 * This is that POST: a real HTTP request, signed, to this service. It is also the place a real mail provider
 * would be called from.
 */
export function createHttpSender(opts: { url: string; secret: string; fetchFn?: typeof fetch; timeoutMs?: number }): Sender {
  const fetchFn = opts.fetchFn ?? fetch;
  return async (messageId, text) => {
    const body = JSON.stringify({ message_id: messageId, text });
    try {
      const res = await fetchFn(opts.url, {
        method: "POST",
        headers: { "content-type": "application/json", [OUTBOUND_SIGNATURE_HEADER]: signOutbound(opts.secret, body) },
        body,
        signal: AbortSignal.timeout(opts.timeoutMs ?? 5000),
      });
      const answer = (await res.json().catch(() => ({}))) as { status?: string; error?: string; reason?: string };
      if (res.status === 200) return { ok: true, status: answer.status === "already_sent" ? "already_sent" : "sent" };
      const detail = `/outbound answered ${res.status}${answer.error ? ` ${answer.error}` : ""}${answer.reason ? ` (${answer.reason})` : ""}`;
      return { ok: false, retryable: res.status >= 500, detail };
    } catch (err) {
      return { ok: false, retryable: true, detail: `/outbound not reached: ${err instanceof Error ? err.name : "error"}` };
    }
  };
}
