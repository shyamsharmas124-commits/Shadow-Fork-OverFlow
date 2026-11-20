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

export interface CurlAuditResult {
  command: string;
  alterations: string[];
}

/**
 * Validates request payload against strict security rules:
 * - Reject non-http(s) URLs
 * - Reject invalid RFC 7230 header tokens (including '@')
 * - Reject control characters
 */
export function validateCurlRequest(req: HttpRequestPayload): { valid: boolean; error?: string } {
  if (req.url) {
    const stripped = req.url.replace(/^-+/, "").trim();
    const match = stripped.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
    if (match && match[1].toLowerCase() !== "http" && match[1].toLowerCase() !== "https") {
      return { valid: false, error: `Invalid URL protocol: ${match[1]}:` };
    }
    if (hasAllControlChars(req.url)) {
      return { valid: false, error: "URL contains control characters" };
    }
  }
  if (req.headers) {
    for (const [k, v] of Object.entries(req.headers)) {
      if (k.startsWith("@")) {
        return { valid: false, error: `Invalid RFC 7230 header token: leading '@' in '${k}'` };
      }
      if (!/^[!#$%&'*+\-.^_`|~0-9a-zA-Z]+$/.test(k)) {
        return { valid: false, error: `Invalid RFC 7230 header token: '${k}'` };
      }
      if (hasControlChars(String(v))) {
        return { valid: false, error: `Header value '${k}' contains control characters` };
      }
    }
  }
  if (req.body !== undefined) {
    const bodyStr = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
    if (hasControlChars(bodyStr)) {
      return { valid: false, error: "Body contains control characters" };
    }
  }
  return { valid: true };
}

export function hasControlChars(str: string): boolean {
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (
      code <= 0x08 ||
      code === 0x0b ||
      code === 0x0c ||
      (code >= 0x0e && code <= 0x1f) ||
      code === 0x7f
    ) {
      return true;
    }
  }
  return false;
}

export function stripControlChars(str: string): string {
  let out = "";
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (
      !(
        code <= 0x08 ||
        code === 0x0b ||
        code === 0x0c ||
        (code >= 0x0e && code <= 0x1f) ||
        code === 0x7f
      )
    ) {
      out += str[i];
    }
  }
  return out;
}

export function hasAllControlChars(str: string): boolean {
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

export function stripAllControlChars(str: string): string {
  let out = "";
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (!(code <= 0x1f || code === 0x7f)) {
      out += str[i];
    }
  }
  return out;
}

/**
 * Escapes a string for inclusion inside a Bash single-quoted literal ('...').
 * In POSIX bash/sh, no characters inside '...' undergo parameter expansion,
 * command substitution, or arithmetic expansion.
 * Single quotes are escaped by closing the single-quote, inserting \', and reopening: '\''
 * Control characters and NUL are removed to prevent CLI injection / truncation.
 */
export function quoteBash(str: string): string {
  const stripped = stripControlChars(str);
  return `'${stripped.replace(/'/g, "'\\''")}'`;
}

/**
 * Escapes a string for inclusion inside a PowerShell single-quoted literal ('...').
 * In PowerShell, single-quoted strings are verbatim literals: $, ` and other special characters
 * are never expanded. Single quotes and Unicode quotes (U+2018, U+2019, U+201A, U+201B)
 * are escaped by doubling them (e.g. '' or ‘’).
 * Control characters and NUL are removed to prevent CLI injection / truncation.
 */
export function quotePowerShell(str: string): string {
  const stripped = stripControlChars(str);
  return `'${stripped.replace(/['\u2018\u2019\u201A\u201B]/g, (ch) => ch + ch)}'`;
}

/**
 * Sanitizes header names to conform strictly to RFC 7230 token characters.
 * Strips leading '@' to prevent cURL from interpreting -H @file as a file read.
 */
export function sanitizeHeaderName(name: string): string {
  const withoutAt = name.replace(/^@+/, "");
  const sanitized = withoutAt.replace(/[^a-zA-Z0-9_-]/g, "");
  return sanitized || "X-Custom-Header";
}

