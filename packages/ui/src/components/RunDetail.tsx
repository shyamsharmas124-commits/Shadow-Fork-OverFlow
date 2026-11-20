import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  Check,
  Clock,
  Code,
  Download,
  GitCompare,
  GitFork,
  RefreshCw,
  ShieldAlert,
  SplitSquareVertical,
  X,
} from "lucide-react";
import { useState } from "react";
import { getEffects, getRun, submitApprovalApi } from "../api.js";
import type { RunEvent, RunSummary } from "../types.js";
import { formatDate } from "../utils/date.js";
import { Badge, ModeBadge, StatusBadge } from "./Badge.js";
import { CliSnippetModal } from "./CliSnippetModal.js";
import { CompareRunsModal } from "./CompareRunsModal.js";
import { DiffView } from "./DiffView.js";
import { EventDetailPanel } from "./EventDetailPanel.js";
import { EventTimeline } from "./EventTimeline.js";
import { ForkModal } from "./ForkModal.js";
import { LineageGraph } from "./LineageGraph.js";
import { RunExportModal } from "./RunExportModal.js";
import { RunDetailSkeleton } from "./Skeleton.js";
import { TimelineScrubber } from "./TimelineScrubber.js";

interface RunDetailProps {
  runId: string;
  onBack: () => void;
  onSelectRun: (id: string) => void;
  allRuns?: RunSummary[];
}

