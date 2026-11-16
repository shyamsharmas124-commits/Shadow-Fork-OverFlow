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
      <pre className="p-2 bg-slate-950 border border-slate-800 rounded text-[11px] font-mono text-slate-200 overflow-x-auto whitespace-pre-wrap break-all">
        <code>{text}</code>
      </pre>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <pre className="p-2 bg-slate-950 border border-slate-800 rounded text-[11px] font-mono text-slate-200 overflow-x-auto whitespace-pre-wrap break-all max-h-48 overflow-y-auto">
        <code>{expanded ? text : `${text.slice(0, maxChars)}...`}</code>
      </pre>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="text-[10px] text-purple-400 hover:text-purple-300 self-start flex items-center gap-1 cursor-pointer"
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
        return <Badge variant="cyan">Reused from Parent</Badge>;
      case "modified":
        return <Badge variant="purple">Modified / Edited</Badge>;
      case "added":
        return <Badge variant="success">Added in Fork</Badge>;
      case "only-in-parent":
        return <Badge variant="default">Only in Parent</Badge>;
      case "live":
        return <Badge variant="default">Live</Badge>;
    }
  };

  const hasProvenanceWarning = item.inputChangedFromParent && item.reusedFromParent;

  return (
    <div
      data-testid={`diff-step-${item.stepName}-${item.occurrence}`}
      className="flex flex-col rounded-xl border border-slate-800 bg-slate-900/60 overflow-hidden shadow-sm"
    >
      {/* Step Header */}
      <div className="flex items-center justify-between p-3.5 bg-slate-950/80 border-b border-slate-800">
        <div className="flex items-center gap-2.5">
          <span className="font-mono font-bold text-sm text-slate-100">{item.stepName}</span>
          <span className="font-mono text-xs text-slate-400">occ {item.occurrence}</span>
          {getStatusBadge(item.status)}
        </div>
        <div className="flex items-center gap-2">
          {item.reusedFromParent && <Badge variant="cyan">reusedFromParent</Badge>}
          {item.inputChangedFromParent && <Badge variant="warning">inputChangedFromParent</Badge>}
        </div>
      </div>

      {/* Provenance Warning Banner */}
      {hasProvenanceWarning && (
        <div
          data-testid="diff-provenance-warning"
          className="m-3 p-3 bg-amber-950/50 border border-amber-500/60 rounded text-amber-200 text-xs flex items-start gap-2.5"
        >
          <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
          <div className="flex flex-col gap-0.5">
            <span className="font-semibold">Provenance Warning:</span>
            <span>This result is from the original run and was produced from different input.</span>
          </div>
        </div>
      )}

      {/* Side-by-side comparison */}
      <div className="grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-slate-800/80 p-4 gap-4 text-xs">
        {/* Left Column: Parent Run */}
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between pb-1.5 border-b border-slate-800/60 font-semibold text-slate-300">
            <span>Parent Run (Live)</span>
            {item.parent?.seq !== undefined && (
              <span className="font-mono text-[11px] text-slate-500">Seq {item.parent.seq}</span>
            )}
          </div>
          {item.parent ? (
            <div className="flex flex-col gap-2.5">
              <div>
                <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-1 block">
                  Input
                </span>
                <JsonTruncated data={item.parent.input} />
              </div>
              <div>
                <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-1 block">
                  Result
                </span>
                <JsonTruncated data={item.parent.result} />
              </div>
              {item.parent.effects && item.parent.effects.length > 0 && (
                <div>
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-1 block">
                    Effects ({item.parent.effects.length})
                  </span>
                  <div className="flex flex-col gap-2">
                    {item.parent.effects.map((eff) => (
                      <div
                        key={`${eff.kind}-${JSON.stringify(eff.request)}`}
                        className="p-2.5 rounded bg-slate-950 border border-slate-800 flex flex-col gap-1.5"
                      >
                        <div className="flex items-center justify-between">
                          <span className="font-mono text-purple-300">{eff.kind}</span>
                          {eff.resultSource && (
                            <span className="text-[10px] text-slate-400 font-mono">
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
            <div className="p-6 text-center text-slate-500 italic">
              Step did not execute in parent run.
            </div>
          )}
        </div>

        {/* Right Column: Shadow Fork */}
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between pb-1.5 border-b border-slate-800/60 font-semibold text-purple-300">
            <span>Shadow Fork</span>
            {item.shadow?.seq !== undefined && (
              <span className="font-mono text-[11px] text-purple-400/70">
                Seq {item.shadow.seq}
              </span>
            )}
          </div>
          {item.shadow ? (
            <div className="flex flex-col gap-2.5">
              <div>
                <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-1 block">
                  Input
                </span>
                <JsonTruncated data={item.shadow.input} />
              </div>
              <div>
                <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-1 block">
                  Result
                </span>
                <JsonTruncated data={item.shadow.result} />
              </div>
              {item.shadow.effects && item.shadow.effects.length > 0 && (
                <div>
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-1 block">
                    Captured Effects ({item.shadow.effects.length})
                  </span>
                  <div className="flex flex-col gap-2">
                    {item.shadow.effects.map((eff) => {
                      const isMock = eff.resultSource === "mock";
                      return (
                        <div
                          key={`${eff.kind}-${eff.resultSource}-${JSON.stringify(eff.request)}`}
                          className="p-2.5 rounded bg-slate-950 border border-slate-800 flex flex-col gap-1.5"
                        >
                          <div className="flex items-center justify-between">
                            <span className="font-mono text-purple-300">{eff.kind}</span>
                            <div className="flex items-center gap-1.5">
                              {isMock && (
                                <span className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] bg-purple-950 border border-purple-500/40 text-purple-300 font-mono">
                                  <Sparkles className="w-2.5 h-2.5" /> mock
                                </span>
                              )}
                              {eff.resultSource && !isMock && (
                                <span className="text-[10px] text-slate-400 font-mono">
                                  source: {eff.resultSource}
                                </span>
                              )}
                            </div>
                          </div>
                          <JsonTruncated data={eff.request} maxChars={150} />
                          {eff.wouldHaveResult !== undefined && (
                            <div>
                              <span className="text-[10px] text-slate-400 block mb-0.5">
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
            <div className="p-6 text-center text-slate-500 italic">
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
      <div className="p-8 text-center text-slate-500 text-sm border border-slate-800 rounded-lg bg-slate-900/40">
        No step diff items available to compare.
      </div>
    );
  }

  return (
    <div data-testid="diff-view" className="flex flex-col gap-4">
      {/* Diff View Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 p-4 rounded-lg border border-slate-800 bg-slate-900/50">
        <div className="flex items-center gap-2">
          <GitFork className="w-4 h-4 text-purple-400" />
          <span className="text-sm font-semibold text-slate-200">Execution Diff</span>
          <span className="text-xs text-slate-400">
            Comparing Parent ({diff.parentRunId?.slice(0, 8)}...) vs Shadow Fork (
            {diff.runId.slice(0, 8)}...)
          </span>
        </div>
        <div className="text-xs text-slate-400 font-mono">
          {diff.steps.length} step{diff.steps.length === 1 ? "" : "s"} aligned
        </div>
      </div>

      {/* Step Cards List */}
      <div className="flex flex-col gap-4">
        {diff.steps.map((step) => (
          <StepDiffCard key={`${step.stepName}-${step.occurrence}`} item={step} />
        ))}
      </div>
    </div>
  );
}
