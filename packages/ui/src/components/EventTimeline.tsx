import { animate, stagger } from "animejs";
import { Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
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
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [shadowOnly, setShadowOnly] = useState<boolean>(false);
  const [inputChangedOnly, setInputChangedOnly] = useState<boolean>(false);
  const [failuresOnly, setFailuresOnly] = useState<boolean>(false);

  // Available event types in current event list
  const availableTypes = useMemo(() => {
    const set = new Set(events.map((e) => e.type));
    return Array.from(set).sort();
  }, [events]);

  // Filtered events based on search and filters
  const filteredEvents = useMemo(() => {
    return events.filter((ev) => {
      const p = (ev.payload ?? {}) as Record<string, unknown>;
      const stepName = (
        (p.name as string | undefined) ||
        (p.stepName as string | undefined) ||
        ""
      ).toLowerCase();
      const typeLower = ev.type.toLowerCase();

      // Type filter
      if (typeFilter !== "all" && ev.type !== typeFilter) {
        return false;
      }

      const matchingDiff = stepName
        ? diffSteps.find((s) => s.stepName.toLowerCase() === stepName)
        : undefined;

      const isInputChanged =
        matchingDiff?.inputChangedFromParent ?? Boolean(p.inputChangedFromParent);

      // Shadow-only filter
      if (shadowOnly && ev.type !== "EffectCaptured" && p.runMode !== "shadow") {
        return false;
      }

      // InputChangedFromParent filter
      if (inputChangedOnly && !isInputChanged) {
        return false;
      }

      // Failures filter
      if (
        failuresOnly &&
        ev.type !== "RunFailed" &&
        ev.type !== "StepFailed" &&
        ev.type !== "ApprovalRejected"
      ) {
        return false;
      }

      // Text search
      if (searchQuery.trim()) {
        const q = searchQuery.trim().toLowerCase();
        const matchesType = typeLower.includes(q);
        const matchesStep = stepName.includes(q);
        const matchesSeq = String(ev.seq) === q;
        let matchesPayload = false;
        try {
          matchesPayload = JSON.stringify(p).toLowerCase().includes(q);
        } catch {
          // ignore
        }
        if (!matchesType && !matchesStep && !matchesSeq && !matchesPayload) {
          return false;
        }
      }

      return true;
    });
  }, [events, searchQuery, typeFilter, shadowOnly, inputChangedOnly, failuresOnly, diffSteps]);

  useEffect(() => {
    if (filteredEvents.length === 0 || isReducedMotion() || !containerRef.current) return;
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
  }, [filteredEvents.length]);

  const hasActiveFilters =
    searchQuery.trim() !== "" ||
    typeFilter !== "all" ||
    shadowOnly ||
    inputChangedOnly ||
    failuresOnly;

  const clearFilters = () => {
    setSearchQuery("");
    setTypeFilter("all");
    setShadowOnly(false);
    setInputChangedOnly(false);
    setFailuresOnly(false);
  };

  return (
    <div className="flex flex-col gap-2 font-mono text-xs">
      {/* Search and Filters Header */}
      <div
        data-testid="event-filters-bar"
        className="p-2 border border-[var(--border-hairline)] bg-[var(--bg-panel)] flex flex-col gap-2"
      >
        <div className="flex items-center gap-2">
          {/* Text Search */}
          <div className="relative flex-1">
            <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-[var(--ink-muted)]" />
            <input
              type="text"
              data-testid="event-search-input"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search step name, type, or payload..."
              className="w-full pl-7 pr-2 py-1 text-xs bg-[var(--bg-subtle)] border border-[var(--border-hairline)] text-[var(--ink-primary)] focus:outline-hidden"
            />
          </div>

          {/* Type Select */}
          <label htmlFor="event-type-filter" className="sr-only">
            Filter by Event Type
          </label>
          <select
            id="event-type-filter"
            data-testid="event-type-select"
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
            className="px-2 py-1 text-xs bg-[var(--bg-subtle)] border border-[var(--border-hairline)] text-[var(--ink-primary)] focus:outline-hidden"
          >
            <option value="all">All Types ({events.length})</option>
            {availableTypes.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>

        {/* Toggle Tags and Counter */}
        <div className="flex flex-wrap items-center justify-between gap-1.5 text-[11px]">
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              data-testid="filter-shadow-only"
              onClick={() => setShadowOnly(!shadowOnly)}
              className={`px-2 py-0.5 border cursor-pointer ${
                shadowOnly
                  ? "bg-[var(--status-shadow-bg)] text-[var(--status-shadow-fg)] border-[var(--status-shadow-fg)] font-bold"
                  : "bg-[var(--bg-subtle)] border-[var(--border-hairline)] text-[var(--ink-secondary)] hover:bg-[var(--bg-hover)]"
              }`}
            >
              Shadow-only
            </button>
            <button
              type="button"
              data-testid="filter-input-changed"
              onClick={() => setInputChangedOnly(!inputChangedOnly)}
              className={`px-2 py-0.5 border cursor-pointer ${
                inputChangedOnly
                  ? "bg-[var(--status-running-bg)] text-[var(--status-running-fg)] border-[var(--status-running-fg)] font-bold"
                  : "bg-[var(--bg-subtle)] border-[var(--border-hairline)] text-[var(--ink-secondary)] hover:bg-[var(--bg-hover)]"
              }`}
            >
              Input Changed
            </button>
            <button
              type="button"
              data-testid="filter-failures-only"
              onClick={() => setFailuresOnly(!failuresOnly)}
              className={`px-2 py-0.5 border cursor-pointer ${
                failuresOnly
                  ? "bg-[var(--status-failed-bg)] text-[var(--status-failed-fg)] border-[var(--status-failed-fg)] font-bold"
                  : "bg-[var(--bg-subtle)] border-[var(--border-hairline)] text-[var(--ink-secondary)] hover:bg-[var(--bg-hover)]"
              }`}
            >
              Failures Only
            </button>
          </div>

          <div className="flex items-center gap-2">
            <span
              data-testid="event-matches-count"
              className="text-[10px] text-[var(--ink-muted)] tabular-nums"
            >
              Showing {filteredEvents.length} of {events.length}
            </span>
            {hasActiveFilters && (
              <button
                type="button"
                data-testid="clear-event-filters-btn"
                onClick={clearFilters}
                className="flex items-center gap-0.5 text-[10px] text-[var(--ink-secondary)] hover:text-[var(--ink-primary)] underline cursor-pointer"
              >
                <X className="w-2.5 h-2.5" /> Clear
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Events List */}
      <div
        ref={containerRef}
        data-testid="events-timeline-list"
        className="flex flex-col gap-1.5 max-h-[500px] overflow-y-auto pr-1"
      >
        {filteredEvents.length === 0 ? (
          <div
            data-testid="no-matching-events"
            className="p-6 border border-[var(--border-hairline)] bg-[var(--bg-panel)] text-center flex flex-col items-center justify-center gap-1.5 text-[var(--ink-muted)]"
          >
            <span>No events match the active search or filters.</span>
            {hasActiveFilters && (
              <button
                type="button"
                onClick={clearFilters}
                className="px-2 py-1 text-xs border border-[var(--border-hairline)] bg-[var(--bg-subtle)] text-[var(--ink-primary)] hover:bg-[var(--bg-hover)] cursor-pointer"
              >
                Reset Event Filters
              </button>
            )}
          </div>
        ) : (
          filteredEvents.map((event) => {
            const isSelected = selectedSeq === event.seq;
            const p = (event.payload ?? {}) as Record<string, unknown>;
            const stepName = (p.name as string | undefined) || (p.stepName as string | undefined);

            const matchingDiff = stepName
              ? diffSteps.find((s) => s.stepName === stepName)
              : undefined;

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
                className={`w-full p-2 border text-left cursor-pointer transition-colors event-item-animated flex items-center justify-between ${
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
          })
        )}
      </div>
    </div>
  );
}