/**
 * Sanitizes header values to prevent HTTP response splitting / CRLF injection.
 * Strips any characters starting at the first CRLF and removes control characters.
 */
export function sanitizeHeaderValue(val: string): string {
  const firstLine = val.split(/[\r\n]/)[0] || "";
  return stripControlChars(firstLine);
}

/**
 * Sanitizes URLs to prevent malformed URL failures in curl due to raw whitespace or control characters.
 * Uses --url in the generated command to protect against leading '-'.
 */
export function sanitizeUrl(url: string): string {
  const withoutWhitespace = url.replace(/\s+/g, "%20").replace(/[\r\n]/g, "");
  return stripAllControlChars(withoutWhitespace);
}

/**
 * Builds an executable cURL command for Bash with escaped arguments.
 * Uses --url to guarantee URLs starting with '-' are not parsed as flags.
 * Uses --data-raw to guarantee bodies starting with '@' are not parsed as files.
 */
export function buildWhatWouldHaveBeenSentBash(requestPayload: unknown): string {
  if (!requestPayload || typeof requestPayload !== "object") {
    return "curl -X GET --url 'https://api.example.com/captured-effect'";
  }

  const req = requestPayload as HttpRequestPayload;
  const rawUrl = req.url || "https://api.example.com/endpoint";
  const strippedProtocol = rawUrl.replace(/^-+/, "").trim();
  const protocolMatch = strippedProtocol.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
  if (protocolMatch) {
    const proto = protocolMatch[1].toLowerCase();
    if (proto !== "http" && proto !== "https") {
      throw new Error(`Rejected non-http(s) URL protocol: ${proto}:`);
    }
  }

  const method = (req.method || "POST").toUpperCase().replace(/[^A-Z]/g, "") || "POST";
  const url = sanitizeUrl(redactSecretString(rawUrl));

  const lines: string[] = [`curl -X ${method} --url ${quoteBash(url)}`];

  // Headers
  const rawHeaders = req.headers ?? { "Content-Type": "application/json" };
  const headers: Record<string, string> = {};

  for (const [k, v] of Object.entries(rawHeaders)) {
    const kClean = sanitizeHeaderName(k);
    const kLower = kClean.toLowerCase();
    if (
      kLower === "authorization" ||
      kLower.includes("secret") ||
      kLower.includes("token") ||
      kLower.includes("key")
    ) {
      headers[kClean] = "Bearer [REDACTED]";
    } else {
      headers[kClean] = sanitizeHeaderValue(redactSecretString(String(v)));
    }
  }

  for (const [k, v] of Object.entries(headers)) {
    lines.push(`  -H ${quoteBash(`${k}: ${v}`)}`);
  }

  // Body
  if (req.body !== undefined) {
    let bodyStr: string;
    if (typeof req.body === "string") {
      bodyStr = redactSecretString(req.body);
    } else {
      bodyStr = redactSecretString(JSON.stringify(req.body, null, 2));
    }
    lines.push(`  --data-raw ${quoteBash(bodyStr)}`);
  }

  return lines.join(" \\\n");
}

/**
 * Builds an executable cURL command for PowerShell with escaped arguments.
 * Uses --url to guarantee URLs starting with '-' are not parsed as flags.
 * Uses --data-raw to guarantee bodies starting with '@' are not parsed as files.
 */
