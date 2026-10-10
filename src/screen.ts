import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";

// The approval screen: four static files from public/. They are read once, at startup, so a missing file stops the
// service from starting instead of showing a blank page later.
const publicDir = new URL("../public/", import.meta.url);

const FILES: { path: string; file: string; type: string }[] = [
  { path: "/", file: "index.html", type: "text/html; charset=utf-8" },
  { path: "/app.js", file: "app.js", type: "text/javascript; charset=utf-8" },
  { path: "/view.js", file: "view.js", type: "text/javascript; charset=utf-8" },
  { path: "/app.css", file: "app.css", type: "text/css; charset=utf-8" },
];

/**
 * Scripts, styles and requests only from our own origin, no inline script, no framing, no base tag, no forms.
 * The page shows text we do not control (reasons, ids), so even a slip in the page code could not run a script.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

export function screenRoutes() {
  const loaded = FILES.map((f) => ({ ...f, body: readFileSync(new URL(f.file, publicDir)) }));
  return async (scope: FastifyInstance) => {
    for (const f of loaded) {
      scope.get(f.path, async (_req, reply) =>
        reply
          .header("content-type", f.type)
          .header("content-security-policy", CONTENT_SECURITY_POLICY)
          .header("x-content-type-options", "nosniff")
          .header("referrer-policy", "no-referrer")
          .header("cache-control", "no-cache")
          .send(f.body),
      );
    }
  };
}
