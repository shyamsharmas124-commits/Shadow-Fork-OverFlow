import { RefreshCw } from "lucide-react";

export type PollingSpeed = 1000 | 5000 | "paused";

interface LivePollingControlProps {
  speed: PollingSpeed;
  onChangeSpeed: (speed: PollingSpeed) => void;
  isPolling: boolean;
  backoffMs: number;
  lastSyncAt: Date | null;
  onManualRefresh: () => void;
}

export function LivePollingControl({
  speed,
  onChangeSpeed,
  isPolling,
  backoffMs,
  lastSyncAt,
  onManualRefresh,
}: LivePollingControlProps) {
  const isPaused = speed === "paused";
  const isBackingOff = backoffMs > 0;

  return (
    <div data-testid="live-polling-control" className="flex items-center gap-2 font-mono text-xs">
      {/* Live status dot */}
      <div
        className="flex items-center gap-1.5 px-2 py-1 bg-[var(--bg-subtle)] border border-[var(--border-hairline)]"
        title={lastSyncAt ? `Last synced: ${lastSyncAt.toLocaleTimeString()}` : "Not synced"}
      >
        <span
          data-testid="live-pulse-dot"
          className={`w-2 h-2 ${
            isPaused
              ? "bg-[var(--ink-muted)]"
              : isBackingOff
                ? "bg-[#92400E] dark:bg-[#FBBF24] animate-pulse"
                : "bg-[#1E5A36] dark:bg-[#4EAD75] animate-pulse"
          }`}
        />
        <span
          data-testid="live-polling-status"
          className="text-[10px] font-bold uppercase tracking-wider text-[var(--ink-secondary)]"
        >
          {isPaused ? "PAUSED" : isBackingOff ? `BACKOFF ${backoffMs}ms` : "STREAMING"}
        </span>
      </div>

      {/* Speed Selector */}
      <div className="flex items-center border border-[var(--border-hairline)] bg-[var(--bg-panel)] overflow-hidden">
        <button
          type="button"
          data-testid="polling-speed-1s"
          onClick={() => onChangeSpeed(1000)}
          className={`px-2 py-1 text-[10px] uppercase font-bold cursor-pointer transition-colors ${
            speed === 1000
              ? "bg-[var(--ink-primary)] text-[var(--paper)]"
              : "text-[var(--ink-secondary)] hover:bg-[var(--bg-hover)]"
          }`}
        >
          1s
        </button>
        <button
          type="button"
          data-testid="polling-speed-5s"
          onClick={() => onChangeSpeed(5000)}
          className={`px-2 py-1 text-[10px] uppercase font-bold border-l border-[var(--border-hairline)] cursor-pointer transition-colors ${
            speed === 5000
              ? "bg-[var(--ink-primary)] text-[var(--paper)]"
              : "text-[var(--ink-secondary)] hover:bg-[var(--bg-hover)]"
          }`}
        >
          5s
        </button>
        <button
          type="button"
          data-testid="polling-speed-pause"
          onClick={() => onChangeSpeed("paused")}
          className={`px-2 py-1 text-[10px] uppercase font-bold border-l border-[var(--border-hairline)] cursor-pointer transition-colors ${
            isPaused
              ? "bg-[var(--ink-primary)] text-[var(--paper)]"
              : "text-[var(--ink-secondary)] hover:bg-[var(--bg-hover)]"
          }`}
        >
          Pause
        </button>
      </div>

      {/* Manual refresh button */}
      <button
        type="button"
        data-testid="manual-sync-btn"
        onClick={onManualRefresh}
        title="Sync immediately"
        className="p-1 border border-[var(--border-hairline)] bg-[var(--bg-subtle)] hover:bg-[var(--bg-hover)] text-[var(--ink-primary)] cursor-pointer"
      >
        <RefreshCw className={`w-3.5 h-3.5 ${isPolling ? "animate-spin" : ""}`} />
      </button>
    </div>
  );
}
