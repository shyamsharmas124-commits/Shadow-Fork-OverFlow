import { serve } from "@hono/node-server";
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
