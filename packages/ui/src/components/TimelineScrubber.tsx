import { Pause, Play, SkipForward } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { RunEvent } from "../types.js";

interface TimelineScrubberProps {
  events: RunEvent[];
  selectedSeq: number | null;
  onSelectEvent: (event: RunEvent) => void;
}

export function TimelineScrubber({ events, selectedSeq, onSelectEvent }: TimelineScrubberProps) {
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [playbackSpeed, setPlaybackSpeed] = useState<number>(1);

  const sortedEvents = useMemo(() => {
    return [...events].sort((a, b) => a.seq - b.seq);
  }, [events]);

  const activeIndex = useMemo(() => {
    if (!selectedSeq) return sortedEvents.length - 1;
    const idx = sortedEvents.findIndex((e) => e.seq === selectedSeq);
    return idx >= 0 ? idx : sortedEvents.length - 1;
  }, [selectedSeq, sortedEvents]);

  // Playback timer
  useEffect(() => {
    if (!isPlaying) return;

    const intervalMs = Math.max(100, Math.floor(1000 / playbackSpeed));
    const timer = setInterval(() => {
      if (activeIndex < sortedEvents.length - 1) {
        const next = sortedEvents[activeIndex + 1];
        if (next) onSelectEvent(next);
      } else {
        setIsPlaying(false);
      }
    }, intervalMs);

    return () => clearInterval(timer);
  }, [isPlaying, activeIndex, sortedEvents, playbackSpeed, onSelectEvent]);

  // Reconstructed run state up to active index
  const reconstructedState = useMemo(() => {
    const current = sortedEvents[activeIndex];
    if (!current) {
      return { stepCount: 0, lastEvent: "None", status: "Idle", effectsCount: 0 };
    }

    const eventsUpToNow = sortedEvents.slice(0, activeIndex + 1);
    const completedSteps = eventsUpToNow.filter((e) => e.type === "StepCompleted").length;
    const effects = eventsUpToNow.filter((e) => e.type === "EffectCaptured").length;
    const hasFailed = eventsUpToNow.some((e) => e.type === "RunFailed" || e.type === "StepFailed");
    const isCompleted = eventsUpToNow.some((e) => e.type === "RunCompleted");

    const status = hasFailed ? "Failed" : isCompleted ? "Completed" : "Running";
    const payload = (current.payload ?? {}) as { name?: string; stepName?: string };
    const stepName = payload.name || payload.stepName || current.type;

    return {
      seq: current.seq,
      activeStep: stepName,
      stepCount: completedSteps,
      effectsCount: effects,
      status,
      timestamp: current.createdAt,
    };
  }, [sortedEvents, activeIndex]);

  const handleStepForward = () => {
    if (activeIndex < sortedEvents.length - 1) {
      const next = sortedEvents[activeIndex + 1];
      if (next) onSelectEvent(next);
    }
  };

  const getTickColor = (type: string) => {
    if (type === "RunCompleted" || type === "StepCompleted" || type === "ApprovalGranted")
      return "#1E5A36"; // Cedar Green
    if (type === "RunFailed" || type === "StepFailed" || type === "ApprovalRejected")
      return "#B91C1C"; // Chili
    if (type === "ApprovalRequested" || type === "RunResumed") return "#92400E"; // Honey
    return "#475569"; // Steel Grey
  };

  return (
    <div
      data-testid="timeline-scrubber"
      className="p-3 border border-[var(--border-hairline)] bg-[var(--bg-panel)] flex flex-col gap-2.5 font-mono text-xs"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--ink-secondary)]">
            Timeline Scrubber
          </span>
          <span className="text-[10px] text-[var(--ink-muted)]">
            Seq {reconstructedState.seq} of {sortedEvents.length}
          </span>
        </div>

        {/* Controls: Play/Pause, Step, Speed */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            data-testid="scrubber-play-btn"
            onClick={() => setIsPlaying(!isPlaying)}
            aria-label={isPlaying ? "Pause playback" : "Play timeline"}
            className="flex items-center gap-1 px-2.5 py-1 border border-[var(--border-hairline)] bg-[var(--bg-subtle)] hover:bg-[var(--bg-hover)] text-[var(--ink-primary)] cursor-pointer text-xs"
          >
            {isPlaying ? (
              <>
                <Pause className="w-3 h-3" /> Pause
              </>
            ) : (
              <>
                <Play className="w-3 h-3" /> Play
              </>
            )}
          </button>

          <button
            type="button"
            data-testid="scrubber-step-btn"
            onClick={handleStepForward}
            disabled={activeIndex >= sortedEvents.length - 1}
            aria-label="Step forward one event"
            className="flex items-center gap-1 px-2 py-1 border border-[var(--border-hairline)] bg-[var(--bg-subtle)] hover:bg-[var(--bg-hover)] text-[var(--ink-primary)] disabled:opacity-40 cursor-pointer disabled:cursor-not-allowed text-xs"
          >
            <SkipForward className="w-3 h-3" /> Step
          </button>

          <label htmlFor="scrubber-speed" className="sr-only">
            Playback Speed
          </label>
          <select
            id="scrubber-speed"
            data-testid="scrubber-speed-select"
            value={playbackSpeed}
            onChange={(e) => setPlaybackSpeed(Number(e.target.value))}
            className="px-2 py-1 text-xs bg-[var(--bg-subtle)] border border-[var(--border-hairline)] text-[var(--ink-primary)] focus:outline-hidden"
          >
            <option value="1">1x</option>
            <option value="2">2x</option>
            <option value="5">5x</option>
          </select>
        </div>
      </div>

      {/* Scrubber Track with Event Ticks */}
      <div className="relative w-full h-8 flex items-center">
        <label htmlFor="scrubber-slider" className="sr-only">
          Timeline Scrubber Slider
        </label>
        <input
          id="scrubber-slider"
          type="range"
          data-testid="scrubber-slider"
          min={0}
          max={Math.max(sortedEvents.length - 1, 0)}
          value={activeIndex}
          onChange={(e) => {
            const ev = sortedEvents[Number(e.target.value)];
            if (ev) onSelectEvent(ev);
          }}
          className="w-full z-10 cursor-pointer opacity-0 absolute inset-0"
        />

        {/* Visual Track */}
        <div className="w-full h-2 bg-[var(--bg-subtle)] border border-[var(--border-hairline)] relative">
          {/* Progress fill */}
          <div
            className="h-full bg-[var(--ink-primary)]"
            style={{
              width: `${(activeIndex / Math.max(sortedEvents.length - 1, 1)) * 100}%`,
            }}
          />

          {/* Event Ticks */}
          {sortedEvents.map((ev, i) => (
            <div
              key={ev.seq}
              title={`Seq #${ev.seq} (${ev.type})`}
              className="absolute top-1/2 -translate-y-1/2 w-1.5 h-3 cursor-pointer z-0"
              style={{
                left: `calc(${(i / Math.max(sortedEvents.length - 1, 1)) * 100}% - 3px)`,
                backgroundColor: getTickColor(ev.type),
              }}
            />
          ))}
        </div>
      </div>

      {/* Reconstructed State Indicator */}
      <div
        data-testid="scrubber-reconstructed-state"
        className="p-2 bg-[var(--bg-subtle)] border border-[var(--border-hairline)] flex flex-wrap items-center justify-between gap-2 text-[11px]"
      >
        <div className="flex items-center gap-2">
          <span className="font-bold text-[var(--ink-primary)]">
            [Seq #{reconstructedState.seq}]
          </span>
          <span>Step: {reconstructedState.activeStep}</span>
          <span className="text-[var(--ink-muted)]">|</span>
          <span>Status: {reconstructedState.status}</span>
        </div>
        <div className="flex items-center gap-3 text-[var(--ink-secondary)] tabular-nums">
          <span>Completed Steps: {reconstructedState.stepCount}</span>
          <span>Captured Effects: {reconstructedState.effectsCount}</span>
        </div>
      </div>
    </div>
  );
}
