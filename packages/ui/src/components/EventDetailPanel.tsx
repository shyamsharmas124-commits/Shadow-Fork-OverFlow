import type { EffectDiffItem, RunEvent } from "../types.js";
import { Badge } from "./Badge.js";

interface EventDetailPanelProps {
  event: RunEvent | null;
  stepDiff?: EffectDiffItem | null;
}

export function EventDetailPanel({ event, stepDiff }: EventDetailPanelProps) {
  if (!event) {
    return (
      <div className="h-full flex items-center justify-center p-8 text-center text-slate-500 text-sm border border-slate-800 rounded-lg bg-slate-900/40">
        Select an event from the timeline to inspect its payload and shadow execution diff.
      </div>
    );
  }

  const isReused = stepDiff?.reusedFromParent ?? false;
  const isInputChanged = stepDiff?.inputChangedFromParent ?? false;

  return (
    <div
      data-testid="event-detail-panel"
      className="p-5 border border-slate-800 rounded-lg bg-slate-900/60 flex flex-col gap-4"
    >
      <div className="flex items-center justify-between pb-3 border-b border-slate-800">
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs px-2 py-0.5 rounded bg-slate-800 text-slate-300">
            Seq {event.seq}
          </span>
          <span className="font-semibold text-slate-200">{event.type}</span>
        </div>
        <div className="flex items-center gap-2">
          {isReused && <Badge variant="cyan">reusedFromParent</Badge>}
          {isInputChanged && <Badge variant="warning">inputChangedFromParent</Badge>}
          <span className="text-xs text-slate-400">
            {new Date(event.createdAt).toLocaleTimeString()}
          </span>
        </div>
      </div>

      {stepDiff && (
        <div className="p-3 bg-slate-950/80 rounded border border-slate-800 text-xs flex flex-col gap-2">
          <div className="text-slate-400 font-semibold uppercase tracking-wider text-[10px]">
            Step Diff Info
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <span className="text-slate-500">Step: </span>
              <span className="font-mono text-slate-200">{stepDiff.stepName}</span> (occ{" "}
              {stepDiff.occurrence})
            </div>
            <div>
              <span className="text-slate-500">Diff Status: </span>
              <span className="font-semibold capitalize text-purple-400">{stepDiff.status}</span>
            </div>
          </div>
        </div>
      )}

      <div>
        <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
          Payload JSON
        </div>
        <pre className="p-4 bg-slate-950 border border-slate-800 rounded text-xs font-mono text-slate-200 overflow-x-auto max-h-96">
          <code data-testid="event-payload-json">{JSON.stringify(event.payload, null, 2)}</code>
        </pre>
      </div>
    </div>
  );
}
