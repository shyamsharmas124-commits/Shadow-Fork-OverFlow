import { AlertTriangle, ChevronDown, ChevronUp, GitFork, Sparkles } from "lucide-react";
import { useState } from "react";
import type { EffectDiffItem, EffectDiffResponse } from "../types.js";
import { Badge } from "./Badge.js";

interface DiffViewProps {
  diff: EffectDiffResponse;
}

function JsonTruncated({ data, maxChars = 200 }: { data: unknown; maxChars?: number }) {
  const [expanded, setExpanded] = useState<boolean>(false);
  const text = JSON.stringify(data, null, 2) ?? "null";

  if (text.length <= maxChars) {
    return (
      <pre className="p-2 bg-[var(--bg-subtle)] border border-[var(--border-hairline)] text-[11px] font-mono text-[var(--ink-primary)] overflow-x-auto whitespace-pre-wrap break-all">
        <code>{text}</code>
      </pre>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <pre className="p-2 bg-[var(--bg-subtle)] border border-[var(--border-hairline)] text-[11px] font-mono text-[var(--ink-primary)] overflow-x-auto whitespace-pre-wrap break-all max-h-48 overflow-y-auto">
        <code>{expanded ? text : `${text.slice(0, maxChars)}...`}</code>
      </pre>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="text-[10px] font-mono text-[var(--ink-primary)] hover:underline self-start flex items-center gap-1 cursor-pointer"
      >
        {expanded ? (
          <>
            <ChevronUp className="w-3 h-3" /> Show less
          </>
        ) : (
          <>
            <ChevronDown className="w-3 h-3" /> Show more ({text.length} chars)
          </>
        )}
      </button>
    </div>
  );
}

function StepDiffCard({ item }: { item: EffectDiffItem }) {
  const getStatusBadge = (status: EffectDiffItem["status"]) => {
    switch (status) {
      case "reused":
        return (
          <Badge variant="cyan">
            <span aria-hidden="true" className="mr-1 font-mono">
              [=]
            </span>
            Reused from Parent
          </Badge>
        );
      case "modified":
        return (
          <Badge variant="shadow">
            <span aria-hidden="true" className="mr-1 font-mono">
              [~]
            </span>
            Modified / Edited
          </Badge>
        );
      case "added":
        return (
          <Badge variant="success">
            <span aria-hidden="true" className="mr-1 font-mono">
              [+]
            </span>
            Added in Fork
          </Badge>
        );
      case "failed-in-parent":
        return (
          <Badge variant="danger">
            <span aria-hidden="true" className="mr-1 font-mono">
              [!]
            </span>
            Failed in Parent
          </Badge>
        );
      case "only-in-parent":
        return (
          <Badge variant="default">
            <span aria-hidden="true" className="mr-1 font-mono">
              [-]
            </span>
            Only in Parent
          </Badge>
        );
      case "live":
        return (
          <Badge variant="default">
            <span aria-hidden="true" className="mr-1 font-mono">
              [=]
            </span>
            Live
          </Badge>
        );
    }
  };

  const hasProvenanceWarning = item.inputChangedFromParent && item.reusedFromParent;

  return (
    <div
      data-testid={`diff-step-${item.stepName}-${item.occurrence}`}
      className="flex flex-col border border-[var(--border-hairline)] bg-[var(--bg-panel)] overflow-hidden font-mono text-xs"
    >
      {/* Step Header */}
      <div className="flex items-center justify-between p-2.5 bg-[var(--bg-subtle)] border-b border-[var(--border-hairline)]">
        <div className="flex items-center gap-2">
          <span className="font-bold text-xs text-[var(--ink-primary)]">{item.stepName}</span>
          <span className="text-[10px] text-[var(--ink-muted)]">occ {item.occurrence}</span>
          {getStatusBadge(item.status)}
        </div>
        <div className="flex items-center gap-1.5">
          {item.reusedFromParent && <Badge variant="cyan">reusedFromParent</Badge>}
          {item.inputChangedFromParent && <Badge variant="warning">inputChangedFromParent</Badge>}
        </div>
      </div>

      {/* Provenance Warning Banner */}
      {hasProvenanceWarning && (
        <div
          data-testid="diff-provenance-warning"
          className="m-2.5 p-2 bg-[var(--status-running-bg)] border border-[var(--status-running-border)] text-[var(--status-running-fg)] flex items-start gap-2"
        >
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <div className="flex flex-col gap-0.5 text-[11px]">
            <span className="font-bold">Provenance Warning:</span>
            <span>This result is from the original run and was produced from different input.</span>
          </div>
        </div>
      )}

      {/* Side-by-side comparison */}
      <div className="grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-[var(--border-hairline)] p-3 gap-3 text-xs">
        {/* Left Column: Parent Run */}
        <div className="flex flex-col gap-2.5">
          <div className="flex items-center justify-between pb-1 border-b border-[var(--border-hairline)] font-bold text-[var(--ink-secondary)]">
            <span>Parent Run (Live)</span>
            {item.parent?.seq !== undefined && (
              <span className="text-[10px] text-[var(--ink-secondary)]">Seq {item.parent.seq}</span>
            )}
          </div>
          {item.parent ? (
            <div className="flex flex-col gap-2">
              <div>
                <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--ink-secondary)] mb-0.5 block">
                  Input
                </span>
                <JsonTruncated data={item.parent.input} />
              </div>
              {item.parent.failed ? (
                <div>
                  <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--status-failed-fg)] mb-0.5 block">
                    Parent Error
                  </span>
                  <div
                    data-testid="diff-parent-error"
                    className="p-2 bg-[var(--status-failed-bg)] border border-[var(--status-failed-border)] text-[var(--status-failed-fg)] text-xs break-all"
                  >
                    {item.parent.error ?? "Failed in parent"}
                  </div>
                </div>
              ) : (
                <div>
                  <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--ink-secondary)] mb-0.5 block">
                    Result
                  </span>
                  <JsonTruncated data={item.parent.result} />
                </div>
              )}
              {item.parent.effects && item.parent.effects.length > 0 && (
                <div>
                  <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--ink-secondary)] mb-0.5 block">
                    Effects ({item.parent.effects.length})
                  </span>
                  <div className="flex flex-col gap-1.5">
                    {item.parent.effects.map((eff) => (
                      <div
                        key={`${eff.kind}-${JSON.stringify(eff.request)}`}
                        className="p-2 bg-[var(--bg-subtle)] border border-[var(--border-hairline)] flex flex-col gap-1"
                      >
                        <div className="flex items-center justify-between">
                          <span className="font-bold text-[var(--ink-primary)]">{eff.kind}</span>
                          {eff.resultSource && (
                            <span className="text-[10px] text-[var(--ink-muted)]">
                              source: {eff.resultSource}
                            </span>
                          )}
                        </div>
                        <JsonTruncated data={eff.request} maxChars={150} />
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="p-4 text-center text-[var(--ink-muted)] italic">
              Step did not execute in parent run.
            </div>
          )}
        </div>

        {/* Right Column: Shadow Fork */}
        <div
          className={`flex flex-col gap-2.5 ${item.status === "modified" ? "animate-tint-flash" : ""}`}
        >
          <div className="flex items-center justify-between pb-1 border-b border-[var(--border-hairline)] font-bold text-[var(--ink-primary)]">
            <span>Shadow Fork</span>
            {item.shadow?.seq !== undefined && (
              <span className="text-[10px] text-[var(--ink-secondary)]">Seq {item.shadow.seq}</span>
            )}
          </div>
          {item.shadow ? (
            <div className="flex flex-col gap-2">
              <div>
                <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--ink-secondary)] mb-0.5 block">
                  Input
                </span>
                <JsonTruncated data={item.shadow.input} />
              </div>
              <div>
                <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--ink-secondary)] mb-0.5 block">
                  Result
                </span>
                <JsonTruncated data={item.shadow.result} />
              </div>
              {item.shadow.effects && item.shadow.effects.length > 0 && (
                <div>
                  <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--ink-secondary)] mb-0.5 block">
                    Captured Effects ({item.shadow.effects.length})
                  </span>
                  <div className="flex flex-col gap-1.5">
                    {item.shadow.effects.map((eff) => {
                      const isMock = eff.resultSource === "mock";
                      return (
                        <div
                          key={`${eff.kind}-${eff.resultSource}-${JSON.stringify(eff.request)}`}
                          className="p-2 bg-[var(--bg-subtle)] border border-[var(--border-hairline)] flex flex-col gap-1"
                        >
                          <div className="flex items-center justify-between">
                            <span className="font-bold text-[var(--ink-primary)]">{eff.kind}</span>
                            <div className="flex items-center gap-1.5">
                              {isMock && (
                                <span className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] bg-[var(--status-shadow-bg)] border border-[var(--status-shadow-border)] text-[var(--status-shadow-fg)] font-mono">
                                  <Sparkles className="w-2.5 h-2.5" /> mock
                                </span>
                              )}
                              {eff.resultSource && !isMock && (
                                <span className="text-[10px] text-[var(--ink-muted)]">
                                  source: {eff.resultSource}
                                </span>
                              )}
                            </div>
                          </div>
                          <JsonTruncated data={eff.request} maxChars={150} />
                          {eff.wouldHaveResult !== undefined && (
                            <div>
                              <span className="text-[10px] text-[var(--ink-muted)] block mb-0.5">
                                Would Have Returned:
                              </span>
                              <JsonTruncated data={eff.wouldHaveResult} maxChars={150} />
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="p-4 text-center text-[var(--ink-muted)] italic">
              Step did not execute in shadow fork.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function DiffView({ diff }: DiffViewProps) {
  if (!diff.steps || diff.steps.length === 0) {
    return (
      <div className="p-6 text-center text-[var(--ink-muted)] text-xs border border-[var(--border-hairline)] bg-[var(--bg-panel)] font-mono">
        No step diff items available to compare.
      </div>
    );
  }

  return (
    <div data-testid="diff-view" className="flex flex-col gap-3 font-mono">
      {/* Diff View Header */}
      <div className="flex flex-wrap items-center justify-between gap-2.5 p-3 border border-[var(--border-hairline)] bg-[var(--bg-panel)]">
        <div className="flex items-center gap-2">
          <GitFork className="w-4 h-4 text-[var(--ink-primary)]" />
          <span className="text-xs font-bold uppercase tracking-wider text-[var(--ink-primary)]">
            Execution Diff &bull; State & Effect Comparison
          </span>
          <span className="text-[11px] text-[var(--ink-secondary)]">
            Parent ({diff.parentRunId?.slice(0, 8)}...) vs Shadow Fork ({diff.runId.slice(0, 8)}...)
          </span>
        </div>
        <div className="text-xs text-[var(--ink-secondary)] tabular-nums">
          {diff.steps.length} step{diff.steps.length === 1 ? "" : "s"} aligned
        </div>
      </div>

      {/* Step Cards List */}
      <div className="flex flex-col gap-3">
        {diff.steps.map((step) => (
          <StepDiffCard key={`${step.stepName}-${step.occurrence}`} item={step} />
        ))}
      </div>
    </div>
  );
}
