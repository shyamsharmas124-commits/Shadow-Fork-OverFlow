/**
 * Redacts sensitive tokens, credentials, and secret query parameters from curl commands.
 */
export function redactSecretString(val: string): string {
  let s = val;
  // 1. Redact Authorization / Bearer tokens
  s = s.replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]");
  // 2. Redact known secret prefixes (sk-, ghp_, AKIA, tok_)
  s = s.replace(
    /\b(sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|tok_[A-Za-z0-9_-]{8,})\b/g,
    "[REDACTED]",
  );
  // 3. Redact key-value secrets in URLs (?token=..., &secret=...)
  s = s.replace(/([?&](?:token|key|api_key|secret|password|auth)=)[^&\s"']+/gi, "$1[REDACTED]");
  // 4. Redact key-value secrets in JSON / prose
  s = s.replace(
    /("(?:password|secret|token|apiKey|api_key|auth|authorization)"\s*:\s*)"[^"]+"/gi,
    '$1"[REDACTED]"',
  );
  return s;
}

export interface HttpRequestPayload {
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
}

/**
 * Builds an executable, safely-redacted cURL command representing what would have been sent
 * by an external effect or captured connector call.
 */
export function buildWhatWouldHaveBeenSentCurl(requestPayload: unknown): string {
  if (!requestPayload || typeof requestPayload !== "object") {
    return 'curl -X GET "https://api.example.com/captured-effect"';
  }

  const req = requestPayload as HttpRequestPayload;
  const method = (req.method || "POST").toUpperCase();
  const rawUrl = req.url || "https://api.example.com/endpoint";
  const url = redactSecretString(rawUrl);

  const lines: string[] = [`curl -X ${method} "${url}"`];

  // Headers
  const rawHeaders = req.headers ?? { "Content-Type": "application/json" };
  const headers: Record<string, string> = {};

  for (const [k, v] of Object.entries(rawHeaders)) {
    const kLower = k.toLowerCase();
    if (
      kLower === "authorization" ||
      kLower.includes("secret") ||
      kLower.includes("token") ||
      kLower.includes("key")
    ) {
      headers[k] = "Bearer [REDACTED]";
    } else {
      headers[k] = redactSecretString(String(v));
    }
  }

  for (const [k, v] of Object.entries(headers)) {
    lines.push(`  -H "${k}: ${v}"`);
  }

  // Body
  if (req.body !== undefined) {
    let bodyStr: string;
    if (typeof req.body === "string") {
      bodyStr = redactSecretString(req.body);
    } else {
      bodyStr = redactSecretString(JSON.stringify(req.body, null, 2));
    }
    lines.push(`  -d '${bodyStr}'`);
  }

  return lines.join(" \\\n");
}
