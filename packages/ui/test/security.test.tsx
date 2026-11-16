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
});
