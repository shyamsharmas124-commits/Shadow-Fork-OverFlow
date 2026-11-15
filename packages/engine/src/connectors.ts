import type { Pool, PoolClient } from "pg";

export interface HttpRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

export interface HttpConnector {
  fetch(req: HttpRequest): Promise<HttpResponse>;
}

export interface SqlResult {
  rowCount: number;
  rows: unknown[];
}

export interface SqlConnector {
  query(sql: string, params?: unknown[]): Promise<SqlResult>;
}

export interface CapturedEffect {
  kind: "http" | "sql";
  request: unknown;
  wouldHaveResult?: unknown;
}

/**
 * Redacts sensitive headers before storing in event logs:
 * Authorization, Cookie, Proxy-Authorization, and any header containing "token", "secret", or "key" (case-insensitive).
 */
export function redactHeaders(headers: Record<string, string> = {}): Record<string, string> {
  const redacted: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (
      lower === "authorization" ||
      lower === "cookie" ||
      lower === "proxy-authorization" ||
      lower.includes("token") ||
      lower.includes("secret") ||
      lower.includes("key")
    ) {
      redacted[key] = "[REDACTED]";
    } else {
      redacted[key] = value;
    }
  }
  return redacted;
}

export class LiveHttpConnector implements HttpConnector {
  public callCount = 0;

  async fetch(req: HttpRequest): Promise<HttpResponse> {
    this.callCount++;
    const method = req.method ?? "GET";
    const headers = req.headers ?? {};
    const body =
      typeof req.body === "object" && req.body !== null
        ? JSON.stringify(req.body)
        : (req.body as string | undefined);

    const res = await globalThis.fetch(req.url, {
      method,
      headers,
      body: method === "GET" || method === "HEAD" ? undefined : body,
    });

    const resHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      resHeaders[k] = v;
    });

    let resBody: unknown;
    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      resBody = await res.json();
    } else {
      resBody = await res.text();
    }

    return {
      status: res.status,
      headers: resHeaders,
      body: resBody,
    };
  }
}

export class ShadowHttpConnector implements HttpConnector {
  public callCount = 0;
  public capturedRequests: Array<{
    url: string;
    method: string;
    headers: Record<string, string>;
    body: unknown;
  }> = [];

  constructor(private readonly getWouldHaveResult: () => unknown) {}

  async fetch(req: HttpRequest): Promise<HttpResponse> {
    this.callCount++;
    const method = req.method ?? "GET";
    const redactedReq = {
      url: req.url,
      method,
      headers: redactHeaders(req.headers),
      body: req.body,
    };
    this.capturedRequests.push(redactedReq);

    // In shadow mode, do NOT send request. Return mock/reused result as response body.
    const body = this.getWouldHaveResult();
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body,
    };
  }
}

export class LiveSqlConnector implements SqlConnector {
  public callCount = 0;

  constructor(private readonly pool: Pool) {}

  async query(sql: string, params?: unknown[]): Promise<SqlResult> {
    this.callCount++;
    const res = await this.pool.query(sql, params);
    return {
      rowCount: res.rowCount ?? 0,
      rows: res.rows,
    };
  }
}

export class ShadowSqlConnector implements SqlConnector {
  public callCount = 0;
  public totalAffectedRows = 0;
  public capturedQueries: Array<{ sql: string; params?: unknown[]; affectedRows: number }> = [];
  private client: PoolClient | null = null;
  public backendPid: number | null = null;

  constructor(private readonly pool: Pool) {}

  private async getClient(): Promise<PoolClient> {
    if (!this.client) {
      this.client = await this.pool.connect();
      this.backendPid = (this.client as unknown as { processID: number }).processID;
      await this.client.query("BEGIN");
    }
    return this.client;
  }

  /**
   * Executes queries inside a dedicated client transaction, recording affected rows.
   */
  async query(sql: string, params?: unknown[]): Promise<SqlResult> {
    this.callCount++;
    const client = await this.getClient();
    const res = await client.query(sql, params);
    const rowCount = res.rowCount ?? 0;
    this.totalAffectedRows += rowCount;
    this.capturedQueries.push({ sql, params, affectedRows: rowCount });

    return {
      rowCount,
      rows: res.rows,
    };
  }

  /**
   * ROLLBACK must run in a finally block, including on error, timeout and abort.
   */
  async cleanup(): Promise<void> {
    if (this.client) {
      try {
        await this.client.query("ROLLBACK");
      } catch {
        // Safe ignore
      } finally {
        this.client.release();
        this.client = null;
      }
    }
  }
}
