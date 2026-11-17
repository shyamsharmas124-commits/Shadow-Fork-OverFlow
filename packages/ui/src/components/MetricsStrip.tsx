import { Activity, CheckCircle, Clock, RefreshCw, Zap } from "lucide-react";
import { useMemo } from "react";
import type { RunSummary } from "../types.js";

interface MetricsStripProps {
  runs: RunSummary[];
}

function MiniSparkline({ data, color }: { data: number[]; color: string }) {
  if (data.length < 2) {
    return <div className="h-4 w-16 bg-[var(--bg-subtle)] opacity-40" />;
  }

  const min = Math.min(...data);
  const max = Math.max(...data, min + 1);
  const width = 64;
  const height = 16;

  const points = data
    .map((val, idx) => {
      const x = (idx / (data.length - 1)) * width;
      const y = height - ((val - min) / (max - min)) * (height - 2) - 1;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  return (
    <svg width={width} height={height} className="overflow-visible" aria-hidden="true">
      <polyline
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        points={points}
      />
    </svg>
  );
}

export function MetricsStrip({ runs }: MetricsStripProps) {
  const metrics = useMemo(() => {
    if (runs.length === 0) {
      return {
        runsPerMin: 0,
        retryRate: 0,
        p50: 0,
        successRate: 100,
        activeLeases: 0,
        sparklines: {
          rpm: [0, 0, 0, 0, 0],
          durations: [0, 0, 0, 0, 0],
          retries: [0, 0, 0, 0, 0],
        },
      };
    }

    const durations = runs
      .map((r) => r.timing.durationMs)
      .filter((d): d is number => d !== null && d >= 0)
      .sort((a, b) => a - b);

    const p50 = durations.length > 0 ? (durations[Math.floor(durations.length * 0.5)] ?? 0) : 0;

    const completed = runs.filter((r) => r.status === "completed").length;
    const terminal = runs.filter((r) => r.status === "completed" || r.status === "failed").length;
    const successRate = terminal > 0 ? Math.round((completed / terminal) * 100) : 100;
    const activeLeases = runs.filter((r) => r.status === "running").length;

    // Runs per minute calculation: count runs created in the last 15 minutes
    const now = Date.now();
    const recentRuns = runs.filter((r) => {
      const t = new Date(r.timing.createdAt).getTime();
      return now - t <= 15 * 60 * 1000;
    });
    const runsPerMin = Number((recentRuns.length / 15).toFixed(1));

    // Approximate retry rate (shadow forks or resumed runs)
    const forksCount = runs.filter((r) => r.parentRunId !== null).length;
    const retryRate = Math.round((forksCount / runs.length) * 100);

    // Sparkline series: chunk runs into 5 buckets for trend
    const bucketSize = Math.max(1, Math.floor(runs.length / 5));
    const rpmSeries: number[] = [];
    const durationSeries: number[] = [];
    const retrySeries: number[] = [];

    for (let i = 0; i < 5; i++) {
      const slice = runs.slice(i * bucketSize, (i + 1) * bucketSize);
      rpmSeries.push(slice.length);
      const durs = slice.map((r) => r.timing.durationMs ?? 0);
      const avgDur =
        durs.length > 0 ? Math.round(durs.reduce((a, b) => a + b, 0) / durs.length) : 0;
      durationSeries.push(avgDur);
      const retries = slice.filter((r) => r.parentRunId !== null).length;
      retrySeries.push(retries);
    }

    return {
      runsPerMin,
      retryRate,
      p50,
      successRate,
      activeLeases,
      sparklines: {
        rpm: rpmSeries,
        durations: durationSeries,
        retries: retrySeries,
      },
    };
  }, [runs]);

  return (
    <div
      data-testid="metrics-strip"
      className="grid grid-cols-2 sm:grid-cols-5 gap-2.5 p-3 border border-[var(--border-hairline)] bg-[var(--bg-panel)] font-mono text-xs"
    >
      {/* Runs Per Minute */}
      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between">
          <span className="text-[10px] uppercase text-[var(--ink-secondary)] font-bold flex items-center gap-1">
            <Zap className="w-3 h-3 text-[var(--accent)]" />
            Runs / min
          </span>
          <MiniSparkline data={metrics.sparklines.rpm} color="var(--accent)" />
        </div>
        <span data-testid="metric-rpm" className="text-sm font-bold tabular-nums">
          {metrics.runsPerMin}{" "}
          <span className="text-[10px] font-normal text-[var(--ink-muted)]">rpm</span>
        </span>
      </div>

      {/* Median Step Duration (p50) */}
      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between">
          <span className="text-[10px] uppercase text-[var(--ink-secondary)] font-bold flex items-center gap-1">
            <Clock className="w-3 h-3 text-[var(--ink-muted)]" />
            Median Duration
          </span>
          <MiniSparkline data={metrics.sparklines.durations} color="var(--ink-primary)" />
        </div>
        <span data-testid="metric-p50" className="text-sm font-bold tabular-nums">
          {metrics.p50}ms
        </span>
      </div>

      {/* Retry Rate */}
      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between">
          <span className="text-[10px] uppercase text-[var(--ink-secondary)] font-bold flex items-center gap-1">
            <RefreshCw className="w-3 h-3 text-[var(--status-running-fg)]" />
            Retry / Fork Rate
          </span>
          <MiniSparkline data={metrics.sparklines.retries} color="var(--status-running-fg)" />
        </div>
        <span data-testid="metric-retry-rate" className="text-sm font-bold tabular-nums">
          {metrics.retryRate}%
        </span>
      </div>

      {/* Success Rate */}
      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between">
          <span className="text-[10px] uppercase text-[var(--ink-secondary)] font-bold flex items-center gap-1">
            <CheckCircle className="w-3 h-3 text-[#1E5A36] dark:text-[#4EAD75]" />
            Success Rate
          </span>
        </div>
        <span data-testid="metric-success-rate" className="text-sm font-bold tabular-nums">
          {metrics.successRate}%
        </span>
      </div>

      {/* Active Leases */}
      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between">
          <span className="text-[10px] uppercase text-[var(--ink-secondary)] font-bold flex items-center gap-1">
            <Activity className="w-3 h-3 text-[var(--status-running-fg)]" />
            Active Leases
          </span>
        </div>
        <span data-testid="metric-active-leases" className="text-sm font-bold tabular-nums">
          {metrics.activeLeases}
        </span>
      </div>
    </div>
  );
}
