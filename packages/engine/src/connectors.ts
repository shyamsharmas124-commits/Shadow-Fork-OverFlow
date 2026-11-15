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
 * Checks if a header, query param, or payload field name is sensitive and must be redacted.
 */
export function isSecretFieldName(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower === "authorization" ||
    lower === "cookie" ||
    lower === "proxy-authorization" ||
    lower.includes("token") ||
    lower.includes("secret") ||
    lower.includes("key") ||
    lower.includes("signature") ||
    lower.includes("password") ||
    lower.includes("auth")
  );
}

/**
 * Redacts sensitive headers before storing in event logs.
 */
export function redactHeaders(headers: Record<string, string> = {}): Record<string, string> {
  const redacted: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (isSecretFieldName(key)) {
      redacted[key] = "[REDACTED]";
    } else {
      redacted[key] = value;
    }
  }
  return redacted;
}

/**
 * Redacts sensitive query parameters from URLs.
 */
export function redactUrl(urlStr: string): string {
  try {
    const isRelative = !urlStr.startsWith("http://") && !urlStr.startsWith("https://");
    const parsed = new URL(urlStr, "http://localhost");
    let changed = false;
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (isSecretFieldName(key)) {
        parsed.searchParams.set(key, "[REDACTED]");
        changed = true;
      }
    }
    if (!changed) return urlStr;
    const formatted = parsed.toString().replace(/%5BREDACTED%5D/g, "[REDACTED]");
    if (isRelative) {
      return formatted.replace("http://localhost", "");
    }
    return formatted;
  } catch {
    return urlStr;
  }
}

/**
 * Redacts sensitive fields in JSON objects, arrays, JSON strings, and form-encoded bodies.
 */
export function redactPayload(body: unknown): unknown {
  if (body === null || body === undefined) return body;

  if (typeof body === "string") {
    try {
      const parsed = JSON.parse(body);
      if (typeof parsed === "object" && parsed !== null) {
        return JSON.stringify(redactPayload(parsed));
      }
    } catch {
      if (body.includes("=") && !body.includes("\n")) {
        try {
          const params = new URLSearchParams(body);
          let changed = false;
          for (const key of Array.from(params.keys())) {
            if (isSecretFieldName(key)) {
              params.set(key, "[REDACTED]");
              changed = true;
            }
          }
          if (changed) {
            return params.toString().replace(/%5BREDACTED%5D/g, "[REDACTED]");
          }
        } catch {
          // Keep as string
        }
      }
    }
    return body;
  }

  if (Array.isArray(body)) {
    return body.map((item) => redactPayload(item));
  }

  if (typeof body === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
      if (isSecretFieldName(key)) {
        result[key] = "[REDACTED]";
      } else {
        result[key] = redactPayload(value);
      }
    }
    return result;
  }

  return body;
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
      url: redactUrl(req.url),
      method,
      headers: redactHeaders(req.headers),
      body: redactPayload(req.body),
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

const NON_TRANSACTIONAL_SQL_REGEX =
  /^\s*(VACUUM|CREATE\s+INDEX\s+CONCURRENTLY|DROP\s+INDEX\s+CONCURRENTLY|REINDEX\s+CONCURRENTLY|DISCARD\s+ALL)/i;

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
      await this.client.query(
        "SET LOCAL lock_timeout = '1000ms'; SET LOCAL statement_timeout = '5000ms';",
      );
    }
    return this.client;
  }

  /**
   * Executes queries inside a dedicated client transaction, recording affected rows.
   */
  async query(sql: string, params?: unknown[]): Promise<SqlResult> {
    this.callCount++;
    if (NON_TRANSACTIONAL_SQL_REGEX.test(sql.trim())) {
      throw new Error(
        `Shadow SQL error: statement '${sql.trim().slice(0, 30)}...' cannot run inside a transaction and cannot be rolled back.`,
      );
    }
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
