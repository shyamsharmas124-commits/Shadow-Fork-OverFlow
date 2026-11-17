import path from "node:path";
import { fileURLToPath } from "node:url";
import { Engine } from "@durable/engine";
import { serve } from "@hono/node-server";
import pg from "pg";
import { type CreateApiOptions, createApiApp, isLoopback } from "./api.js";

export interface StartServerOptions extends CreateApiOptions {
  port?: number;
}

export function startServer(options: StartServerOptions) {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 3000;
  const apiToken = options.apiToken ?? process.env.API_TOKEN;

  if (host !== "127.0.0.1") {
    console.warn(
      `[SECURITY WARNING] Binding API server to non-default host '${host}'. Ensure API is secured behind a trusted proxy or firewall.`,
    );
  }

  if (!isLoopback(host) && !apiToken) {
    throw new Error(
      `Refusing to start API server on non-loopback host '${host}' without API_TOKEN configured.`,
    );
  }

  const app = createApiApp({ ...options, host, apiToken });
  return serve({ fetch: app.fetch, port, hostname: host });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const databaseUrl =
    process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/durable";
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const engine = new Engine(pool);
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || "127.0.0.1";
  startServer({ engine, pool, port, host });
  console.log(`[API Server] Running on http://${host}:${port}`);
}
