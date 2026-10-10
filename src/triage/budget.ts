import type pg from "pg";
import { getPool } from "../db.js";
import { costMicros } from "./pricing.js";

/** Everything the service has spent on the model so far, from the calls it recorded (survives restarts). */
export async function spentMicros(pool: pg.Pool = getPool()): Promise<number> {
  const res = await pool.query<{ model: string; input: number; output: number }>(
    `SELECT model, COALESCE(sum(input_tokens), 0)::bigint AS input, COALESCE(sum(output_tokens), 0)::bigint AS output
     FROM model_calls GROUP BY model`,
  );
  return res.rows.reduce((sum, r) => sum + costMicros(r.model, r.input, r.output), 0);
}

/** True while the all-time spend is under the ceiling. Called before every model call. */
export function createBudget(ceilingMicros: number, spent: () => Promise<number> = spentMicros) {
  return {
    ceilingMicros,
    async remainingMicros(): Promise<number> {
      return ceilingMicros - (await spent());
    },
    async allows(): Promise<boolean> {
      return (await spent()) < ceilingMicros;
    },
  };
}
export type Budget = ReturnType<typeof createBudget>;
