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
});
