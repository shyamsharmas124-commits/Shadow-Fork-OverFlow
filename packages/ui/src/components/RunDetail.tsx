import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Clock, GitFork, RefreshCw } from "lucide-react";
import { useState } from "react";
import { getEffects, getRun } from "../api.js";
import type { RunEvent } from "../types.js";
import { formatDate } from "../utils/date.js";
import { ModeBadge, StatusBadge } from "./Badge.js";
import { EventDetailPanel } from "./EventDetailPanel.js";
import { EventTimeline } from "./EventTimeline.js";
import { LineageGraph } from "./LineageGraph.js";

interface RunDetailProps {
  runId: string;
  onBack: () => void;
  onSelectRun: (id: string) => void;
}

export function RunDetail({ runId, onBack, onSelectRun }: RunDetailProps) {
  const [selectedEvent, setSelectedEvent] = useState<RunEvent | null>(null);

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

  if (runLoading) {
    return (
      <div className="flex items-center justify-center p-12 text-slate-400">
        Loading run details...
      </div>
    );
  }

  if (runError || !run) {
    return (
      <div className="p-8 text-rose-400 bg-rose-950/20 border border-rose-900 rounded-lg">
        Failed to load run {runId}: {String(runError)}
      </div>
    );
  }

  // Set default selected event to the first or latest event if none selected
  const activeEvent = selectedEvent ?? run.events[run.events.length - 1] ?? null;

  const activeStepDiff =
    activeEvent && effects
      ? effects.steps.find((s) => {
          const stepName =
            (activeEvent.payload?.name as string) || (activeEvent.payload?.stepName as string);
          return s.stepName === stepName;
        })
      : null;

  return (
    <div className="flex flex-col gap-6" data-testid="run-detail-view">
      {/* Top action bar */}
      <div className="flex items-center justify-between border-b border-slate-800 pb-4">
        <button
          type="button"
          onClick={onBack}
          data-testid="back-button"
          className="flex items-center gap-2 text-sm text-slate-400 hover:text-slate-200 transition-colors cursor-pointer"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to runs list
        </button>
        <button
          type="button"
          onClick={() => refetch()}
          className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-200 px-3 py-1.5 rounded border border-slate-800 bg-slate-900 cursor-pointer"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          Refresh
        </button>
      </div>

      {/* Fork Provenance Banner */}
      {run.mode === "shadow" && run.parentRunId && (
        <div
          data-testid="fork-provenance-banner"
          className="flex flex-col gap-1 p-4 rounded-lg border border-purple-500/40 bg-purple-950/30 text-purple-200 text-xs shadow-md"
        >
          <div className="flex items-center gap-2 font-semibold">
            <GitFork className="w-4 h-4 text-purple-400 shrink-0" />
            <span>
              Shadow fork of{" "}
              <button
                type="button"
                onClick={() => onSelectRun(run.parentRunId!)}
                className="underline hover:text-purple-300 font-mono"
              >
                {run.parentRunId}
              </button>{" "}
              at seq {run.forkedFromSeq}: effectful steps were not executed against live services.
            </span>
          </div>
          <p className="text-slate-400 text-[11px] pl-6">
            State up to seq {run.forkedFromSeq} was seeded from parent history. Subsequent
            side-effects were intercepted and captured safely.
          </p>
        </div>
      )}

      {/* Header Info */}
      <div className="flex flex-col gap-3 p-5 rounded-lg border border-slate-800 bg-slate-900/50">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-mono font-bold text-slate-100">{run.id}</h1>
            <StatusBadge status={run.status} />
            <ModeBadge mode={run.mode} />
          </div>
          <div className="flex items-center gap-4 text-xs text-slate-400">
            <span className="flex items-center gap-1">
              <Clock className="w-3.5 h-3.5 text-slate-500" />
              Duration:{" "}
              {run.timing.durationMs !== null ? `${run.timing.durationMs}ms` : "In Progress"}
            </span>
            <span>Created: {formatDate(run.timing.createdAt)}</span>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 pt-3 border-t border-slate-800/60 text-xs">
          <div>
            <span className="text-slate-500">Workflow: </span>
            <span className="font-mono text-slate-200 font-semibold">{run.workflowType}</span>
          </div>
          <div>
            <span className="text-slate-500">Parent Run: </span>
            {run.parentRunId ? (
              <button
                type="button"
                onClick={() => onSelectRun(run.parentRunId!)}
                className="font-mono text-purple-400 hover:underline cursor-pointer"
              >
                {run.parentRunId} (seq {run.forkedFromSeq})
              </button>
            ) : (
              <span className="text-slate-400">None (Root)</span>
            )}
          </div>
          <div>
            <span className="text-slate-500">Events Recorded: </span>
            <span className="font-mono text-slate-200">{run.events.length}</span>
          </div>
        </div>
      </div>

      {/* Lineage Graph */}
      <LineageGraph run={run} onSelectRun={onSelectRun} />

      {/* Timeline & Detail Split */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold text-slate-300 uppercase tracking-wider">
            Event Timeline ({run.events.length})
          </h2>
          <EventTimeline
            events={run.events}
            selectedSeq={activeEvent?.seq ?? null}
            onSelectEvent={setSelectedEvent}
            diffSteps={effects?.steps}
          />
        </div>

        <div className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold text-slate-300 uppercase tracking-wider">
            Event Inspection & Diff
          </h2>
          <EventDetailPanel event={activeEvent} stepDiff={activeStepDiff} />
        </div>
      </div>

      {/* Active Tasks Panel */}
      {run.tasks.length > 0 && (
        <div className="flex flex-col gap-3 p-5 rounded-lg border border-slate-800 bg-slate-900/40">
          <h2 className="text-sm font-semibold text-slate-300 uppercase tracking-wider">
            Task State & Leases ({run.tasks.length})
          </h2>
          <div className="overflow-x-auto">
            <table className="w-full text-xs text-left text-slate-300">
              <thead className="bg-slate-950 text-slate-400 uppercase border-b border-slate-800">
                <tr>
                  <th className="p-2.5">Step Key</th>
                  <th className="p-2.5">Status</th>
                  <th className="p-2.5">Attempt</th>
                  <th className="p-2.5">Lease Owner</th>
                  <th className="p-2.5">Run At</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60 font-mono">
                {run.tasks.map((task) => (
                  <tr key={task.id} className="hover:bg-slate-800/30">
                    <td className="p-2.5 font-medium">{task.stepKey}</td>
                    <td className="p-2.5">
                      <span className="capitalize">{task.status}</span>
                    </td>
                    <td className="p-2.5">{task.attempt}</td>
                    <td className="p-2.5 text-slate-400">{task.leaseOwner ?? "None"}</td>
                    <td className="p-2.5 text-slate-400">
                      {formatDate(task.runAt, { timeOnly: true })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