export function RunDetail({ runId, onBack, onSelectRun, allRuns = [] }: RunDetailProps) {
  const [selectedEvent, setSelectedEvent] = useState<RunEvent | null>(null);
  const [isForkModalOpen, setIsForkModalOpen] = useState<boolean>(false);
  const [forkTargetEvent, setForkTargetEvent] = useState<RunEvent | null>(null);
  const [activeTab, setActiveTab] = useState<"timeline" | "diff">("timeline");
  const [isSubmittingDecision, setIsSubmittingDecision] = useState<boolean>(false);
  const [approvalError, setApprovalError] = useState<string | null>(null);

  // Stage 3 Modals
  const [isCliModalOpen, setIsCliModalOpen] = useState<boolean>(false);
  const [isExportModalOpen, setIsExportModalOpen] = useState<boolean>(false);
  const [isCompareModalOpen, setIsCompareModalOpen] = useState<boolean>(false);

  const {
    data: run,
    isLoading: runLoading,
    error: runError,
    refetch,
  } = useQuery({
    queryKey: ["run", runId],
    queryFn: () => getRun(runId),
    refetchInterval: 5000,
  });

  const { data: effects } = useQuery({
    queryKey: ["effects", runId],
    queryFn: () => getEffects(runId),
    enabled: !!run,
  });

  const pendingApprovals = run
    ? (run.events
        .filter((e) => e.type === "ApprovalRequested")
        .map((e) => {
          const payload = e.payload as { name: string; payload?: unknown };
          const hasDecision = run.events.some(
            (ev) =>
              (ev.type === "ApprovalGranted" || ev.type === "ApprovalRejected") &&
              (ev.payload as { name: string }).name === payload.name,
          );
          return hasDecision ? null : { seq: e.seq, name: payload.name, payload: payload.payload };
        })
        .filter(Boolean) as Array<{ seq: number; name: string; payload?: unknown }>)
    : [];

  const handleDecision = async (name: string, decision: "approve" | "reject") => {
    try {
      setIsSubmittingDecision(true);
      setApprovalError(null);
      await submitApprovalApi(runId, name, decision);
      await refetch();
    } catch (err) {
      setApprovalError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSubmittingDecision(false);
    }
  };

  if (runLoading) {
    return (
      <div className="flex flex-col gap-4 font-mono text-xs">
        <div className="flex items-center justify-between border-b border-[var(--border-hairline)] pb-3">
          <button
            type="button"
            onClick={onBack}
            className="flex items-center gap-1.5 text-xs text-[var(--ink-secondary)] hover:text-[var(--ink-primary)] cursor-pointer"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            <span>Back to Run Registry</span>
          </button>
        </div>
        <RunDetailSkeleton />
      </div>
    );
  }

  if (runError || !run) {
    return (
      <div className="p-4 text-xs font-mono text-[var(--status-failed-fg)] bg-[var(--status-failed-bg)] border border-[var(--status-failed-border)]">
        Failed to load run {runId}: {String(runError)}
      </div>
    );
  }

  const activeEvent = selectedEvent ?? run.events[run.events.length - 1] ?? null;

  const activeStepDiff =
    activeEvent && effects
      ? effects.steps.find((s) => {
          const stepName =
            (activeEvent.payload?.name as string) || (activeEvent.payload?.stepName as string);
          return s.stepName === stepName;
        })
      : null;

  const handleOpenForkFromEvent = (event: RunEvent) => {
    setForkTargetEvent(event);
    setIsForkModalOpen(true);
  };

  return (
    <div
      className="w-full min-w-0 flex flex-col gap-4 font-mono text-xs"
      data-testid="run-detail-view"
    >
      {/* Top action bar */}
      <div className="flex flex-wrap items-center justify-between gap-2.5 border-b border-[var(--border-hairline)] pb-3">
        <button
          type="button"
          onClick={onBack}
          data-testid="back-button"
          className="flex items-center gap-1.5 text-xs text-[var(--ink-secondary)] hover:text-[var(--ink-primary)] cursor-pointer"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          <span>Back to Run Registry</span>
        </button>

        <div className="flex flex-wrap items-center gap-2">
          {/* Compare Button */}
          <button
            type="button"
            data-testid="open-compare-btn"
            onClick={() => setIsCompareModalOpen(true)}
            className="flex items-center gap-1.5 text-xs text-[var(--ink-secondary)] hover:text-[var(--ink-primary)] px-2.5 py-1 border border-[var(--border-hairline)] bg-[var(--bg-subtle)] hover:bg-[var(--bg-hover)] cursor-pointer"
            title="Compare with another run"
          >
            <GitCompare className="w-3.5 h-3.5" />
            Compare
          </button>

          {/* cURL / CLI snippets */}
          <button
            type="button"
            data-testid="open-snippets-btn"
            onClick={() => setIsCliModalOpen(true)}
            className="flex items-center gap-1.5 text-xs text-[var(--ink-secondary)] hover:text-[var(--ink-primary)] px-2.5 py-1 border border-[var(--border-hairline)] bg-[var(--bg-subtle)] hover:bg-[var(--bg-hover)] cursor-pointer"
            title="cURL and CLI commands"
          >
            <Code className="w-3.5 h-3.5" />
            cURL / CLI
          </button>

          {/* Export JSON & Permalink */}
          <button
            type="button"
            data-testid="open-export-btn"
            onClick={() => setIsExportModalOpen(true)}
            className="flex items-center gap-1.5 text-xs text-[var(--ink-secondary)] hover:text-[var(--ink-primary)] px-2.5 py-1 border border-[var(--border-hairline)] bg-[var(--bg-subtle)] hover:bg-[var(--bg-hover)] cursor-pointer"
            title="Export Redacted JSON & Permalink"
          >
            <Download className="w-3.5 h-3.5" />
            Export Trace
          </button>

          {/* Single Accent per screen: Paprika Fork Run Button (non-accent while ForkModal is open or awaiting approval) */}
          <button
            type="button"
            data-testid="open-fork-modal-btn"
            onClick={() => {
              setForkTargetEvent(activeEvent?.type === "StepCompleted" ? activeEvent : null);
              setIsForkModalOpen(true);
            }}
            className={`flex items-center gap-1.5 text-xs font-semibold px-3 py-1 cursor-pointer ${
              isForkModalOpen || pendingApprovals.length > 0
                ? "text-[var(--ink-secondary)] hover:text-[var(--ink-primary)] border border-[var(--border-hairline)] bg-[var(--bg-subtle)] hover:bg-[var(--bg-hover)]"
                : "bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-[var(--accent-fg)] border border-transparent"
            }`}
          >
            <GitFork className="w-3.5 h-3.5" />
            Fork Run
          </button>

          <button
            type="button"
            data-testid="refresh-run-btn"
            onClick={() => refetch()}
            className="flex items-center gap-1.5 text-xs text-[var(--ink-secondary)] hover:text-[var(--ink-primary)] px-2.5 py-1 border border-[var(--border-hairline)] bg-[var(--bg-subtle)] hover:bg-[var(--bg-hover)] cursor-pointer"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Refresh
          </button>
        </div>
      </div>

      {/* Fork Provenance Banner */}
      {run.mode === "shadow" && run.parentRunId && (
        <div
          data-testid="fork-provenance-banner"
          className="flex flex-col gap-1.5 p-3 border border-[var(--status-shadow-border)] bg-[var(--status-shadow-bg)] text-[var(--status-shadow-fg)]"
        >
          <div className="flex items-center gap-2 font-bold text-xs">
            <GitFork className="w-4 h-4 shrink-0 text-[var(--ink-primary)]" />
            <span>
              Shadow fork of{" "}
              <button
                type="button"
                onClick={() => onSelectRun(run.parentRunId!)}
                className="underline hover:opacity-80 font-mono font-bold"
              >
                {run.parentRunId}
              </button>{" "}
              at seq {run.forkedFromSeq}: effectful steps were not executed against live services
            </span>
          </div>
          <p className="text-[11px] text-[var(--ink-secondary)] pl-6">
            Replay with overrides: state up to seq {run.forkedFromSeq} was seeded from parent
            history. External calls from connectors are captured, not sent; other egress paths may
            not be blocked (see README limits).
          </p>
        </div>
      )}

      {/* Pending Approval Gate Cards */}
      {pendingApprovals.map((appr) => (
        <div
          key={appr.name}
          data-testid={`pending-approval-card-${appr.name}`}
          className="flex flex-col gap-2.5 p-3 border border-[var(--status-running-border)] bg-[var(--status-running-bg)] text-[var(--status-running-fg)]"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <ShieldAlert className="w-4 h-4 shrink-0" />
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-bold text-xs uppercase tracking-wide">
                    Action Required: Human Approval Gate
                  </span>
                  <Badge variant="warning">Awaiting Decision</Badge>
                </div>
                <span className="text-[11px] opacity-90">
                  Gate: {appr.name} (Seq {appr.seq})
                </span>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                data-testid={`approve-btn-${appr.name}`}
                onClick={() => handleDecision(appr.name, "approve")}
                disabled={isSubmittingDecision}
                className="px-3 py-1 text-xs font-bold bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-[var(--accent-fg)] disabled:opacity-50 cursor-pointer border border-transparent flex items-center gap-1"
              >
                <Check className="w-3.5 h-3.5" /> Approve
              </button>
              <button
                type="button"
                data-testid={`reject-btn-${appr.name}`}
                onClick={() => handleDecision(appr.name, "reject")}
                disabled={isSubmittingDecision}
                className="px-3 py-1 text-xs font-bold bg-[#B91C1C] dark:bg-[#F87171] text-white dark:text-[#321616] hover:opacity-90 disabled:opacity-50 cursor-pointer border border-transparent flex items-center gap-1"
              >
                <X className="w-3.5 h-3.5" /> Reject
              </button>
            </div>
          </div>
          {appr.payload !== undefined && appr.payload !== null && (
            <div className="mt-1">
              <span className="text-[10px] font-bold uppercase tracking-wider block mb-1 text-[var(--ink-secondary)]">
                Approval Request Payload
              </span>
              <pre className="p-2 bg-[var(--bg-subtle)] border border-[var(--border-hairline)] text-xs text-[var(--ink-primary)] overflow-x-auto whitespace-pre-wrap break-all">
                <code>{JSON.stringify(appr.payload, null, 2)}</code>
              </pre>
            </div>
          )}
          {approvalError && (
            <div className="text-[11px] text-[var(--status-failed-fg)] bg-[var(--status-failed-bg)] p-1.5 border border-[var(--status-failed-border)]">
              {approvalError}
            </div>
          )}
        </div>
      ))}

      {/* Header Info Panel */}
      <div className="flex flex-col gap-2.5 p-3.5 border border-[var(--border-hairline)] bg-[var(--bg-panel)]">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <h1 className="text-sm font-mono font-bold text-[var(--ink-primary)] view-transition-run-id">
              {run.id}
            </h1>
            <StatusBadge status={run.status} />
            <ModeBadge mode={run.mode} />
          </div>
          <div className="flex items-center gap-3 text-[11px] text-[var(--ink-secondary)] tabular-nums">
            <span className="flex items-center gap-1">
              <Clock className="w-3.5 h-3.5 text-[var(--ink-muted)]" />
              Duration:{" "}
              {run.timing.durationMs !== null ? `${run.timing.durationMs}ms` : "In Progress"}
            </span>
            <span>Created: {formatDate(run.timing.createdAt)}</span>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-2.5 pt-2.5 border-t border-[var(--border-hairline)] text-[11px]">
          <div>
            <span className="text-[var(--ink-muted)]">Workflow: </span>
            <span className="font-bold text-[var(--ink-primary)]">{run.workflowType}</span>
          </div>
          <div>
            <span className="text-[var(--ink-muted)]">Parent Run: </span>
            {run.parentRunId ? (
              <button
                type="button"
                onClick={() => onSelectRun(run.parentRunId!)}
                className="text-[var(--ink-secondary)] hover:text-[var(--ink-primary)] underline cursor-pointer"
              >
                {run.parentRunId} (seq {run.forkedFromSeq})
              </button>
            ) : (
              <span className="text-[var(--ink-muted)]">None (Root)</span>
            )}
          </div>
          <div>
            <span className="text-[var(--ink-muted)]">Events Recorded: </span>
            <span className="font-bold text-[var(--ink-primary)] tabular-nums">
              {run.events.length}
            </span>
          </div>
        </div>
      </div>

      {/* Feature 1: Replay Scrubber */}
      <TimelineScrubber
        events={run.events}
        selectedSeq={activeEvent?.seq ?? null}
        onSelectEvent={setSelectedEvent}
      />

      {/* Lineage & Fork Tree Graph */}
      <LineageGraph run={run} onSelectRun={onSelectRun} allRuns={allRuns} />

      {/* View Tabs */}
      <div className="flex items-center gap-2 border-b border-[var(--border-hairline)]">
        <button
          type="button"
          data-testid="tab-timeline"
          onClick={() => setActiveTab("timeline")}
          className={`pb-2 px-3 text-xs font-mono font-semibold border-b-2 cursor-pointer transition-colors ${
            activeTab === "timeline"
              ? "border-[var(--ink-primary)] text-[var(--ink-primary)]"
              : "border-transparent text-[var(--ink-muted)] hover:text-[var(--ink-primary)]"
          }`}
        >
          Timeline & Events ({run.events.length})
        </button>
        {effects?.steps && effects.steps.length > 0 && (
          <button
            type="button"
            data-testid="tab-diff"
            onClick={() => setActiveTab("diff")}
            className={`pb-2 px-3 text-xs font-mono font-semibold border-b-2 cursor-pointer transition-colors flex items-center gap-1.5 ${
              activeTab === "diff"
                ? "border-[var(--ink-primary)] text-[var(--ink-primary)]"
                : "border-transparent text-[var(--ink-muted)] hover:text-[var(--ink-primary)]"
            }`}
          >
            <SplitSquareVertical className="w-3.5 h-3.5" />
            Execution Diff ({effects.steps.length})
          </button>
        )}
      </div>

      {activeTab === "timeline" ? (
        /* Timeline & Detail Split */
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="flex flex-col gap-2">
            <h2 className="text-[11px] font-bold text-[var(--ink-secondary)] uppercase tracking-wider">
              Event Timeline ({run.events.length})
            </h2>
            <EventTimeline
              events={run.events}
              selectedSeq={activeEvent?.seq ?? null}
              onSelectEvent={setSelectedEvent}
              diffSteps={effects?.steps}
            />
          </div>

          <div className="flex flex-col gap-2">
            <h2 className="text-[11px] font-bold text-[var(--ink-secondary)] uppercase tracking-wider">
              Event Inspection & Details
            </h2>
            <EventDetailPanel
              event={activeEvent}
              stepDiff={activeStepDiff}
              onForkFromStep={handleOpenForkFromEvent}
            />
          </div>
        </div>
      ) : (
        /* Side-by-Side Diff View */
        effects && <DiffView diff={effects} />
      )}

      {/* Active Tasks Panel */}
      {run.tasks.length > 0 && (
        <div className="flex flex-col gap-2 p-3 border border-[var(--border-hairline)] bg-[var(--bg-panel)]">
          <div className="flex items-center justify-between">
            <h2 className="text-[11px] font-bold text-[var(--ink-secondary)] uppercase tracking-wider">
              Task State & Leases ({run.tasks.length})
            </h2>
            <span className="text-[10px] text-[var(--ink-muted)]">
              Idempotency Key derived: ${"{runId}"}:${"{stepName}"}:${"{occurrence}"}
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs text-left border-collapse">
              <thead className="bg-[var(--bg-subtle)] text-[var(--ink-secondary)] uppercase text-[10px] border-b border-[var(--border-hairline)]">
                <tr>
                  <th className="p-2 font-bold">Step Key</th>
                  <th className="p-2 font-bold">Status</th>
                  <th className="p-2 font-bold">Attempt</th>
                  <th className="p-2 font-bold">Lease Owner</th>
                  <th className="p-2 font-bold">Run At</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border-hairline)] font-mono">
                {run.tasks.map((task) => (
                  <tr key={task.id} className="hover:bg-[var(--bg-hover)]">
                    <td className="p-2 font-bold text-[var(--ink-primary)]">{task.stepKey}</td>
                    <td className="p-2">
                      <span className="capitalize">{task.status}</span>
                    </td>
                    <td className="p-2 tabular-nums">{task.attempt}</td>
                    <td className="p-2 text-[var(--ink-secondary)]">{task.leaseOwner ?? "None"}</td>
                    <td className="p-2 text-[var(--ink-secondary)] tabular-nums">
                      {formatDate(task.runAt, { timeOnly: true })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Fork Modal */}
      <ForkModal
        run={run}
        initialEvent={forkTargetEvent}
        isOpen={isForkModalOpen}
        onClose={() => {
          setIsForkModalOpen(false);
          setForkTargetEvent(null);
        }}
        onForkSuccess={(forkRunId) => {
          setIsForkModalOpen(false);
          setForkTargetEvent(null);
          onSelectRun(forkRunId);
        }}
      />

      {/* Feature 4: Cli / cURL Snippet Modal */}
      <CliSnippetModal run={run} isOpen={isCliModalOpen} onClose={() => setIsCliModalOpen(false)} />

      {/* Feature 9: Run Export & Permalink Modal */}
      <RunExportModal
        run={run}
        selectedEvent={activeEvent}
        isOpen={isExportModalOpen}
        onClose={() => setIsExportModalOpen(false)}
      />

      {/* Feature 6: Compare Any Two Runs Modal */}
      <CompareRunsModal
        isOpen={isCompareModalOpen}
        onClose={() => setIsCompareModalOpen(false)}
        runs={allRuns}
        initialRunA={run.parentRunId || run.id}
        initialRunB={run.id}
      />
    </div>
  );
}
