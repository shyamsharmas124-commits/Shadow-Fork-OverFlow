import { AlertTriangle, GitFork, Sparkles } from "lucide-react";
import type { EffectDiffItem, RunEvent } from "../types.js";
import { formatDate } from "../utils/date.js";
import { Badge } from "./Badge.js";

interface EventDetailPanelProps {
  event: RunEvent | null;
  stepDiff?: EffectDiffItem | null;
  onForkFromStep?: (event: RunEvent) => void;
}

export function EventDetailPanel({ event, stepDiff, onForkFromStep }: EventDetailPanelProps) {
  if (!event) {
    return (
      <div className="h-full flex items-center justify-center p-6 text-center text-[var(--ink-muted)] text-xs border border-[var(--border-hairline)] bg-[var(--bg-panel)] font-mono">
        Select an event from the timeline to inspect its payload and shadow execution diff.
      </div>
    );
  }

  const p = (event.payload ?? {}) as Record<string, unknown>;
  const isEffectCaptured = event.type === "EffectCaptured";

  const isReused = (stepDiff?.reusedFromParent ?? false) || Boolean(p.reusedFromParent);
  const isInputChanged =
    (stepDiff?.inputChangedFromParent ?? false) || Boolean(p.inputChangedFromParent);
  const resultSource =
    (p.resultSource as string | undefined) ?? stepDiff?.shadow?.effects?.[0]?.resultSource;
  const isMock = resultSource === "mock";

  return (
    <div
      data-testid="event-detail-panel"
      className="p-3.5 border border-[var(--border-hairline)] bg-[var(--bg-panel)] flex flex-col gap-3 font-mono text-xs text-[var(--ink-primary)]"
    >
      <div className="flex items-center justify-between pb-2.5 border-b border-[var(--border-hairline)]">
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs px-1.5 py-0.5 bg-[var(--bg-subtle)] border border-[var(--border-hairline)] text-[var(--ink-primary)] font-bold">
            Seq {event.seq}
          </span>
          <span className="font-bold text-[var(--ink-primary)]">{event.type}</span>
        </div>
        <div className="flex items-center gap-1.5">
          {event.type === "StepCompleted" && onForkFromStep && (
            <button
              type="button"
              data-testid="fork-from-step-btn"
              onClick={() => onForkFromStep(event)}
              className="flex items-center gap-1 text-[11px] text-[var(--ink-primary)] hover:text-white bg-[var(--bg-subtle)] hover:bg-[var(--accent)] border border-[var(--border-hairline)] px-2 py-0.5 cursor-pointer transition-colors"
            >
              <GitFork className="w-3 h-3" />
              Fork from this step
            </button>
          )}
          {isReused && <Badge variant="cyan">reusedFromParent</Badge>}
          {isInputChanged && <Badge variant="warning">inputChangedFromParent</Badge>}
          {isMock && <Badge variant="shadow">mock</Badge>}
          <span className="text-[11px] text-[var(--ink-secondary)] tabular-nums">
            {formatDate(event.createdAt, { timeOnly: true })}
          </span>
        </div>
      </div>

      {/* Warning banner when input was modified in fork but effect was reused from parent */}
      {isInputChanged && isReused && (
        <div
          data-testid="reused-input-warning"
          className="p-2 bg-[var(--status-running-bg)] border border-[var(--status-running-border)] text-[var(--status-running-fg)] flex items-start gap-2"
        >
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <div className="flex flex-col gap-0.5 text-[11px]">
            <span className="font-bold">Provenance Warning:</span>
            <span>This result is from the original run and was produced from different input.</span>
          </div>
        </div>
      )}

      {/* Mock substitution explanation */}
      {isEffectCaptured && isMock && (
        <div
          data-testid="mock-substitution-notice"
          className="p-2.5 bg-[var(--status-shadow-bg)] border border-[var(--status-shadow-border)] text-[var(--status-shadow-fg)] flex items-start gap-2"
        >
          <Sparkles className="w-4 h-4 shrink-0 mt-0.5 text-[var(--ink-primary)]" />
          <div className="flex flex-col gap-0.5 text-[11px]">
            <span className="font-bold">Mock Substitution (Safe Isolation):</span>
            <span>
              This effect used an injected mock rather than calling the real external connector. The
              step succeeded using simulated responses without external mutations.
            </span>
          </div>
        </div>
      )}

      {stepDiff && (
        <div className="p-2.5 bg-[var(--bg-subtle)] border border-[var(--border-hairline)] text-xs flex flex-col gap-1.5">
          <div className="text-[var(--ink-secondary)] font-bold uppercase tracking-wider text-[10px]">
            Step Diff Metadata
          </div>
          <div className="grid grid-cols-2 gap-2 text-[11px]">
            <div>
              <span className="text-[var(--ink-muted)]">Step: </span>
              <span className="font-bold text-[var(--ink-primary)]">{stepDiff.stepName}</span> (occ{" "}
              {stepDiff.occurrence})
            </div>
            <div>
              <span className="text-[var(--ink-muted)]">Diff Status: </span>
              <span className="font-bold text-[var(--ink-primary)] capitalize">
                {stepDiff.status}
              </span>
            </div>
            {resultSource && (
              <div className="col-span-2">
                <span className="text-[var(--ink-muted)]">Result Source: </span>
                <span className="font-bold text-[var(--ink-primary)] capitalize">
                  {resultSource}
                </span>
              </div>
            )}
          </div>
        </div>
      )}

      <div>
        <div className="text-[10px] font-bold text-[var(--ink-secondary)] uppercase tracking-wider mb-1">
          Payload JSON
        </div>
        <pre className="p-2.5 bg-[var(--bg-subtle)] border border-[var(--border-hairline)] text-xs font-mono text-[var(--ink-primary)] overflow-x-auto max-h-96 whitespace-pre-wrap break-all">
          <code data-testid="event-payload-json">{JSON.stringify(event.payload, null, 2)}</code>
        </pre>
      </div>
    </div>
  );
}
