import { parse } from "libpg-query";
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
 * Best-effort redaction of sensitive patterns within string values:
 * Bearer tokens, JWT tokens, and common API key / token prefixes (sk-, ghp_, AKIA, tok_).
 */
export function redactStringValue(val: string): string {
  return val
    .replace(/\bBearer\s+[a-zA-Z0-9_\-.~+/]+=*/gi, "Bearer [REDACTED]")
    .replace(/\beyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\b/g, "[REDACTED_JWT]")
    .replace(/\bsk-[a-zA-Z0-9_-]{20,}\b/g, "[REDACTED_KEY]")
    .replace(/\bghp_[a-zA-Z0-9]{30,}\b/g, "[REDACTED_KEY]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED_KEY]")
    .replace(/\btok_[a-zA-Z0-9_]{4,}\b/g, "[REDACTED_KEY]");
}

export const SECRET_FIELD_ALLOWLIST = new Set([
  "step_key",
  "stepkey",
  "step-key",
  "idempotency-key",
  "idempotency_key",
  "idempotencykey",
  "x-idempotency-key",
]);

/**
 * Checks if a header, query param, or payload field name is sensitive and must be redacted.
 * Idempotency keys (e.g. Idempotency-Key, idempotency_key) are explicitly allowlisted so diff views retain them.
 */
export function isSecretFieldName(name: string): boolean {
  const lower = name.toLowerCase();
  if (SECRET_FIELD_ALLOWLIST.has(lower)) {
    return false;
  }
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
      redacted[key] = redactStringValue(value);
    }
  }
  return redacted;
}

/**
 * Redacts sensitive query parameters and userinfo from URLs.
 * Fails closed: if URL parsing or decoding fails, redacts the entire query string or URL.
 */
export function redactUrl(urlStr: string): string {
  try {
    const isRelative = !urlStr.startsWith("http://") && !urlStr.startsWith("https://");
    const parsed = new URL(urlStr, "http://localhost");

    // Redact userinfo if present
    if (parsed.username) parsed.username = "[REDACTED]";
    if (parsed.password) parsed.password = "[REDACTED]";

    // Test decoding to detect malformed percent-encoding
    decodeURIComponent(parsed.search);

    for (const key of Array.from(parsed.searchParams.keys())) {
      if (isSecretFieldName(key)) {
        parsed.searchParams.set(key, "[REDACTED]");
      } else {
        const val = parsed.searchParams.get(key);
        if (val) {
          parsed.searchParams.set(key, redactStringValue(val));
        }
      }
    }

    const formatted = parsed.toString().replace(/%5B(REDACTED[^%]*)%5D/g, "[$1]");
    if (isRelative) {
      return redactStringValue(formatted.replace("http://localhost", ""));
    }
    return redactStringValue(formatted);
  } catch {
    // Fails closed: if parsing or decoding fails, redact query string or whole URL
    const qIdx = urlStr.indexOf("?");
    if (qIdx !== -1) {
      return `${urlStr.slice(0, qIdx)}?[REDACTED]`;
    }
    return "[REDACTED_URL]";
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
          decodeURIComponent(body);
          let changed = false;
          for (const key of Array.from(params.keys())) {
            if (isSecretFieldName(key)) {
              params.set(key, "[REDACTED]");
              changed = true;
            } else {
              const val = params.get(key);
              if (val) {
                const redactedVal = redactStringValue(val);
                if (redactedVal !== val) {
                  params.set(key, redactedVal);
                  changed = true;
                }
              }
            }
          }
          if (changed) {
            return params.toString().replace(/%5B(REDACTED[^%]*)%5D/g, "[$1]");
          }
        } catch {
          // Fall through to redactStringValue
        }
      }
    }
    return redactStringValue(body);
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

/**
 * Strips comments (-- and /* *\/) and string literals ('...' and $$...$$) from SQL.
 * Correctly treats backslash as an escape ONLY for E-strings (E'...') in accordance
 * with standard Postgres standard_conforming_strings = on.
 */
export function stripSqlCommentsAndStrings(sql: string): string {
  let out = "";
  let i = 0;
  const len = sql.length;

  while (i < len) {
    if (sql[i] === "-" && sql[i + 1] === "-") {
      i += 2;
      while (i < len && sql[i] !== "\n" && sql[i] !== "\r") {
        i++;
      }
      out += " ";
      continue;
    }
    if (sql[i] === "/" && sql[i + 1] === "*") {
      i += 2;
      let depth = 1;
      while (i < len && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") {
          depth++;
          i += 2;
        } else if (sql[i] === "*" && sql[i + 1] === "/") {
          depth--;
          i += 2;
        } else {
          i++;
        }
      }
      out += " ";
      continue;
    }
    if (sql[i] === "'") {
      const isEString = i > 0 && (sql[i - 1] === "E" || sql[i - 1] === "e");
      i++;
      while (i < len) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2;
          } else {
            i++;
            break;
          }
        } else if (isEString && sql[i] === "\\") {
          i += 2;
        } else {
          i++;
        }
      }
      out += " ";
      continue;
    }
    if (sql[i] === "$") {
      const match = sql.slice(i).match(/^\$([a-zA-Z0-9_]*)\$/);
      if (match) {
        const tag = match[0];
        const endIdx = sql.indexOf(tag, i + tag.length);
        if (endIdx !== -1) {
          i = endIdx + tag.length;
          out += " ";
          continue;
        }
      }
    }
    out += sql[i];
    i++;
  }
  return out;
}

