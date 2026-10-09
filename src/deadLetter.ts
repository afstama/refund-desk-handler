import { getPool } from "./db.js";

/** Once per event per reason. Redeliveries of a refused event add nothing. Refused bodies are never stored. */
export async function recordDeadLetter(eventId: string, reason: string, detail: string): Promise<void> {
  await getPool().query(
    "INSERT INTO dead_letter (event_id, reason, detail) VALUES ($1, $2, $3) ON CONFLICT (event_id, reason) DO NOTHING",
    [eventId, reason, detail],
  );
}
