import { spawn } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EventDetailPanel } from "../src/components/EventDetailPanel.js";
import type { RunEvent } from "../src/types.js";
import {
  buildWhatWouldHaveBeenSentBash,
  buildWhatWouldHaveBeenSentCurl,
  buildWhatWouldHaveBeenSentPowerShell,
  buildWhatWouldHaveBeenSentWithAudit,
  quoteBash,
  quotePowerShell,
  validateCurlRequest,
} from "../src/utils/curl.js";

describe("Milestone 5b - UI XSS & Security Rendering", () => {
  it("renders <img src=x onerror=alert(1)> and <script> as literal text without executing or injecting HTML nodes", () => {
    const maliciousPayload = {
      maliciousInput: '<img src="x" onerror="alert(1)">',
      maliciousScript: '<script>alert("hacked")</script>',
    };

    const maliciousEvent: RunEvent = {
      seq: 1,
      type: "<img src=x onerror=alert(1)>",
      payload: maliciousPayload,
      createdAt: new Date().toISOString(),
    };

    const { container } = render(<EventDetailPanel event={maliciousEvent} />);

    // 1. Assert NO <img> HTML element was created or injected into the DOM
    const imgElements = container.querySelectorAll("img");
    expect(imgElements.length).toBe(0);

    // 2. Assert NO <script> HTML element was created or injected into the DOM
    const scriptElements = container.querySelectorAll("script");
    expect(scriptElements.length).toBe(0);

    // 3. Assert the malicious payload is rendered literally as plain text
    expect(container.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(container.textContent).toContain('<img src=\\"x\\" onerror=\\"alert(1)\\">');
    expect(container.textContent).toContain('<script>alert(\\"hacked\\")</script>');
  });

  it('ensures <img src=x onerror="window.__pwned=1"> does not execute and window.__pwned remains undefined', () => {
    // biome-ignore lint/suspicious/noExplicitAny: testing XSS variable on window
    (window as any).__pwned = undefined;

    const xssEvent: RunEvent = {
      seq: 2,
      type: '<img src=x onerror="window.__pwned=1">',
      payload: {
        xssField: '<img src=x onerror="window.__pwned=1">',
      },
      createdAt: new Date().toISOString(),
    };

    const { container } = render(<EventDetailPanel event={xssEvent} />);

    // biome-ignore lint/suspicious/noExplicitAny: verify window property wasn't set
    expect((window as any).__pwned).toBeUndefined();
    expect(container.querySelectorAll("img").length).toBe(0);
    expect(container.textContent).toContain("window.__pwned=1");
  });

  it("Feature 4: 'What would have been sent' curl command redacts all planted secrets and never exposes them", () => {
    const SECRET_AUTH_TOKEN = "tok_planted_secret_99999";
    const SECRET_API_KEY = "sk-planted-api-key-88888";
    const SECRET_PASSWORD = "secret_password_77777";
    const SECRET_QUERY_TOKEN = "tok_query_secret_66666";

    const effectEvent: RunEvent = {
      seq: 3,
      type: "EffectCaptured",
      payload: {
        stepName: "send-payment",
        kind: "effectful-external",
        request: {
          url: `https://api.stripe.com/v1/charges?token=${SECRET_QUERY_TOKEN}`,
          method: "POST",
          headers: {
            Authorization: `Bearer ${SECRET_AUTH_TOKEN}`,
            "X-Api-Key": SECRET_API_KEY,
            "Content-Type": "application/json",
          },
          body: {
            amount: 5000,
            password: SECRET_PASSWORD,
            currency: "usd",
          },
        },
        resultSource: "mock",
      },
      createdAt: new Date().toISOString(),
    };

    const { getByTestId } = render(<EventDetailPanel event={effectEvent} />);

    const panel = getByTestId("what-would-have-been-sent-panel");
    expect(panel).toBeDefined();

    const curlElem = getByTestId("what-would-have-been-sent-curl");
    const curlText = curlElem.textContent ?? "";

    // 1. Assert curlText contains redacted placeholders
    expect(curlText).toContain("[REDACTED]");

    // 2. Assert NONE of the planted secrets appear in the rendered text
    expect(curlText).not.toContain(SECRET_AUTH_TOKEN);
    expect(curlText).not.toContain(SECRET_API_KEY);
    expect(curlText).not.toContain(SECRET_PASSWORD);
    expect(curlText).not.toContain(SECRET_QUERY_TOKEN);

    // 3. Assert panel text does not leak the secrets either
    const panelText = panel.textContent ?? "";
    expect(panelText).not.toContain(SECRET_AUTH_TOKEN);
    expect(panelText).not.toContain(SECRET_API_KEY);
    expect(panelText).not.toContain(SECRET_PASSWORD);
    expect(panelText).not.toContain(SECRET_QUERY_TOKEN);
  });

  it("curl quoting handles hostile shell characters safely in bash and PowerShell", () => {
    const hostileStr = `single'quote"double\`backtick\`$(whoami)\${EVIL}\nnewline\\slash; && rm -rf /`;

    // Bash quoting: wraps in single quotes, escapes ' as '\''
    const bashQuoted = quoteBash(hostileStr);
    expect(bashQuoted.startsWith("'")).toBe(true);
    expect(bashQuoted.endsWith("'")).toBe(true);
    expect(bashQuoted).toContain("'\\''");
    // Ensure every single-quote in the interior is strictly escaped as part of '\''
    const interior = bashQuoted.slice(1, -1);
    const unescapedPieces = interior.split("'\\''");
    for (const piece of unescapedPieces) {
      expect(piece).not.toContain("'");
    }

    // PowerShell quoting: wraps in single quotes, escapes ' as ''
    const psQuoted = quotePowerShell(hostileStr);
    expect(psQuoted.startsWith("'")).toBe(true);
    expect(psQuoted.endsWith("'")).toBe(true);
    expect(psQuoted).toContain("''");

    // Test command builders
    const psCmd = buildWhatWouldHaveBeenSentPowerShell({
      url: "https://example.com/api",
      body: hostileStr,
    });
    expect(psCmd).toContain("curl.exe -X POST --url");
    expect(psCmd).toContain("''");

    const defaultCmd = buildWhatWouldHaveBeenSentCurl({
      url: "https://example.com/api",
      body: hostileStr,
    });
    expect(defaultCmd).toContain("curl -X POST --url");
    expect(defaultCmd).toContain("'\\''");
  });

  it("curl exporter hardening: handles body starting with @, url starting with -, header starting with @, and control chars", () => {
    // 1. Body starting with @: must use --data-raw, never -d @
    const atBodyCmd = buildWhatWouldHaveBeenSentBash({
      url: "https://example.com/upload",
      body: "@secret_file.txt",
    });
    expect(atBodyCmd).toContain("--data-raw '@secret_file.txt'");
    expect(atBodyCmd).not.toContain("-d @");

    // 2. URL starting with -: must use --url to prevent flag injection
    const dashUrlCmd = buildWhatWouldHaveBeenSentBash({
      url: "-http://example.com/api?flag=--upload-file",
      body: "data",
    });
    expect(dashUrlCmd).toContain("--url '-http://example.com/api?flag=--upload-file'");

    // 3. Header starting with @: leading @ must be stripped
    const atHeaderCmd = buildWhatWouldHaveBeenSentBash({
      url: "https://example.com/api",
      headers: {
        "@Custom-Header": "@sensitive_value",
      },
    });
    expect(atHeaderCmd).toContain("-H 'Custom-Header: @sensitive_value'");
    expect(atHeaderCmd).not.toContain("-H '@Custom-Header");

    // 4. PowerShell: Unicode single quotes (\u2018, \u2019, \u201A, \u201B) must be doubled (no \u escapes)
    const unicodeQuotes = "text\u2018left\u2019right\u201Alow\u201Bhigh";
    const psUnicodeQuoted = quotePowerShell(unicodeQuotes);
    expect(psUnicodeQuoted).toBe(
      "'text\u2018\u2018left\u2019\u2019right\u201A\u201Alow\u201B\u201Bhigh'",
    );

    // 5. NUL and control characters must be stripped
    const controlString = "bad\u0000null\u0007bell\u001Funit";
    expect(quoteBash(controlString)).toBe("'badnullbellunit'");
    expect(quotePowerShell(controlString)).toBe("'badnullbellunit'");

    // 6. Audit alterations tracker reporting
    const { alterations } = buildWhatWouldHaveBeenSentWithAudit(
      {
        url: "-http://example.com/api with spaces",
        headers: {
          "@Injected-Header": "line1\r\nline2",
        },
        body: "@file_body\u2018quote",
      },
      "powershell",
    );

    expect(alterations).toContain("URL: whitespace percent-encoded to %20");
    expect(alterations).toContain("URL: leading '-' neutralized via --url flag");
    expect(alterations).toContain("Header name '@Injected-Header': leading '@' stripped");
    expect(alterations).toContain("Header value '@Injected-Header': newline/CRLF stripped");
    expect(alterations).toContain("Body: leading '@' handled via --data-raw literal");
    expect(alterations).toContain("Body: Unicode single quotes escaped for PowerShell");
  });

  it("executes generated bash curl command in sandbox against local counting server with hostile values", async () => {
    // 1. Setup local HTTP counting server
    let requestCount = 0;
    let receivedBody = "";
    let receivedPath = "";
    let receivedHeader = "";

    const markerFile = "test_marker_evil.tmp";
    try {
      if (existsSync(markerFile)) unlinkSync(markerFile);
    } catch {}

    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      requestCount++;
      receivedPath = req.url || "";
      receivedHeader = (req.headers["x-hostile-header"] as string) || "";

      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(chunk as Buffer);
      }
      receivedBody = Buffer.concat(chunks).toString("utf-8");

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });

    const port = (server.address() as AddressInfo).port;

    try {
      // 2. Build payload with hostile values across URL, headers, and body
      const hostileBodyObj = {
        param: `hostile'value"\`id\`$(echo evil_cmd)\${USER}; && touch ${markerFile}`,
        nested: "line1\nline2\r\nline3",
      };
      const hostileExpectedJson = JSON.stringify(hostileBodyObj, null, 2);

      const hostileReq = {
        url: `http://127.0.0.1:${port}/api/endpoint?query=val'$(echo%20injection)&&foo=bar;echo%20bad`,
        method: "POST",
        headers: {
          "X-Hostile-Header": "header'quote\"$(echo bad_header); && exit 0\r\nInjected: evil",
          "Content-Type": "application/json",
        },
        body: hostileBodyObj,
      };

      const bashCmd = buildWhatWouldHaveBeenSentBash(hostileReq);

      // Assert curl command is formed with bash single quoting and --url flag
      expect(bashCmd).toContain(
        `curl -X POST --url 'http://127.0.0.1:${port}/api/endpoint?query=val`,
      );
      expect(bashCmd).toContain("--data-raw '");

      // 3. Execute generated command in bash asynchronously so event loop stays alive
      const bashBin =
        process.platform === "win32" && existsSync("C:\\Program Files\\Git\\bin\\bash.exe")
          ? "C:\\Program Files\\Git\\bin\\bash.exe"
          : "bash";

      const child = spawn(bashBin, ["-c", bashCmd], { stdio: ["pipe", "pipe", "pipe"] });

      let stdout = "";
      child.stdout.on("data", (d) => {
        stdout += d;
      });

      await new Promise<void>((resolve, reject) => {
        child.on("close", () => resolve());
        child.on("error", reject);
      });

      expect(child.exitCode).toBe(0);
      expect(stdout).toContain('"ok":true');

      // 4. Assertions:
      // Exactly ONE HTTP request arrived at counting server
      expect(requestCount).toBe(1);

      // Path received intact with all characters passed literally (no command substitution)
      expect(receivedPath).toContain("$(echo%20injection)");

      // Header received intact without CRLF injection or subshell execution
      expect(receivedHeader).toContain("$(echo bad_header)");
      expect(receivedHeader).not.toContain("evil");

      // Body received matches exact JSON verbatim with all hostile characters intact
      expect(receivedBody).toBe(hostileExpectedJson);

      // Assert NO secondary commands executed (marker file must NOT exist)
      expect(existsSync(markerFile)).toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      try {
        if (existsSync(markerFile)) unlinkSync(markerFile);
      } catch {}
    }
  });

  describe("PowerShell quote doubling and curl exporter rejection", () => {
    it("PowerShell quote doubling: standard ASCII single quote '", () => {
      expect(quotePowerShell("foo'bar")).toBe("'foo''bar'");
    });

    it("PowerShell quote doubling: Unicode left single quote \u2018", () => {
      expect(quotePowerShell("foo\u2018bar")).toBe("'foo\u2018\u2018bar'");
    });

    it("PowerShell quote doubling: Unicode right single quote \u2019", () => {
      expect(quotePowerShell("foo\u2019bar")).toBe("'foo\u2019\u2019bar'");
    });

    it("PowerShell quote doubling: Unicode single low-9 quote \u201A", () => {
      expect(quotePowerShell("foo\u201Abar")).toBe("'foo\u201A\u201Abar'");
    });

    it("PowerShell quote doubling: Unicode single high-reversed-9 quote \u201B", () => {
      expect(quotePowerShell("foo\u201Bbar")).toBe("'foo\u201B\u201Bbar'");
    });

    it("curl exporter rejects non-http(s) URLs and invalid tokens", () => {
      expect(() => buildWhatWouldHaveBeenSentBash({ url: "javascript:alert(1)" })).toThrow(
        /Rejected non-http\(s\) URL protocol: javascript:/,
      );
      expect(() => buildWhatWouldHaveBeenSentBash({ url: "file:///etc/passwd" })).toThrow(
        /Rejected non-http\(s\) URL protocol: file:/,
      );

      const invalidProto = validateCurlRequest({ url: "ftp://example.com/file" });
      expect(invalidProto.valid).toBe(false);
      expect(invalidProto.error).toContain("Invalid URL protocol: ftp:");

      const invalidHeader = validateCurlRequest({
        url: "https://example.com",
        headers: { "@Bad-Header": "value" },
      });
      expect(invalidHeader.valid).toBe(false);
      expect(invalidHeader.error).toContain("leading '@'");

      const controlHeader = validateCurlRequest({
        url: "https://example.com",
        headers: { "X-Valid": "bad\u0000val" },
      });
      expect(controlHeader.valid).toBe(false);
      expect(controlHeader.error).toContain("control characters");
    });
  });
});
