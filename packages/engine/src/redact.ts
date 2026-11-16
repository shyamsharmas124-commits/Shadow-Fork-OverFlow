import { isSecretFieldName, redactStringValue } from "./connectors.js";

/**
 * Extended string redaction for API responses and inspector output.
 * In addition to Bearer tokens, JWTs, and API key prefixes (sk-, ghp_, AKIA),
 * this detects and masks key-value secret assignments in error strings, logs, or URLs
 * (e.g. password=..., secret=..., token=..., api_key=...).
 */
export function redactApiString(val: string): string {
  // 1. Base pattern redaction (Bearer, JWT, sk-, ghp_, AKIA)
  let s = redactStringValue(val);

  // 2. Key-value secret assignments in prose/errors (e.g., password=foo, secret: bar)
  s = s.replace(
    /((?:password|passwd|secret|token|api_key|apikey|auth_token)\s*[:=]\s*)([^\s,;&"']+)/gi,
    "$1[REDACTED]",
  );

  return s;
}

/**
 * Deeply and recursively redacts sensitive fields and values from any data structure
 * before sending it out over the API / Inspector interface.
 *
 * Covers:
 * - Object keys matching secret patterns (password, secret, token, auth, etc., except allowlisted idempotency keys)
 * - Object values matching secret patterns (Bearer, JWT, sk-, ghp_, AKIA, etc.)
 * - Serialized JSON strings within values
 * - Array elements
 * - Error strings and error details
 */
export function redactApiOutput<T>(data: T): T {
  if (data === null || data === undefined) {
    return data;
  }

  if (typeof data === "string") {
    // If it's a JSON string, parse, recursively redact, and re-stringify
    try {
      const parsed = JSON.parse(data);
      if (typeof parsed === "object" && parsed !== null) {
        return JSON.stringify(redactApiOutput(parsed)) as unknown as T;
      }
    } catch {
      // Plain string
    }
    return redactApiString(data) as unknown as T;
  }

  if (Array.isArray(data)) {
    return data.map((item) => redactApiOutput(item)) as unknown as T;
  }

  if (typeof data === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      if (isSecretFieldName(key)) {
        result[key] = "[REDACTED]";
      } else {
        result[key] = redactApiOutput(value);
      }
    }
    return result as unknown as T;
  }

  return data;
}
