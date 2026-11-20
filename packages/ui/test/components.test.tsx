import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type React from "react";
import { describe, expect, it, vi } from "vitest";
import * as api from "../src/api.js";
import { EventDetailPanel } from "../src/components/EventDetailPanel.js";
import { RunDetail } from "../src/components/RunDetail.js";
import { RunList } from "../src/components/RunList.js";

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

describe("UI State Components Tests (Loading, Empty, Error, 404)", () => {
  it("EventDetailPanel renders empty placeholder when no event is selected", () => {
    render(<EventDetailPanel event={null} />);
    expect(
      screen.getByText(/Select an event from the timeline to inspect its payload/i),
    ).toBeDefined();
  });

  it("EventDetailPanel renders cURL command and displays exporter alterations beside command", () => {
    const effectEvent = {
      seq: 2,
      type: "EffectCaptured",
      createdAt: new Date().toISOString(),
      payload: {
        stepName: "test-step",
        request: {
          url: "-http://example.com/api with spaces",
          method: "POST",
          headers: {
            "@Injected-Header": "line1\r\nline2",
          },
          body: "@file_body\u2018quote",
        },
      },
    };

    render(<EventDetailPanel event={effectEvent} />);

    expect(screen.getByTestId("what-would-have-been-sent-curl")).toBeDefined();
    const alterationsContainer = screen.getByTestId("curl-alterations");
    expect(alterationsContainer).toBeDefined();
    expect(alterationsContainer.textContent).toContain("Exporter Alterations:");
    expect(alterationsContainer.textContent).toContain("whitespace percent-encoded");
    expect(alterationsContainer.textContent).toContain("leading '-' neutralized");
    expect(alterationsContainer.textContent).toContain("leading '@' stripped");
  });

  it("RunList renders empty state when 0 runs are returned", async () => {
    vi.spyOn(api, "getRuns").mockResolvedValueOnce({ runs: [], total: 0 });

    render(<RunList onSelectRun={() => {}} />, { wrapper: createWrapper() });

    expect(await screen.findByText(/No workflow runs found/i)).toBeDefined();
  });

  it("RunList renders error state when API fails", async () => {
    vi.spyOn(api, "getRuns").mockRejectedValueOnce(new Error("Network connection refused"));

    render(<RunList onSelectRun={() => {}} />, { wrapper: createWrapper() });

    expect(
      await screen.findByText(/Failed to load runs: Error: Network connection refused/i),
    ).toBeDefined();
  });

  it("RunDetail renders 404 / error state when run is not found", async () => {
    vi.spyOn(api, "getRun").mockRejectedValueOnce(new Error("Run not found: test-missing-id"));

    render(<RunDetail runId="test-missing-id" onBack={() => {}} onSelectRun={() => {}} />, {
      wrapper: createWrapper(),
    });

    expect(
      await screen.findByText(/Failed to load run test-missing-id: Error: Run not found/i),
    ).toBeDefined();
  });
});
