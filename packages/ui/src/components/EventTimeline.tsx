import { animate, stagger } from "animejs";
import { useEffect, useRef } from "react";
import type { EffectDiffItem, RunEvent } from "../types.js";
import { formatDate } from "../utils/date.js";
import { isReducedMotion } from "../utils/motion.js";
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
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (events.length === 0 || isReducedMotion() || !containerRef.current) return;
    const items = containerRef.current.querySelectorAll('[data-testid^="event-item-"]');
    if (items.length > 0) {
      // Subtle stagger animation using anime.js v4
      animate(items, {
        opacity: [0, 1],
        translateY: [4, 0],
        delay: stagger(15, { start: 0 }),
        duration: 180,
        ease: "outQuad",
      });
    }
  }, [events.length]);

  return (
    <div
      ref={containerRef}
      className="flex flex-col gap-1.5 max-h-[500px] overflow-y-auto pr-1 font-mono text-xs"
    >
      {events.map((event) => {
        const isSelected = selectedSeq === event.seq;
        const p = (event.payload ?? {}) as Record<string, unknown>;
        const stepName = (p.name as string | undefined) || (p.stepName as string | undefined);

        const matchingDiff = stepName ? diffSteps.find((s) => s.stepName === stepName) : undefined;

        const isReused = matchingDiff?.reusedFromParent ?? Boolean(p.reusedFromParent);
        const isInputChanged =
          matchingDiff?.inputChangedFromParent ?? Boolean(p.inputChangedFromParent);
        const isMock = p.resultSource === "mock";

        const getBadgeVariant = (type: string) => {
          if (type === "RunCompleted" || type === "ApprovalGranted") return "success";
          if (type === "RunFailed" || type === "StepFailed" || type === "ApprovalRejected")
            return "danger";
          if (type === "EffectCaptured") return "shadow";
          if (type === "StepCompleted") return "cyan";
          if (type === "RunResumed" || type === "ApprovalRequested") return "warning";
          return "default";
        };

        return (
          <button
            type="button"
            key={event.seq}
            data-testid={`event-item-${event.seq}`}
            onClick={() => onSelectEvent(event)}
            className={`w-full p-2 border text-left cursor-pointer transition-colors flex items-center justify-between ${
              isSelected
                ? "bg-[var(--bg-subtle)] border-[var(--ink-primary)] font-bold"
                : "bg-[var(--bg-panel)] border-[var(--border-hairline)] hover:bg-[var(--bg-hover)]"
            }`}
          >
            <div className="flex items-center gap-2">
              <span className="text-xs text-[var(--ink-secondary)] w-7 tabular-nums">
                #{event.seq}
              </span>
              <div className="flex flex-col">
                <div className="flex items-center gap-1.5">
                  <Badge variant={getBadgeVariant(event.type)}>{event.type}</Badge>
                  {stepName && (
                    <span className="text-xs text-[var(--ink-primary)] font-medium">
                      {stepName}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1.5 mt-0.5">
                  {isReused && <Badge variant="cyan">reusedFromParent</Badge>}
                  {isInputChanged && <Badge variant="warning">inputChangedFromParent</Badge>}
                  {isMock && <Badge variant="shadow">mock</Badge>}
                </div>
              </div>
            </div>
            <span className="text-[11px] text-[var(--ink-secondary)] tabular-nums">
              {formatDate(event.createdAt, { timeOnly: true })}
            </span>
          </button>
        );
      })}
    </div>
  );
}
