import type { EffectDiffItem, RunEvent } from "../types.js";
import { formatDate } from "../utils/date.js";
import { Badge } from "./Badge.js";

interface EventTimelineProps {
  events: RunEvent[];
  selectedSeq: number | null;
  onSelectEvent: (event: RunEvent) => void;
  diffSteps?: EffectDiffItem[];
}

export function EventTimeline({
  events,
  selectedSeq,
  onSelectEvent,
  diffSteps = [],
}: EventTimelineProps) {
  return (
    <div className="flex flex-col gap-2 max-h-[500px] overflow-y-auto pr-1">
      {events.map((event) => {
        const isSelected = selectedSeq === event.seq;
        const p = (event.payload ?? {}) as Record<string, unknown>;
        const stepName = (p.name as string | undefined) || (p.stepName as string | undefined);

        // Find matching diff step if applicable
        const matchingDiff = stepName ? diffSteps.find((s) => s.stepName === stepName) : undefined;

        const isReused = matchingDiff?.reusedFromParent ?? Boolean(p.reusedFromParent);
        const isInputChanged =
          matchingDiff?.inputChangedFromParent ?? Boolean(p.inputChangedFromParent);
        const isMock = p.resultSource === "mock";

        const getBadgeVariant = (type: string) => {
          if (type === "RunCompleted") return "success";
          if (type === "RunFailed" || type === "StepFailed") return "danger";
          if (type === "EffectCaptured") return "purple";
          if (type === "StepCompleted") return "cyan";
          if (type === "RunResumed") return "warning";
          return "default";
        };

        return (
          <button
            type="button"
            key={event.seq}
            data-testid={`event-item-${event.seq}`}
            onClick={() => onSelectEvent(event)}
            className={`w-full p-3 rounded-lg border text-left cursor-pointer transition-colors flex items-center justify-between ${
              isSelected
                ? "bg-purple-950/40 border-purple-500 shadow"
                : "bg-slate-900/60 border-slate-800 hover:border-slate-700 hover:bg-slate-900"
            }`}
          >
            <div className="flex items-center gap-3">
              <span className="font-mono text-xs text-slate-400 w-8">#{event.seq}</span>
              <div className="flex flex-col">
                <div className="flex items-center gap-2">
                  <Badge variant={getBadgeVariant(event.type)}>{event.type}</Badge>
                  {stepName && (
                    <span className="font-mono text-xs text-slate-300 font-medium">{stepName}</span>
                  )}
                </div>
                <div className="flex items-center gap-2 mt-1">
                  {isReused && <Badge variant="cyan">reusedFromParent</Badge>}
                  {isInputChanged && <Badge variant="warning">inputChangedFromParent</Badge>}
                  {isMock && <Badge variant="purple">mock</Badge>}
                </div>
              </div>
            </div>
            <span className="text-xs text-slate-500 font-mono">
              {formatDate(event.createdAt, { timeOnly: true })}
            </span>
          </button>
        );
      })}
    </div>
  );
}
