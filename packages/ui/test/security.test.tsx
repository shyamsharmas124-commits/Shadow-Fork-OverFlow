import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EventDetailPanel } from "../src/components/EventDetailPanel.js";
import type { RunEvent } from "../src/types.js";

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
});
