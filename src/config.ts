import { existsSync } from "node:fs";
import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//),
  WEBHOOK_SECRET: z.string().min(1),
  APPROVER_TOKEN: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().min(1),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  NODE_ENV: z.string().default("development"),
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
