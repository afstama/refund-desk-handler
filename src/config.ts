import { existsSync } from "node:fs";
import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//),
  WEBHOOK_SECRET: z.string().min(1),
  APPROVER_TOKEN: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().min(1),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  NODE_ENV: z.string().default("development"),

  // Triage (phase 7). The key above is used only when TRIAGE_LIVE is "1": a local replay or a test run never spends.
  TRIAGE_LIVE: z
    .enum(["0", "1"])
    .default("0")
    .transform((v) => v === "1"),
  TRIAGE_MODEL: z.string().min(1).default("claude-haiku-5-5"),
  // All-time ceiling of what this service may spend on the model, in US dollars (src/triage/budget.ts).
  TRIAGE_BUDGET_USD: z.coerce.number().positive().max(1000).default(5),
  // The key's limit is 50 requests a minute (the comment next to ANTHROPIC_API_KEY in .env); 45 leaves a margin.
  TRIAGE_PER_MINUTE: z.coerce.number().int().min(1).max(1000).default(45),
  TRIAGE_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
  // Where the worker POSTs the replies. Default: this service itself, http://127.0.0.1:PORT/outbound.
  OUTBOUND_URL: z.string().url().optional(),
});

export type Config = z.infer<typeof schema>;

/** Names the offending keys only. It never includes a value. */
export class ConfigError extends Error {
  constructor(readonly keys: string[]) {
    super(`Invalid or missing environment variables: ${keys.join(", ")}`);
    this.name = "ConfigError";
  }
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  const result = schema.safeParse(env);
  if (!result.success) {
    const keys = [...new Set(result.error.issues.map((i) => String(i.path[0] ?? "(unknown)")))];
    throw new ConfigError(keys);
  }
  return result.data;
}

let cached: Config | undefined;

/** Loads .env if the file exists (Render uses real environment variables instead). */
export function getConfig(): Config {
  if (!cached) {
    if (existsSync(".env")) process.loadEnvFile(".env");
    cached = loadConfig(process.env);
  }
  return cached;
}