/**
 * Traverses an AST recursively, invoking visitor on every object node.
 */
function walkAst(node: unknown, visitor: (node: Record<string, unknown>) => void): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) {
      walkAst(item, visitor);
    }
    return;
  }
  const record = node as Record<string, unknown>;
  visitor(record);
  for (const val of Object.values(record)) {
    walkAst(val, visitor);
  }
}

/**
 * Function denylist:
 * - set_config
 * - any dblink* variant
 * - any pg_advisory_lock* variant EXCEPT pg_advisory_xact_lock*
 * - any pg_try_advisory_lock* variant EXCEPT pg_try_advisory_xact_lock*
 * - pg_terminate_backend
 * - pg_cancel_backend
 * - lo_import, lo_export
 * - pg_read_file, pg_read_binary_file, pg_ls_dir
 */
export function isForbiddenSqlFunction(fnName: string): boolean {
  const lower = fnName.toLowerCase();
  if (lower === "set_config") return true;
  if (lower.startsWith("dblink")) return true;
  if (lower.startsWith("pg_advisory_lock") && !lower.startsWith("pg_advisory_xact_lock")) {
    return true;
  }
  if (lower.startsWith("pg_try_advisory_lock") && !lower.startsWith("pg_try_advisory_xact_lock")) {
    return true;
  }
  if (lower === "pg_terminate_backend") return true;
  if (lower === "pg_cancel_backend") return true;
  if (lower === "lo_import") return true;
  if (lower === "lo_export") return true;
  if (lower === "pg_read_file") return true;
  if (lower === "pg_read_binary_file") return true;
  if (lower === "pg_ls_dir") return true;
  return false;
}

/**
 * Validates shadow SQL using the PostgreSQL AST parser (libpg-query).
 * 1. Rejects multi-statement queries (allows exactly one statement).
 * 2. Enforces allowlist of top-level statement kinds: SELECT, INSERT, UPDATE, DELETE (WITH allowed if body is one of those).
 *    Explicitly rejects user-issued SET (including SET LOCAL), DO, ABORT, PREPARE, EXECUTE, DEALLOCATE, COPY, NOTIFY.
 * 3. Walks the AST and rejects calls to forbidden functions in the denylist.
 */
export async function validateShadowSql(sql: string): Promise<void> {
  let parseRes: { stmts: Array<{ stmt: Record<string, unknown> }> };
  try {
    parseRes = (await parse(sql)) as { stmts: Array<{ stmt: Record<string, unknown> }> };
  } catch (err) {
    throw new Error(`Shadow SQL syntax error: ${(err as Error).message}`);
  }

  if (parseRes.stmts.length !== 1) {
    throw new Error(
      `Shadow SQL error: exactly one statement is allowed in shadow mode (found ${parseRes.stmts.length} statements).`,
    );
  }

  const stmtObj = parseRes.stmts[0]!.stmt;
  const stmtType = Object.keys(stmtObj)[0]!;
  const allowedStmtTypes = ["SelectStmt", "InsertStmt", "UpdateStmt", "DeleteStmt"];
  if (!allowedStmtTypes.includes(stmtType)) {
    throw new Error(
      `Shadow SQL error: statement type '${stmtType}' is forbidden in shadow mode (only SELECT, INSERT, UPDATE, and DELETE are allowed).`,
    );
  }

  walkAst(stmtObj, (node) => {
    if (node.FuncCall && typeof node.FuncCall === "object") {
      const funcname = (node.FuncCall as { funcname?: Array<{ String?: { sval?: string } }> })
        .funcname;
      if (Array.isArray(funcname) && funcname.length > 0) {
        const last = funcname[funcname.length - 1];
        const fnName = last?.String?.sval;
        if (fnName && isForbiddenSqlFunction(fnName)) {
          throw new Error(
            `Shadow SQL error: call to forbidden function '${fnName}' is not allowed in shadow mode.`,
          );
        }
      }
    }
  });
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
    await validateShadowSql(sql);
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
   * Destroy the client (release(true)) instead of returning it to the pool so no session state leaks.
   */
  async cleanup(): Promise<void> {
    if (this.client) {
      try {
        await this.client.query("ROLLBACK");
      } catch {
        // Safe ignore
      } finally {
        this.client.release(true);
        this.client = null;
      }
    }
  }
}
