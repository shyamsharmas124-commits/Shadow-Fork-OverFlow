import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, GitFork, RefreshCw } from "lucide-react";
import { useState } from "react";
import { getRuns } from "../api.js";
import { formatDate } from "../utils/date.js";
import { ModeBadge, StatusBadge } from "./Badge.js";

interface RunListProps {
  onSelectRun: (id: string) => void;
}

export function RunList({ onSelectRun }: RunListProps) {
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [modeFilter, setModeFilter] = useState<string>("");
  const [page, setPage] = useState<number>(1);
  const pageSize = 10;

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["runs", statusFilter, modeFilter],
    queryFn: () =>
      getRuns({
        status: statusFilter || undefined,
        mode: modeFilter || undefined,
        limit: 50,
      }),
    refetchInterval: 5000,
  });

  const runs = data?.runs ?? [];
  const total = data?.total ?? runs.length;
  const totalPages = Math.ceil(total / pageSize) || 1;
  const paginatedRuns = runs.slice((page - 1) * pageSize, page * pageSize);

  return (
    <div className="flex flex-col gap-4" data-testid="run-list-view">
      {/* Title & Filter Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 p-3 border border-[var(--border-hairline)] bg-[var(--bg-panel)]">
        <div className="flex items-center gap-3">
          <h1 className="font-mono text-xs font-bold uppercase tracking-wider text-[var(--ink-primary)]">
            Run Registry
          </h1>
          <span className="text-[11px] text-[var(--ink-muted)] font-mono">|</span>

          <label
            htmlFor="status-select"
            className="text-[11px] font-mono text-[var(--ink-secondary)]"
          >
            Status:
          </label>
          <select
            id="status-select"
            value={statusFilter}
            onChange={(e) => {
              setStatusFilter(e.target.value);
              setPage(1);
            }}
            className="text-xs font-mono bg-[var(--bg-subtle)] border border-[var(--border-hairline)] px-2 py-1 text-[var(--ink-primary)] focus:outline-hidden"
          >
            <option value="">All Statuses</option>
            <option value="running">Running</option>
            <option value="completed">Completed</option>
            <option value="failed">Failed</option>
          </select>

          <label
            htmlFor="mode-select"
            className="text-[11px] font-mono text-[var(--ink-secondary)]"
          >
            Mode:
          </label>
          <select
            id="mode-select"
            value={modeFilter}
            onChange={(e) => {
              setModeFilter(e.target.value);
              setPage(1);
            }}
            className="text-xs font-mono bg-[var(--bg-subtle)] border border-[var(--border-hairline)] px-2 py-1 text-[var(--ink-primary)] focus:outline-hidden"
          >
            <option value="">All Modes</option>
            <option value="live">Live Only</option>
            <option value="shadow">Shadow Only</option>
          </select>
        </div>

        <button
          type="button"
          onClick={() => refetch()}
          className="flex items-center gap-1.5 text-xs font-mono text-[var(--ink-secondary)] hover:text-[var(--ink-primary)] px-2.5 py-1 border border-[var(--border-hairline)] bg-[var(--bg-subtle)] hover:bg-[var(--bg-hover)] cursor-pointer"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          Refresh
        </button>
      </div>

      {/* Dense Registry Table */}
      <div className="border border-[var(--border-hairline)] bg-[var(--bg-panel)] overflow-hidden">
        {isLoading ? (
          <div className="p-8 text-center text-xs font-mono text-[var(--ink-muted)]">
            Loading workflow runs...
          </div>
        ) : error ? (
          <div className="p-6 text-center text-xs font-mono text-[var(--status-failed-fg)]">
            Failed to load runs: {String(error)}
          </div>
        ) : runs.length === 0 ? (
          <div className="p-8 text-center text-xs font-mono text-[var(--ink-muted)]">
            No workflow runs found in registry.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs text-left border-collapse">
              <thead className="bg-[var(--bg-subtle)] text-[var(--ink-secondary)] uppercase tracking-wider font-mono text-[11px] border-b border-[var(--border-hairline)]">
                <tr>
                  <th className="p-2.5 font-bold">Run ID</th>
                  <th className="p-2.5 font-bold">Workflow</th>
                  <th className="p-2.5 font-bold">Status</th>
                  <th className="p-2.5 font-bold">Mode</th>
                  <th className="p-2.5 font-bold">Parent Run</th>
                  <th className="p-2.5 font-bold text-right">Duration</th>
                  <th className="p-2.5 font-bold">Created At</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border-hairline)] font-mono">
                {paginatedRuns.map((r) => (
                  <tr
                    key={r.id}
                    data-testid={`run-row-${r.id}`}
                    onClick={() => onSelectRun(r.id)}
                    className="hover:bg-[var(--bg-hover)] cursor-pointer transition-colors"
                  >
                    <td className="p-2.5 font-bold text-[var(--ink-primary)] flex items-center gap-1.5">
                      {r.mode === "shadow" && (
                        <GitFork className="w-3.5 h-3.5 text-[var(--ink-secondary)]" />
                      )}
                      <span className="hover:underline">{r.id}</span>
                    </td>
                    <td className="p-2.5 text-[var(--ink-primary)] font-medium">
                      {r.workflowType}
                    </td>
                    <td className="p-2.5">
                      <StatusBadge status={r.status} />
                    </td>
                    <td className="p-2.5">
                      <ModeBadge mode={r.mode} />
                    </td>
                    <td className="p-2.5">
                      {r.parentRunId ? (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onSelectRun(r.parentRunId!);
                          }}
                          className="hover:underline text-[var(--ink-secondary)] hover:text-[var(--ink-primary)] flex items-center gap-1 cursor-pointer font-mono"
                        >
                          <GitFork className="w-3 h-3" />
                          <span>{r.parentRunId.slice(0, 8)}...</span>
                        </button>
                      ) : (
                        <span className="text-[var(--ink-muted)]">-</span>
                      )}
                    </td>
                    <td className="p-2.5 text-right text-[var(--ink-secondary)] tabular-nums">
                      {r.timing.durationMs !== null ? `${r.timing.durationMs}ms` : "Active"}
                    </td>
                    <td className="p-2.5 text-[var(--ink-secondary)] tabular-nums">
                      {formatDate(r.timing.createdAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination Bar */}
        {total > pageSize && (
          <div className="flex items-center justify-between p-2.5 border-t border-[var(--border-hairline)] bg-[var(--bg-subtle)] text-xs font-mono text-[var(--ink-secondary)]">
            <div>
              Showing {(page - 1) * pageSize + 1} to {Math.min(page * pageSize, total)} of {total}{" "}
              runs
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setPage((p) => Math.max(p - 1, 1))}
                disabled={page === 1}
                aria-label="Previous page"
                className="p-1 border border-[var(--border-hairline)] bg-[var(--bg-panel)] disabled:opacity-30 cursor-pointer disabled:cursor-not-allowed text-[var(--ink-primary)]"
              >
                <ChevronLeft className="w-3.5 h-3.5" />
              </button>
              <span className="tabular-nums">
                Page {page} of {totalPages}
              </span>
              <button
                type="button"
                onClick={() => setPage((p) => Math.min(p + 1, totalPages))}
                disabled={page === totalPages}
                aria-label="Next page"
                className="p-1 border border-[var(--border-hairline)] bg-[var(--bg-panel)] disabled:opacity-30 cursor-pointer disabled:cursor-not-allowed text-[var(--ink-primary)]"
              >
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
