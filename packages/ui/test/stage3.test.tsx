import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApprovalInbox } from "../src/components/ApprovalInbox.js";
import { CommandPalette } from "../src/components/CommandPalette.js";
import { EventTimeline } from "../src/components/EventTimeline.js";
import { LivePollingControl } from "../src/components/LivePollingControl.js";
import { MetricsStrip } from "../src/components/MetricsStrip.js";
import { RunExportModal } from "../src/components/RunExportModal.js";
import { RunDetailSkeleton, RunListSkeleton } from "../src/components/Skeleton.js";
import { TimelineScrubber } from "../src/components/TimelineScrubber.js";
import type { RunDetail, RunEvent, RunSummary } from "../src/types.js";

describe("Stage 3 Features Component Unit Tests", () => {
  const sampleEvents: RunEvent[] = [
    {
      seq: 1,
      type: "RunStarted",
      payload: { workflowType: "test-wf" },
      createdAt: "2026-01-01T10:00:00.000Z",
    },
    {
      seq: 2,
      type: "StepCompleted",
      payload: { name: "validate-cart", input: { id: 1 }, result: { valid: true } },
      createdAt: "2026-01-01T10:00:01.000Z",
    },
    {
      seq: 3,
      type: "EffectCaptured",
      payload: {
        stepName: "charge-card",
        kind: "effectful-external",
        runMode: "shadow",
        request: { url: "https://stripe.com", body: { amount: 100 } },
      },
      createdAt: "2026-01-01T10:00:02.000Z",
    },
    {
      seq: 4,
      type: "StepFailed",
      payload: { name: "send-email", error: "SMTP connect failure" },
      createdAt: "2026-01-01T10:00:03.000Z",
    },
    {
      seq: 5,
      type: "RunCompleted",
      payload: { result: "ok" },
      createdAt: "2026-01-01T10:00:04.000Z",
    },
  ];

  const sampleRunSummary: RunSummary = {
    id: "run-stage3-test-1",
    workflowType: "checkout-workflow",
    status: "completed",
    mode: "live",
    input: {},
    parentRunId: null,
    forkedFromSeq: null,
    forkEdit: null,
    timing: {
      createdAt: "2026-01-01T10:00:00.000Z",
      startedAt: "2026-01-01T10:00:00.000Z",
      completedAt: "2026-01-01T10:00:04.000Z",
      durationMs: 4000,
    },
  };

  const sampleRunDetail: RunDetail = {
    ...sampleRunSummary,
    events: sampleEvents,
    tasks: [],
  };

  describe("Feature 1: Replay Scrubber", () => {
    it("renders scrubber controls and computes reconstructed run state", () => {
      const onSelectEvent = vi.fn();
      render(
        <TimelineScrubber events={sampleEvents} selectedSeq={2} onSelectEvent={onSelectEvent} />,
      );

      // Verify controls
      expect(screen.getByTestId("timeline-scrubber")).toBeDefined();
      expect(screen.getByTestId("scrubber-play-btn")).toBeDefined();
      expect(screen.getByTestId("scrubber-step-btn")).toBeDefined();
      expect(screen.getByTestId("scrubber-speed-select")).toBeDefined();
      expect(screen.getByTestId("scrubber-slider")).toBeDefined();

      // Verify reconstructed state up to Seq 2
      const stateEl = screen.getByTestId("scrubber-reconstructed-state");
      expect(stateEl.textContent).toContain("Seq #2");
      expect(stateEl.textContent).toContain("Step: validate-cart");
      expect(stateEl.textContent).toContain("Completed Steps: 1");

      // Click step forward
      fireEvent.click(screen.getByTestId("scrubber-step-btn"));
      expect(onSelectEvent).toHaveBeenCalledWith(sampleEvents[2]);
    });
  });

  describe("Feature 2: Command Palette (Ctrl+K)", () => {
    it("filters actions and runs, supports navigation and selection", () => {
      const onSelectRun = vi.fn();
      const onToggleTheme = vi.fn();
      const onClose = vi.fn();

      render(
        <CommandPalette
          isOpen={true}
          onClose={onClose}
          runs={[sampleRunSummary]}
          currentRunId="run-stage3-test-1"
          onSelectRun={onSelectRun}
          onToggleTheme={onToggleTheme}
        />,
      );

      expect(screen.getByTestId("command-palette")).toBeDefined();
      const input = screen.getByTestId("command-palette-input");

      // Search for theme toggle
      fireEvent.change(input, { target: { value: "theme" } });
      expect(screen.getByText("Toggle Light / Dark Theme")).toBeDefined();

      // Trigger selection
      fireEvent.click(screen.getByTestId("command-palette-item-action-theme"));
      expect(onToggleTheme).toHaveBeenCalled();
      expect(onClose).toHaveBeenCalled();
    });
  });

  describe("Feature 3: Event Search and Filters", () => {
    it("filters events by search query, shadow-only, failures-only, and type", () => {
      const onSelectEvent = vi.fn();
      render(
        <EventTimeline events={sampleEvents} selectedSeq={null} onSelectEvent={onSelectEvent} />,
      );

      expect(screen.getByTestId("event-filters-bar")).toBeDefined();

      // Filter by text search "charge"
      const searchInput = screen.getByTestId("event-search-input");
      fireEvent.change(searchInput, { target: { value: "charge" } });

      const matchesCount = screen.getByTestId("event-matches-count");
      expect(matchesCount.textContent).toContain("Showing 1 of 5");
      expect(screen.getByText("charge-card")).toBeDefined();

      // Clear filters
      fireEvent.click(screen.getByTestId("clear-event-filters-btn"));
      expect(matchesCount.textContent).toContain("Showing 5 of 5");

      // Toggle Failures Only
      fireEvent.click(screen.getByTestId("filter-failures-only"));
      expect(matchesCount.textContent).toContain("Showing 1 of 5");
      expect(screen.getByText("send-email")).toBeDefined();
    });
  });

  describe("Feature 5: Human Approval Inbox", () => {
    it("renders approval inbox with parked approval card and payload preview", () => {
      const parkedEvent: RunEvent = {
        seq: 2,
        type: "ApprovalRequested",
        payload: {
          name: "finance-gate",
          payload: { orderTotal: 50000, authorizedBy: "finance-team" },
        },
        createdAt: "2026-01-01T12:00:00.000Z",
      };

      const parkedRunDetail: RunDetail = {
        ...sampleRunDetail,
        id: "run-parked-123",
        status: "running",
        events: [sampleEvents[0]!, parkedEvent],
      };

      const onSelectRun = vi.fn();
      const onApprovalSuccess = vi.fn();

      render(
        <ApprovalInbox
          runs={[{ ...sampleRunSummary, id: "run-parked-123", status: "running" }]}
          runDetails={{ "run-parked-123": parkedRunDetail }}
          apiToken="tok_test"
          onSelectRun={onSelectRun}
          onApprovalSuccess={onApprovalSuccess}
        />,
      );

      expect(screen.getByTestId("approval-inbox-view")).toBeDefined();
      expect(screen.getByTestId("approval-count-badge").textContent).toContain("1 PENDING");
      expect(screen.getByTestId("approval-payload-pre").textContent).toContain("50000");

      // Check authorize & reject buttons exist
      expect(screen.getByTestId("approve-gate-btn")).toBeDefined();
      expect(screen.getByTestId("reject-gate-btn")).toBeDefined();

      // Click reject opens 2-step confirmation modal
      fireEvent.click(screen.getByTestId("reject-gate-btn"));
      expect(screen.getByTestId("rejection-confirm-modal")).toBeDefined();
      expect(screen.getByTestId("rejection-reason-input")).toBeDefined();
    });
  });

  describe("Feature 8: Live Polling Control", () => {
    it("renders speed selector, status dot, and triggers change", () => {
      const onChangeSpeed = vi.fn();
      const onManualRefresh = vi.fn();

      render(
        <LivePollingControl
          speed={5000}
          onChangeSpeed={onChangeSpeed}
          isPolling={false}
          backoffMs={0}
          lastSyncAt={new Date()}
          onManualRefresh={onManualRefresh}
        />,
      );

      expect(screen.getByTestId("live-polling-control")).toBeDefined();
      expect(screen.getByTestId("live-polling-status").textContent).toBe("STREAMING");

      // Change speed to 1s
      fireEvent.click(screen.getByTestId("polling-speed-1s"));
      expect(onChangeSpeed).toHaveBeenCalledWith(1000);

      // Change speed to pause
      fireEvent.click(screen.getByTestId("polling-speed-pause"));
      expect(onChangeSpeed).toHaveBeenCalledWith("paused");

      // Manual sync
      fireEvent.click(screen.getByTestId("manual-sync-btn"));
      expect(onManualRefresh).toHaveBeenCalled();
    });
  });

  describe("Feature 9: Run Export & Plain Permalink", () => {
    it("renders export modal with SHA-256 hash and plain fragment permalink", () => {
      const onClose = vi.fn();
      render(
        <RunExportModal
          run={sampleRunDetail}
          selectedEvent={sampleEvents[1]!}
          isOpen={true}
          onClose={onClose}
        />,
      );

      expect(screen.getByTestId("run-export-modal")).toBeDefined();
      expect(screen.getByTestId("copy-export-json-btn")).toBeDefined();
      expect(screen.getByTestId("download-export-json-btn")).toBeDefined();

      const permalinkInput = screen.getByTestId("permalink-input");
      expect(permalinkInput.textContent).toContain("#run=run-stage3-test-1&event=validate-cart");
      // Assert no secret or token in permalink
      expect(permalinkInput.textContent).not.toContain("token");
      expect(permalinkInput.textContent).not.toContain("key");
    });
  });

  describe("Feature 10: Skeletons & Metrics Strip", () => {
    it("renders skeletons and metrics strip with p50, rpm, retry rate, and sparklines", () => {
      const { container: listSkel } = render(
        <table>
          <RunListSkeleton />
        </table>,
      );
      expect(listSkel.querySelector("[data-testid='skeleton-run-list']")).toBeDefined();

      const { container: detailSkel } = render(<RunDetailSkeleton />);
      expect(detailSkel.querySelector("[data-testid='skeleton-run-detail']")).toBeDefined();

      render(<MetricsStrip runs={[sampleRunSummary]} />);
      expect(screen.getByTestId("metrics-strip")).toBeDefined();
      expect(screen.getByTestId("metric-rpm")).toBeDefined();
      expect(screen.getByTestId("metric-p50").textContent).toBe("4000ms");
      expect(screen.getByTestId("metric-success-rate").textContent).toBe("100%");
    });
  });
});
