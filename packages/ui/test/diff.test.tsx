import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DiffView } from "../src/components/DiffView.js";
import type { EffectDiffResponse } from "../src/types.js";

describe("Milestone 5c - DiffView Unit Tests", () => {
  it("aligns repeated step names by occurrence correctly without collision", () => {
    const diffData: EffectDiffResponse = {
      runId: "fork-run-123",
      isFork: true,
      parentRunId: "parent-run-123",
      forkedFromSeq: 3,
      mode: "shadow",
      steps: [
        {
          stepName: "process-item",
          occurrence: 0,
          reusedFromParent: true,
          inputChangedFromParent: false,
          status: "reused",
          parent: {
            seq: 2,
            input: { item: "A", id: 101 },
            result: { processed: true, item: "A" },
            effects: [],
          },
          shadow: {
            seq: 2,
            input: { item: "A", id: 101 },
            result: { processed: true, item: "A" },
            effects: [],
          },
        },
        {
          stepName: "process-item",
          occurrence: 1,
          reusedFromParent: false,
          inputChangedFromParent: true,
          status: "modified",
          parent: {
            seq: 4,
            input: { item: "B", id: 102 },
            result: { processed: true, item: "B" },
            effects: [],
          },
          shadow: {
            seq: 4,
            input: { item: "B-EDITED", id: 102 },
            result: { processed: true, item: "B-EDITED" },
            effects: [],
          },
        },
        {
          stepName: "process-item",
          occurrence: 2,
          reusedFromParent: false,
          inputChangedFromParent: true,
          status: "added",
          parent: null,
          shadow: {
            seq: 6,
            input: { item: "C-NEW", id: 103 },
            result: { processed: true, item: "C-NEW" },
            effects: [],
          },
        },
      ],
    };

    const { container } = render(<DiffView diff={diffData} />);

    // Assert all 3 occurrences are rendered distinctly
    expect(screen.getByTestId("diff-step-process-item-0")).toBeDefined();
    expect(screen.getByTestId("diff-step-process-item-1")).toBeDefined();
    expect(screen.getByTestId("diff-step-process-item-2")).toBeDefined();

    expect(container.textContent).toContain("occ 0");
    expect(container.textContent).toContain("occ 1");
    expect(container.textContent).toContain("occ 2");

    // Status badges
    expect(container.textContent).toContain("Reused from Parent");
    expect(container.textContent).toContain("Modified / Edited");
    expect(container.textContent).toContain("Added in Fork");

    // Values in respective cards
    expect(container.textContent).toContain('"item": "A"');
    expect(container.textContent).toContain('"item": "B-EDITED"');
    expect(container.textContent).toContain('"item": "C-NEW"');
  });

  it("renders provenance warning when inputChangedFromParent and reusedFromParent are true", () => {
    const diffData: EffectDiffResponse = {
      runId: "fork-run-456",
      isFork: true,
      parentRunId: "parent-run-456",
      forkedFromSeq: 2,
      mode: "shadow",
      steps: [
        {
          stepName: "step-warn",
          occurrence: 0,
          reusedFromParent: true,
          inputChangedFromParent: true,
          status: "modified",
          parent: {
            seq: 2,
            input: { amount: 100 },
            result: { approved: true },
            effects: [],
          },
          shadow: {
            seq: 2,
            input: { amount: 500 },
            result: { approved: true },
            effects: [],
          },
        },
      ],
    };

    render(<DiffView diff={diffData} />);

    const warning = screen.getByTestId("diff-provenance-warning");
    expect(warning).toBeDefined();
    expect(warning.textContent).toContain(
      "This result is from the original run and was produced from different input.",
    );
  });

  it("safely escapes XSS payloads in diff without executing script or injecting DOM nodes", () => {
    // biome-ignore lint/suspicious/noExplicitAny: testing XSS window pollution
    (window as any).__pwned = undefined;

    const maliciousDiff: EffectDiffResponse = {
      runId: "fork-xss",
      isFork: true,
      parentRunId: "parent-xss",
      forkedFromSeq: 2,
      mode: "shadow",
      steps: [
        {
          stepName: "<script>alert('xss')</script>",
          occurrence: 0,
          reusedFromParent: false,
          inputChangedFromParent: true,
          status: "modified",
          parent: {
            seq: 2,
            input: { payload: '<img src=x onerror="window.__pwned=1">' },
            result: { val: "<b onmouseover=alert(1)>bold</b>" },
            effects: [],
          },
          shadow: {
            seq: 2,
            input: { payload: '<img src=x onerror="window.__pwned=1">' },
            result: { val: "<iframe src=javascript:alert(1)>" },
            effects: [
              {
                kind: "<img src=x onerror=1>",
                request: { url: 'javascript:alert("pwned")' },
                wouldHaveResult: "<script>window.__pwned=2</script>",
                resultSource: "mock",
              },
            ],
          },
        },
      ],
    };

    const { container } = render(<DiffView diff={maliciousDiff} />);

    // Assert NO <img>, <script>, or <iframe> HTML nodes were injected
    expect(container.querySelectorAll("img").length).toBe(0);
    expect(container.querySelectorAll("script").length).toBe(0);
    expect(container.querySelectorAll("iframe").length).toBe(0);

    // Assert window was not modified
    // biome-ignore lint/suspicious/noExplicitAny: verify window property wasn't set
    expect((window as any).__pwned).toBeUndefined();

    // Assert literal text is rendered harmlessly
    expect(container.textContent).toContain("<script>alert('xss')</script>");
    expect(container.textContent).toContain("window.__pwned=1");
  });
});