export function buildWhatWouldHaveBeenSentPowerShell(requestPayload: unknown): string {
  if (!requestPayload || typeof requestPayload !== "object") {
    return "curl.exe -X GET --url 'https://api.example.com/captured-effect'";
  }

  const req = requestPayload as HttpRequestPayload;
  const rawUrl = req.url || "https://api.example.com/endpoint";
  const strippedProtocol = rawUrl.replace(/^-+/, "").trim();
  const protocolMatch = strippedProtocol.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
  if (protocolMatch) {
    const proto = protocolMatch[1].toLowerCase();
    if (proto !== "http" && proto !== "https") {
      throw new Error(`Rejected non-http(s) URL protocol: ${proto}:`);
    }
  }

  const method = (req.method || "POST").toUpperCase().replace(/[^A-Z]/g, "") || "POST";
  const url = sanitizeUrl(redactSecretString(rawUrl));

  const lines: string[] = [`curl.exe -X ${method} --url ${quotePowerShell(url)}`];

  // Headers
  const rawHeaders = req.headers ?? { "Content-Type": "application/json" };
  const headers: Record<string, string> = {};

  for (const [k, v] of Object.entries(rawHeaders)) {
    const kClean = sanitizeHeaderName(k);
    const kLower = kClean.toLowerCase();
    if (
      kLower === "authorization" ||
      kLower.includes("secret") ||
      kLower.includes("token") ||
      kLower.includes("key")
    ) {
      headers[kClean] = "Bearer [REDACTED]";
    } else {
      headers[kClean] = sanitizeHeaderValue(redactSecretString(String(v)));
    }
  }

  for (const [k, v] of Object.entries(headers)) {
    lines.push(`  -H ${quotePowerShell(`${k}: ${v}`)}`);
  }

  // Body
  if (req.body !== undefined) {
    let bodyStr: string;
    if (typeof req.body === "string") {
      bodyStr = redactSecretString(req.body);
    } else {
      bodyStr = redactSecretString(JSON.stringify(req.body, null, 2));
    }
    lines.push(`  --data-raw ${quotePowerShell(bodyStr)}`);
  }

  return lines.join(" `\n");
}

/**
 * Default exporter: returns the Bash command, or PowerShell if requested.
 */
export function buildWhatWouldHaveBeenSentCurl(
  requestPayload: unknown,
  shell: "bash" | "powershell" = "bash",
): string {
  return shell === "powershell"
    ? buildWhatWouldHaveBeenSentPowerShell(requestPayload)
    : buildWhatWouldHaveBeenSentBash(requestPayload);
}

/**
 * Builds the command and audits any values altered by sanitization.
 */
export function buildWhatWouldHaveBeenSentWithAudit(
  requestPayload: unknown,
  shell: "bash" | "powershell" = "bash",
): CurlAuditResult {
  const alterations: string[] = [];
  if (!requestPayload || typeof requestPayload !== "object") {
    return {
      command: buildWhatWouldHaveBeenSentCurl(requestPayload, shell),
      alterations: [],
    };
  }

  const req = requestPayload as HttpRequestPayload;
  const rawUrl = req.url || "https://api.example.com/endpoint";
  if (/\s/.test(rawUrl)) {
    alterations.push("URL: whitespace percent-encoded to %20");
  }
  if (rawUrl.startsWith("-")) {
    alterations.push("URL: leading '-' neutralized via --url flag");
  }
  if (hasAllControlChars(rawUrl)) {
    alterations.push("URL: control characters / NUL removed");
  }

  const rawHeaders = req.headers ?? { "Content-Type": "application/json" };
  for (const [k, v] of Object.entries(rawHeaders)) {
    if (k.startsWith("@")) {
      alterations.push(`Header name '${k}': leading '@' stripped`);
    }
    if (/[\r\n]/.test(String(v))) {
      alterations.push(`Header value '${k}': newline/CRLF stripped`);
    }
    if (hasControlChars(String(v))) {
      alterations.push(`Header value '${k}': control characters removed`);
    }
  }

  if (req.body !== undefined) {
    const bodyStr = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
    if (bodyStr.startsWith("@")) {
      alterations.push("Body: leading '@' handled via --data-raw literal");
    }
    if (shell === "powershell" && /[\u2018\u2019\u201A\u201B]/.test(bodyStr)) {
      alterations.push("Body: Unicode single quotes escaped for PowerShell");
    }
    if (hasControlChars(bodyStr)) {
      alterations.push("Body: control characters / NUL removed");
    }
  }

  const command = buildWhatWouldHaveBeenSentCurl(requestPayload, shell);
  return { command, alterations };
}
