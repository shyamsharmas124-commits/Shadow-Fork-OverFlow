import { Clock, Cpu, RefreshCw, Server, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { getWorkersApi } from "../api.js";
import type { ActiveLeaseInfo, WorkerInfo } from "../types.js";
import { formatTimeAgo } from "../utils/date.js";

interface WorkerPoolViewProps {
  isOpen: boolean;
  onClose: () => void;
}

export function WorkerPoolView({ isOpen, onClose }: WorkerPoolViewProps) {
  const [workers, setWorkers] = useState<WorkerInfo[]>([]);
  const [activeLeases, setActiveLeases] = useState<ActiveLeaseInfo[]>([]);
  const [totalWorkers, setTotalWorkers] = useState<number>(0);
  const [totalActiveLeases, setTotalActiveLeases] = useState<number>(0);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const fetchWorkers = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await getWorkersApi();
      setWorkers(data.workers);
      setActiveLeases(data.activeLeases);
      setTotalWorkers(data.totalWorkers);
      setTotalActiveLeases(data.totalActiveLeases);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load worker pool");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isOpen) {
      fetchWorkers();
      const timer = setInterval(fetchWorkers, 3000);
      return () => clearInterval(timer);
    }
  }, [isOpen, fetchWorkers]);

  if (!isOpen) return null;

  return (
    <div
      data-testid="worker-pool-modal"
      role="dialog"
      aria-modal="true"
      aria-label="Worker Pool & Active Leases"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
    >
      <div className="w-full max-w-4xl bg-[var(--bg-panel)] border border-[var(--border-hairline)] flex flex-col max-h-[85vh] font-mono text-xs overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between p-3 border-b border-[var(--border-hairline)] bg-[var(--bg-subtle)]">
          <div className="flex items-center gap-2">
            <Server className="w-4 h-4 text-[var(--ink-primary)]" />
            <h2 className="text-xs font-bold uppercase tracking-wider text-[var(--ink-primary)]">
              Worker Pool &bull; Distributed Leases & Heartbeats
            </h2>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              data-testid="refresh-workers-btn"
              onClick={fetchWorkers}
              disabled={isLoading}
              className="p-1 border border-[var(--border-hairline)] bg-[var(--bg-panel)] hover:bg-[var(--bg-hover)] text-[var(--ink-primary)] cursor-pointer"
              title="Refresh workers"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? "animate-spin" : ""}`} />
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close dialog"
              className="p-1 border border-transparent hover:border-[var(--border-hairline)] text-[var(--ink-secondary)] hover:text-[var(--ink-primary)] cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Telemetry Strip */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 p-3 border-b border-[var(--border-hairline)] bg-[var(--bg-panel)]">
          <div className="flex flex-col gap-0.5">
            <span className="text-[10px] text-[var(--ink-secondary)] uppercase">
              Active Workers
            </span>
            <span data-testid="metric-active-workers" className="text-sm font-bold tabular-nums">
              {workers.filter((w) => w.status === "active").length} / {totalWorkers}
            </span>
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="text-[10px] text-[var(--ink-secondary)] uppercase">Active Leases</span>
            <span data-testid="metric-worker-leases" className="text-sm font-bold tabular-nums">
              {totalActiveLeases}
            </span>
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="text-[10px] text-[var(--ink-secondary)] uppercase">Lease TTL</span>
            <span className="text-sm font-bold tabular-nums">30s Heartbeat</span>
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="text-[10px] text-[var(--ink-secondary)] uppercase">
              Fencing Protocol
            </span>
            <span className="text-sm font-bold text-[var(--ink-primary)]">
              Strict Postgres Lock
            </span>
          </div>
        </div>

        {/* Content Body */}
        <div className="p-4 overflow-y-auto flex flex-col gap-4">
          {error && (
            <div className="p-2 border border-[#B91C1C] text-[#B91C1C] dark:text-[#F87171] bg-[#B91C1C]/10 text-xs">
              {error}
            </div>
          )}

          {/* Workers Section */}
          <div className="flex flex-col gap-2">
            <h3 className="text-[11px] font-bold uppercase tracking-wider text-[var(--ink-secondary)]">
              Registered Worker Instances ({workers.length})
            </h3>
            {workers.length === 0 ? (
              <div className="p-4 border border-[var(--border-hairline)] bg-[var(--bg-subtle)] text-center text-[var(--ink-muted)]">
                No active workers detected in task lease registry.
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                {workers.map((w) => {
                  const statusBg =
                    w.status === "active"
                      ? "text-[#1E5A36] dark:text-[#4EAD75] border-[#1E5A36]/40"
                      : w.status === "stale"
                        ? "text-[#B91C1C] dark:text-[#F87171] border-[#B91C1C]/40"
                        : "text-[var(--ink-muted)] border-[var(--border-hairline)]";

                  return (
                    <div
                      key={w.workerId}
                      data-testid={`worker-card-${w.workerId}`}
                      className="p-3 border border-[var(--border-hairline)] bg-[var(--bg-subtle)] flex flex-col gap-2"
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-1.5 font-bold">
                          <Cpu className="w-3.5 h-3.5 text-[var(--ink-secondary)]" />
                          <span className="truncate max-w-[200px]" title={w.workerId}>
                            {w.workerId}
                          </span>
                        </div>
                        <span
                          className={`px-1.5 py-0.5 text-[10px] uppercase font-bold border ${statusBg}`}
                        >
                          {w.status}
                        </span>
                      </div>

                      <div className="grid grid-cols-2 gap-2 text-[11px] text-[var(--ink-secondary)]">
                        <div>
                          Active Tasks:{" "}
                          <span className="font-bold text-[var(--ink-primary)]">
                            {w.activeTasksCount}
                          </span>
                        </div>
                        <div>
                          Total Tasks:{" "}
                          <span className="font-bold text-[var(--ink-primary)]">
                            {w.totalTasksCount}
                          </span>
                        </div>
                        <div className="col-span-2 flex items-center gap-1 text-[10px]">
                          <Clock className="w-3 h-3 text-[var(--ink-muted)]" />
                          Heartbeat:{" "}
                          {w.lastHeartbeatAt ? formatTimeAgo(w.lastHeartbeatAt) : "Never"}
                        </div>
                      </div>

                      {/* Current Task Progress */}
                      {w.currentTasks.length > 0 && (
                        <div className="mt-1 pt-2 border-t border-[var(--border-hairline)] flex flex-col gap-1">
                          <span className="text-[10px] text-[var(--ink-muted)] uppercase">
                            Currently Leased Tasks:
                          </span>
                          {w.currentTasks.map((t) => (
                            <div
                              key={t.id}
                              className="text-[10px] flex items-center justify-between p-1 bg-[var(--bg-panel)] border border-[var(--border-hairline)]"
                            >
                              <span className="truncate max-w-[180px]">
                                {t.workflowType} &bull; {t.stepKey}
                              </span>
                              <span className="text-[9px] text-[var(--ink-muted)]">
                                Att. #{t.attempt}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Active Leases Table */}
          <div className="flex flex-col gap-2 mt-2">
            <h3 className="text-[11px] font-bold uppercase tracking-wider text-[var(--ink-secondary)]">
              Active Leases ({activeLeases.length})
            </h3>
            {activeLeases.length === 0 ? (
              <div className="p-3 border border-[var(--border-hairline)] bg-[var(--bg-subtle)] text-center text-[var(--ink-muted)] text-[11px]">
                No active leases currently held in Postgres tasks table.
              </div>
            ) : (
              <div className="overflow-x-auto border border-[var(--border-hairline)]">
                <table className="w-full text-left text-[11px]">
                  <thead className="bg-[var(--bg-subtle)] text-[10px] uppercase text-[var(--ink-secondary)] border-b border-[var(--border-hairline)]">
                    <tr>
                      <th className="p-2">Task ID</th>
                      <th className="p-2">Workflow / Step</th>
                      <th className="p-2">Lease Owner</th>
                      <th className="p-2">Status</th>
                      <th className="p-2">Expires</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--border-hairline)]">
                    {activeLeases.map((l) => (
                      <tr key={l.id} className="hover:bg-[var(--bg-hover)]">
                        <td className="p-2 font-mono">{l.id.slice(0, 8)}...</td>
                        <td className="p-2">
                          <span className="font-bold">{l.workflowType}</span> &bull; {l.stepKey}
                        </td>
                        <td className="p-2 text-[var(--ink-secondary)]">
                          {l.leaseOwner ?? "None"}
                        </td>
                        <td className="p-2">
                          <span
                            className={`px-1 py-0.2 text-[10px] border ${
                              l.status === "running"
                                ? "text-[#1E5A36] dark:text-[#4EAD75] border-[#1E5A36]/40"
                                : "text-[var(--ink-muted)] border-[var(--border-hairline)]"
                            }`}
                          >
                            {l.status}
                          </span>
                        </td>
                        <td className="p-2 text-[10px] text-[var(--ink-muted)] tabular-nums">
                          {l.leaseExpiresAt ? new Date(l.leaseExpiresAt).toLocaleTimeString() : "-"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="p-2.5 border-t border-[var(--border-hairline)] bg-[var(--bg-subtle)] flex items-center justify-between text-[11px]">
          <span className="text-[10px] text-[var(--ink-muted)]">
            Auto-refreshing every 3s &bull; Read-time redaction applied
          </span>
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1 bg-[var(--bg-panel)] border border-[var(--border-hairline)] text-[var(--ink-primary)] hover:bg-[var(--bg-hover)] cursor-pointer text-xs"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
