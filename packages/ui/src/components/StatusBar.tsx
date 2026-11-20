import type { HealthResponse } from "../api.js";

export interface StatusBarProps {
  healthData?: HealthResponse | null;
  inMemoryToken?: string | null;
}

export function StatusBar({ healthData, inMemoryToken }: StatusBarProps) {
  const isOnline = healthData?.status === "ok";
  const leaseHolders = healthData ? healthData.leaseHolders60s : "-";

  return (
    <footer
      data-testid="status-bar"
      className="border-t border-[var(--border-hairline)] bg-[var(--bg-panel)] py-2 px-4 text-xs font-mono select-none"
    >
      <div className="max-w-7xl mx-auto flex flex-wrap items-center justify-between gap-3 text-[11px] text-[var(--ink-secondary)]">
        {/* Real Telemetry Items */}
        <div className="flex items-center gap-4">
          {/* Live Indicator */}
          <div data-testid="status-live-indicator" className="flex items-center gap-1.5">
            <span
              className={`w-2 h-2 ${
                isOnline ? "bg-[#1E5A36] dark:bg-[#4EAD75]" : "bg-[#B91C1C] dark:bg-[#F87171]"
              }`}
            />
            <span className="font-bold text-[var(--ink-primary)]">
              API: {isOnline ? "ONLINE" : "OFFLINE"}
            </span>
          </div>

          {/* Worker Count / Active Lease Holders */}
          <div data-testid="status-worker-count" className="flex items-center gap-1">
            <span className="text-[var(--ink-muted)]">LEASE HOLDERS (60S):</span>
            <span className="font-bold text-[var(--ink-primary)] tabular-nums">{leaseHolders}</span>
          </div>

          {/* DB Latency */}
          <div data-testid="status-db-latency" className="flex items-center gap-1">
            <span className="text-[var(--ink-muted)]">DB LATENCY:</span>
            <span className="font-bold text-[var(--ink-primary)] tabular-nums">
              {healthData ? `${healthData.dbLatencyMs}ms` : "-"}
            </span>
          </div>

          {/* Schema Version */}
          <div data-testid="status-schema-version" className="hidden sm:flex items-center gap-1">
            <span className="text-[var(--ink-muted)]">SCHEMA:</span>
            <span className="font-bold text-[var(--ink-primary)]">
              {healthData ? healthData.schemaVersion : "-"}
            </span>
          </div>

          {/* Token Status */}
          <div data-testid="status-token-indicator" className="hidden md:flex items-center gap-1">
            <span className="text-[var(--ink-muted)]">AUTH:</span>
            <span className="font-bold text-[var(--ink-primary)]">
              {inMemoryToken ? "TOKEN_SET" : "ANONYMOUS"}
            </span>
          </div>

          {/* Shadow Mode Indicator */}
          <div
            data-testid="status-shadow-indicator"
            className="hidden lg:flex items-center gap-1 px-1.5 py-0.2 bg-[var(--status-shadow-bg)] border border-[var(--status-shadow-border)] text-[var(--status-shadow-fg)] text-[10px]"
          >
            <span>Forks: shadow only</span>
          </div>
        </div>

        {/* Keyboard Shortcuts */}
        <div className="hidden xl:flex items-center gap-3 text-[10px] text-[var(--ink-muted)]">
          <span>
            <kbd className="px-1 border border-[var(--border-hairline)] bg-[var(--bg-subtle)]">
              Ctrl+K
            </kbd>{" "}
            palette
          </span>
          <span>
            <kbd className="px-1 border border-[var(--border-hairline)] bg-[var(--bg-subtle)]">
              ?
            </kbd>{" "}
            help
          </span>
          <span>
            <kbd className="px-1 border border-[var(--border-hairline)] bg-[var(--bg-subtle)]">
              m
            </kbd>{" "}
            theme
          </span>
        </div>
      </div>
    </footer>
  );
}
