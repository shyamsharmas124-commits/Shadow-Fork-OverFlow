import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, GitFork, RefreshCw } from "lucide-react";
import { useState } from "react";
import { getRuns } from "../api.js";
import { ModeBadge, StatusBadge } from "./Badge.js";

interface RunListProps {
  onSelectRun: (id: string) => void;
}

export function RunList({ onSelectRun }: RunListProps) {
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [modeFilter, setModeFilter] = useState<string>("");
  const [page, setPage] = useState<number>(1);
  const pageSize = 10;

  const {
    data: runs = [],
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: ["runs", statusFilter, modeFilter],
    queryFn: () =>
      getRuns({
        status: statusFilter || undefined,
        mode: modeFilter || undefined,
        limit: 50,
      }),
    refetchInterval: 5000,
  });

  const totalPages = Math.ceil(runs.length / pageSize) || 1;
  const paginatedRuns = runs.slice((page - 1) * pageSize, page * pageSize);

  return (
    <div className="flex flex-col gap-6" data-testid="run-list-view">
      {/* Top Filter and Controls Bar */}
      <div className="flex flex-wrap items-center justify-between gap-4 p-4 rounded-lg border border-slate-800 bg-slate-900/50">
        <div className="flex items-center gap-3">
          <label htmlFor="status-select" className="text-xs text-slate-400">
            Status:
          </label>
          <select
            id="status-select"
            value={statusFilter}
            onChange={(e) => {
              setStatusFilter(e.target.value);
              setPage(1);
            }}
            className="text-xs bg-slate-950 border border-slate-800 rounded px-2.5 py-1.5 text-slate-200"
          >
            <option value="">All Statuses</option>
            <option value="running">Running</option>
            <option value="completed">Completed</option>
            <option value="failed">Failed</option>
          </select>

          <label htmlFor="mode-select" className="text-xs text-slate-400">
            Mode:
          </label>
          <select
            id="mode-select"
            value={modeFilter}
            onChange={(e) => {
              setModeFilter(e.target.value);
              setPage(1);
            }}
            className="text-xs bg-slate-950 border border-slate-800 rounded px-2.5 py-1.5 text-slate-200"
          >
            <option value="">All Modes</option>
            <option value="live">Live Only</option>
            <option value="shadow">Shadow Only</option>
          </select>
        </div>

        <button
          type="button"
          onClick={() => refetch()}
          className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-200 px-3 py-1.5 rounded border border-slate-800 bg-slate-900 cursor-pointer"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          Refresh
        </button>
      </div>

      {/* Table Container */}
      <div className="rounded-lg border border-slate-800 overflow-hidden bg-slate-900/30">
        {isLoading ? (
          <div className="p-12 text-center text-slate-400">Loading workflows...</div>
        ) : error ? (
          <div className="p-8 text-center text-rose-400">Failed to load runs: {String(error)}</div>
        ) : runs.length === 0 ? (
          <div className="p-12 text-center text-slate-500">No workflow runs found.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs text-left text-slate-300">
              <thead className="bg-slate-950/80 text-slate-400 uppercase tracking-wider border-b border-slate-800">
                <tr>
                  <th className="p-3.5">Run ID</th>
                  <th className="p-3.5">Workflow</th>
                  <th className="p-3.5">Status</th>
                  <th className="p-3.5">Mode</th>
                  <th className="p-3.5">Parent Run</th>
                  <th className="p-3.5">Duration</th>
                  <th className="p-3.5">Created At</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60 font-mono">
                {paginatedRuns.map((r) => (
                  <tr
                    key={r.id}
                    data-testid={`run-row-${r.id}`}
                    onClick={() => onSelectRun(r.id)}
                    className="hover:bg-slate-800/40 cursor-pointer transition-colors"
                  >
                    <td className="p-3.5 font-bold text-slate-100 flex items-center gap-1.5">
                      {r.mode === "shadow" && <GitFork className="w-3.5 h-3.5 text-purple-400" />}
                      <span className="hover:text-purple-400">{r.id}</span>
                    </td>
                    <td className="p-3.5 font-sans font-medium text-slate-200">{r.workflowType}</td>
                    <td className="p-3.5 font-sans">
                      <StatusBadge status={r.status} />
                    </td>
                    <td className="p-3.5 font-sans">
                      <ModeBadge mode={r.mode} />
                    </td>
                    <td className="p-3.5">
                      {r.parentRunId ? (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onSelectRun(r.parentRunId!);
                          }}
                          className="text-purple-400 hover:underline flex items-center gap-1 cursor-pointer"
                        >
                          <GitFork className="w-3 h-3" />
                          <span>{r.parentRunId.slice(0, 8)}...</span>
                        </button>
                      ) : (
                        <span className="text-slate-500 font-sans">-</span>
                      )}
                    </td>
                    <td className="p-3.5 font-sans text-slate-400">
                      {r.timing.durationMs !== null ? `${r.timing.durationMs}ms` : "Running"}
                    </td>
                    <td className="p-3.5 font-sans text-slate-400">
                      {new Date(r.timing.createdAt).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination Bar */}
        {runs.length > pageSize && (
          <div className="flex items-center justify-between p-3 border-t border-slate-800 bg-slate-950/60 text-xs text-slate-400">
            <div>
              Showing {(page - 1) * pageSize + 1} to {Math.min(page * pageSize, runs.length)} of{" "}
              {runs.length} runs
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setPage((p) => Math.max(p - 1, 1))}
                disabled={page === 1}
                className="p-1 rounded border border-slate-800 bg-slate-900 disabled:opacity-40 cursor-pointer disabled:cursor-not-allowed"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <span>
                Page {page} of {totalPages}
              </span>
              <button
                type="button"
                onClick={() => setPage((p) => Math.min(p + 1, totalPages))}
                disabled={page === totalPages}
                className="p-1 rounded border border-slate-800 bg-slate-900 disabled:opacity-40 cursor-pointer disabled:cursor-not-allowed"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
