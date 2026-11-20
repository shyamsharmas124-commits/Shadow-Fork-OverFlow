import { ArrowRight, GitCompare, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { getEffects, getRun } from "../api.js";
import type { EffectDiffItem, EffectDiffResponse, RunDetail, RunSummary } from "../types.js";
import { DiffView } from "./DiffView.js";
import { LineageGraph } from "./LineageGraph.js";

interface CompareRunsModalProps {
  isOpen: boolean;
  onClose: () => void;
  runs: RunSummary[];
  initialRunA?: string;
  initialRunB?: string;
}

export function CompareRunsModal({
  isOpen,
  onClose,
  runs,
  initialRunA,
  initialRunB,
}: CompareRunsModalProps) {
  const [runAId, setRunAId] = useState<string>(initialRunA || runs[0]?.id || "");
  const [runBId, setRunBId] = useState<string>(initialRunB || runs[1]?.id || runs[0]?.id || "");
  const [runBDetail, setRunBDetail] = useState<RunDetail | null>(null);
  const [diffData, setDiffData] = useState<EffectDiffResponse | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (initialRunA) setRunAId(initialRunA);
    if (initialRunB) setRunBId(initialRunB);
  }, [initialRunA, initialRunB]);

  const loadComparison = useCallback(async () => {
    if (!runAId || !runBId) return;
    setIsLoading(true);
    setError(null);
    try {
      // Check if Run B is a fork of Run A
      const runB = await getRun(runBId);
      setRunBDetail(runB);
      if (runB.parentRunId === runAId) {
        const effects = await getEffects(runBId);
        setDiffData(effects);
      } else {
        // Construct an ad-hoc comparison from both runs' events
        const runA = await getRun(runAId);
        const stepsA = runA.events.filter(
          (e) => e.type === "StepCompleted" || e.type === "StepFailed",
        );
        const stepsB = runB.events.filter(
          (e) => e.type === "StepCompleted" || e.type === "StepFailed",
        );

        const diffItems: EffectDiffItem[] = [];
        const occMapB: Record<string, number> = {};

        for (const eb of stepsB) {
          const pb = eb.payload as {
            name?: string;
            input?: unknown;
            result?: unknown;
            error?: string;
          };
          const name = pb.name || eb.type;
          const occ = (occMapB[name] ?? 0) + 1;
          occMapB[name] = occ;

          const ea = stepsA.find((candidate) => {
            const pa = candidate.payload as { name?: string };
            return (pa.name || candidate.type) === name;
          });

          const pa = ea
            ? (ea.payload as { input?: unknown; result?: unknown; error?: string })
            : undefined;
          const inputChanged = JSON.stringify(pa?.input) !== JSON.stringify(pb.input);

          diffItems.push({
            stepName: name,
            occurrence: occ,
            reusedFromParent: false,
            inputChangedFromParent: inputChanged,
            status: !ea ? "added" : inputChanged ? "modified" : "reused",
            parent: ea
              ? {
                  seq: ea.seq,
                  input: pa?.input,
                  result: pa?.result,
                  error: pa?.error,
                  failed: ea.type === "StepFailed",
                  effects: [],
                }
              : null,
            shadow: {
              seq: eb.seq,
              input: pb.input,
              result: pb.result,
              error: pb.error,
              failed: eb.type === "StepFailed",
              effects: [],
            },
          });
        }

        setDiffData({
          runId: runBId,
          isFork: false,
          parentRunId: runAId,
          forkedFromSeq: null,
          mode: runB.mode,
          steps: diffItems,
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to compare runs");
    } finally {
      setIsLoading(false);
    }
  }, [runAId, runBId]);

  useEffect(() => {
    if (isOpen && runAId && runBId) {
      loadComparison();
    }
  }, [isOpen, runAId, runBId, loadComparison]);

  if (!isOpen) return null;

  return (
    <div
      data-testid="compare-runs-modal"
      role="dialog"
      aria-modal="true"
      aria-label="Compare Any Two Runs"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
    >
      <div className="w-full max-w-5xl bg-[var(--bg-panel)] border border-[var(--border-hairline)] flex flex-col max-h-[90vh] font-mono text-xs overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between p-3 border-b border-[var(--border-hairline)] bg-[var(--bg-subtle)]">
          <div className="flex items-center gap-2">
            <GitCompare className="w-4 h-4 text-[var(--ink-primary)]" />
            <h2 className="text-xs font-bold uppercase tracking-wider text-[var(--ink-primary)]">
              Compare Any Two Runs &bull; Execution Alignment
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close dialog"
            className="p-1 border border-transparent hover:border-[var(--border-hairline)] text-[var(--ink-secondary)] hover:text-[var(--ink-primary)] cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Run Selectors Bar */}
        <div className="p-3 border-b border-[var(--border-hairline)] bg-[var(--bg-panel)] flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2">
              <label
                htmlFor="compare-run-a"
                className="text-[10px] uppercase font-bold text-[var(--ink-secondary)]"
              >
                Base Run (A):
              </label>
              <select
                id="compare-run-a"
                data-testid="compare-select-run-a"
                value={runAId}
                onChange={(e) => setRunAId(e.target.value)}
                className="px-2 py-1 bg-[var(--bg-subtle)] border border-[var(--border-hairline)] text-[var(--ink-primary)] text-xs focus:outline-hidden"
              >
                {runs.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.id.slice(0, 8)}... ({r.workflowType} - {r.status})
                  </option>
                ))}
              </select>
            </div>

            <ArrowRight className="w-3.5 h-3.5 text-[var(--ink-muted)]" />

            <div className="flex items-center gap-2">
              <label
                htmlFor="compare-run-b"
                className="text-[10px] uppercase font-bold text-[var(--ink-secondary)]"
              >
                Target Run (B):
              </label>
              <select
                id="compare-run-b"
                data-testid="compare-select-run-b"
                value={runBId}
                onChange={(e) => setRunBId(e.target.value)}
                className="px-2 py-1 bg-[var(--bg-subtle)] border border-[var(--border-hairline)] text-[var(--ink-primary)] text-xs focus:outline-hidden"
              >
                {runs.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.id.slice(0, 8)}... ({r.workflowType} - {r.status})
                  </option>
                ))}
              </select>
            </div>
          </div>

          <button
            type="button"
            data-testid="execute-compare-btn"
            onClick={loadComparison}
            disabled={isLoading || !runAId || !runBId}
            className="px-3 py-1 bg-[var(--bg-subtle)] hover:bg-[var(--bg-hover)] border border-[var(--border-hairline)] font-bold text-xs cursor-pointer disabled:opacity-50"
          >
            {isLoading ? "Comparing..." : "Align & Compare"}
          </button>
        </div>

        {/* Content Body - tabIndex={0} required for axe scrollable-region-focusable */}
        <section
          // biome-ignore lint/a11y/noNoninteractiveTabindex: scrollable container requires tabIndex=0 for keyboard accessibility (axe scrollable-region-focusable)
          tabIndex={0}
          aria-label="Run comparison execution diff"
          className="p-4 overflow-y-auto flex flex-col gap-4"
        >
          {error && (
            <div className="p-2 border border-[#B91C1C] text-[#B91C1C] dark:text-[#F87171] bg-[#B91C1C]/10 text-xs">
              {error}
            </div>
          )}

          {isLoading ? (
            <div className="p-12 text-center text-[var(--ink-muted)]">
              Computing diff alignment between runs...
            </div>
          ) : diffData ? (
            <>
              {runBDetail && <LineageGraph run={runBDetail} onSelectRun={setRunBId} />}
              <DiffView diff={diffData} />
            </>
          ) : (
            <div className="p-8 text-center text-[var(--ink-muted)]">
              Select two runs above to align and compare execution states.
            </div>
          )}
        </section>

        {/* Footer */}
        <div className="p-2.5 border-t border-[var(--border-hairline)] bg-[var(--bg-subtle)] flex items-center justify-between text-[11px]">
          <span className="text-[10px] text-[var(--ink-muted)]">
            Symbols: [+] Added &bull; [~] Modified &bull; [-] Removed &bull; [=] Reused / Identical
          </span>
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1 bg-[var(--bg-panel)] border border-[var(--border-hairline)] text-[var(--ink-primary)] hover:bg-[var(--bg-hover)] cursor-pointer text-xs"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
