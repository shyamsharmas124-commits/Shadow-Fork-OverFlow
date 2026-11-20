import { useQuery } from "@tanstack/react-query";
import {
  GitBranch,
  GitCompare,
  HelpCircle,
  Inbox,
  KeyRound,
  Moon,
  Search,
  Server,
  Sun,
  X,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { getHealthApi, getRun, getRuns } from "./api.js";
import { ApprovalInbox } from "./components/ApprovalInbox.js";
import { CommandPalette } from "./components/CommandPalette.js";
import { CompareRunsModal } from "./components/CompareRunsModal.js";
import { LivePollingControl, type PollingSpeed } from "./components/LivePollingControl.js";
import { RunDetail } from "./components/RunDetail.js";
import { RunList } from "./components/RunList.js";
import { StatusBar } from "./components/StatusBar.js";
import { ToastContainer, type ToastMessage } from "./components/Toast.js";
import { WorkerPoolView } from "./components/WorkerPoolView.js";
import type { RunDetail as RunDetailType, RunSummary } from "./types.js";
import { startViewTransition } from "./utils/motion.js";
import { applyTheme, getInitialTheme, type Theme } from "./utils/theme.js";

export function App() {
  const [selectedRunId, setSelectedRunId] = useState<string | null>(() => {
    const hash = window.location.hash.replace(/^#/, "");
    // Check if hash has run=...
    if (hash.startsWith("run=")) {
      const params = new URLSearchParams(hash);
      return params.get("run") || null;
    }
    return hash || null;
  });

  const [theme, setTheme] = useState<Theme>(getInitialTheme);
  const [showShortcuts, setShowShortcuts] = useState<boolean>(false);
  const [showCommandPalette, setShowCommandPalette] = useState<boolean>(false);
  const [showWorkersModal, setShowWorkersModal] = useState<boolean>(false);
  const [showCompareModal, setShowCompareModal] = useState<boolean>(false);
  const [currentView, setCurrentView] = useState<"registry" | "approvals">("registry");

  // In-memory token management (strictly held in memory, never persisted to disk or localStorage)
  const [inMemoryToken, setInMemoryToken] = useState<string>("");
  const [showTokenInput, setShowTokenInput] = useState<boolean>(false);

  // Live polling state
  const [pollingSpeed, setPollingSpeed] = useState<PollingSpeed>(5000);
  const [backoffMs, setBackoffMs] = useState<number>(0);
  const [lastSyncAt, setLastSyncAt] = useState<Date | null>(new Date());
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  // Detailed runs cache for approvals
  const [runDetailsMap, setRunDetailsMap] = useState<Record<string, RunDetailType>>({});

  const addToast = (type: "success" | "error" | "info", message: string) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setToasts((prev) => [...prev, { id, type, message }]);
  };

  const removeToast = (id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  };

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme((prev) => (prev === "light" ? "dark" : "light"));
  }, []);

  const handleSelectRun = useCallback((id: string) => {
    window.location.hash = `run=${id}`;
    setSelectedRunId((prev) => {
      if (prev !== id) {
        startViewTransition(() => {
          setSelectedRunId(id);
          setCurrentView("registry");
        });
      }
      return id;
    });
  }, []);

  // Track document visibility state to pause live polling when tab is hidden
  const [isTabVisible, setIsTabVisible] = useState<boolean>(() =>
    typeof document !== "undefined" ? document.visibilityState !== "hidden" : true,
  );

  useEffect(() => {
    if (typeof document === "undefined") return;
    const handleVisibilityChange = () => {
      setIsTabVisible(document.visibilityState !== "hidden");
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, []);

  // Runs Query with adaptive live polling
  const {
    data: runsData,
    refetch: refetchRuns,
    isFetching,
  } = useQuery({
    queryKey: ["all-runs"],
    queryFn: async () => {
      try {
        const res = await getRuns({ limit: 50 });
        setBackoffMs(0);
        setLastSyncAt(new Date());
        return res;
      } catch (err) {
        // Exponential backoff up to 10s
        setBackoffMs((prev) => Math.min(prev === 0 ? 1000 : prev * 2, 10000));
        throw err;
      }
    },
    refetchInterval: !isTabVisible || pollingSpeed === "paused" ? false : pollingSpeed + backoffMs,
  });

  // Health & System Telemetry Query
  const { data: healthData } = useQuery({
    queryKey: ["system-health"],
    queryFn: getHealthApi,
    refetchInterval: !isTabVisible || pollingSpeed === "paused" ? false : 3000,
  });

  const runs: RunSummary[] = runsData?.runs ?? [];

  // Prefetch details for running runs with pending approvals
  useEffect(() => {
    const runningRuns = runs.filter((r) => r.status === "running");
    for (const r of runningRuns) {
      if (!runDetailsMap[r.id]) {
        getRun(r.id)
          .then((d) => {
            setRunDetailsMap((prev) => ({ ...prev, [r.id]: d }));
          })
          .catch(() => {});
      }
    }
  }, [runs, runDetailsMap]);

  // Handle URL hash navigation
  useEffect(() => {
    const onHashChange = () => {
      const hash = window.location.hash.replace(/^#/, "");
      let targetId: string | null = null;
      if (hash.startsWith("run=")) {
        const params = new URLSearchParams(hash);
        targetId = params.get("run") || null;
      } else {
        targetId = hash || null;
      }

      startViewTransition(() => {
        setSelectedRunId(targetId);
        if (targetId) setCurrentView("registry");
      });
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  // Keyboard Shortcuts (j/k, f, d, ?, Ctrl+K, Esc)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Command palette trigger: Ctrl+K or Cmd+K
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setShowCommandPalette((prev) => !prev);
        return;
      }

      // Don't trigger single-key navigation if user is inside an input or textarea
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
      ) {
        return;
      }

      if (e.key === "?") {
        e.preventDefault();
        setShowShortcuts((prev) => !prev);
      } else if (e.key === "m" || e.key === "M") {
        e.preventDefault();
        toggleTheme();
      } else if (e.key === "Escape") {
        setShowShortcuts(false);
        setShowCommandPalette(false);
        setShowWorkersModal(false);
        setShowCompareModal(false);
        setShowTokenInput(false);
      } else if (e.key === "j" || e.key === "k") {
        // j/k navigation through run registry
        if (!selectedRunId && runs.length > 0) {
          e.preventDefault();
          const firstRun = runs[0];
          if (firstRun) handleSelectRun(firstRun.id);
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selectedRunId, runs, toggleTheme, handleSelectRun]);

  const handleBack = () => {
    window.location.hash = "";
    if (selectedRunId !== null) {
      startViewTransition(() => {
        setSelectedRunId(null);
      });
    }
  };

  // Count pending approvals
  const pendingApprovalsCount = Object.values(runDetailsMap).reduce((acc, detail) => {
    const reqs = detail.events.filter((e) => e.type === "ApprovalRequested");
    const pending = reqs.filter((r) => {
      const name = (r.payload as { name?: string }).name || "default";
      return !detail.events.some(
        (e) =>
          (e.type === "ApprovalGranted" || e.type === "ApprovalRejected") &&
          (e.payload as { name?: string }).name === name,
      );
    });
    return acc + pending.length;
  }, 0);

  return (
    <div className="min-h-screen bg-[var(--bg-page)] text-[var(--ink-primary)] font-mono flex flex-col selection:bg-[var(--accent)] selection:text-[var(--accent-fg)]">
      {/* Top Instrument Status Bar */}
      <header className="border-b border-[var(--border-hairline)] bg-[var(--bg-panel)] sticky top-0 z-40 px-4 py-2">
        <div className="max-w-7xl mx-auto flex flex-wrap items-center justify-between gap-3 text-xs">
          {/* Logo & Navigation */}
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={handleBack}
              className="flex items-center gap-2 cursor-pointer text-left bg-transparent border-none p-0 text-[var(--ink-primary)]"
            >
              <div className="p-1 border border-[var(--border-hairline)] bg-[var(--bg-subtle)] text-[var(--ink-primary)]">
                <GitBranch className="w-4 h-4" />
              </div>
              <div className="flex items-center gap-1.5">
                <span className="font-bold text-xs tracking-wider uppercase text-[var(--ink-primary)]">
                  Durable Engine
                </span>
                <span className="text-[10px] text-[var(--ink-muted)]">::</span>
                <span className="text-[10px] text-[var(--ink-secondary)] uppercase">
                  Instrument Panel
                </span>
              </div>
            </button>

            {/* View Switchers */}
            <div className="hidden sm:flex items-center gap-1 pl-2 border-l border-[var(--border-hairline)]">
              <button
                type="button"
                data-testid="nav-registry-btn"
                onClick={() => {
                  setCurrentView("registry");
                  if (selectedRunId) handleBack();
                }}
                className={`px-2 py-0.5 text-[11px] font-bold border transition-colors cursor-pointer ${
                  currentView === "registry" && !selectedRunId
                    ? "bg-[var(--bg-subtle)] border-[var(--ink-primary)] text-[var(--ink-primary)]"
                    : "border-transparent text-[var(--ink-primary)] hover:bg-[var(--bg-hover)]"
                }`}
              >
                Runs ({runs.length})
              </button>
              <button
                type="button"
                data-testid="nav-approvals-btn"
                onClick={() => {
                  setCurrentView("approvals");
                  setSelectedRunId(null);
                }}
                className={`px-2 py-0.5 text-[11px] font-bold border transition-colors cursor-pointer flex items-center gap-1.5 ${
                  currentView === "approvals"
                    ? "bg-[var(--bg-subtle)] border-[var(--ink-primary)] text-[var(--ink-primary)]"
                    : "border-transparent text-[var(--ink-primary)] hover:bg-[var(--bg-hover)]"
                }`}
              >
                <Inbox className="w-3.5 h-3.5" />
                Approvals
                {pendingApprovalsCount > 0 && (
                  <span
                    data-testid="nav-pending-approval-count"
                    className="px-1 py-0.1 bg-[var(--status-running-bg)] border border-[var(--status-running-border)] text-[var(--status-running-fg)] text-[9px]"
                  >
                    {pendingApprovalsCount}
                  </span>
                )}
              </button>
            </div>
          </div>

          {/* Quick Command Palette Button */}
          <button
            type="button"
            data-testid="quick-command-palette-btn"
            onClick={() => setShowCommandPalette(true)}
            className="hidden md:flex items-center gap-2 px-2.5 py-1 bg-[var(--bg-subtle)] hover:bg-[var(--bg-hover)] border border-[var(--border-hairline)] text-[var(--ink-secondary)] hover:text-[var(--ink-primary)] cursor-pointer text-xs"
          >
            <Search className="w-3.5 h-3.5" />
            <span>Search or command...</span>
            <kbd className="px-1 py-0.2 border border-[var(--border-hairline)] bg-[var(--bg-panel)] text-[10px]">
              Ctrl+K
            </kbd>
          </button>

          {/* System Telemetry Strips & Controls */}
          <div className="flex items-center gap-3 text-[11px] text-[var(--ink-secondary)]">
            {/* Feature 8: Live Polling Control */}
            <LivePollingControl
              speed={pollingSpeed}
              onChangeSpeed={setPollingSpeed}
              isPolling={isFetching}
              backoffMs={backoffMs}
              lastSyncAt={lastSyncAt}
              onManualRefresh={() => refetchRuns()}
            />

            {/* Workers & Leases Modal Trigger */}
            <button
              type="button"
              data-testid="open-workers-modal-btn"
              onClick={() => setShowWorkersModal(true)}
              className="hidden lg:flex items-center gap-1.5 px-2 py-1 border border-[var(--border-hairline)] bg-[var(--bg-subtle)] hover:bg-[var(--bg-hover)] text-[var(--ink-primary)] cursor-pointer text-[11px]"
              title="Worker Pool & Task Leases"
            >
              <Server className="w-3.5 h-3.5 text-[var(--ink-muted)]" />
              <span>Workers &amp; Leases</span>
            </button>

            {/* Compare Runs Trigger */}
            <button
              type="button"
              data-testid="top-compare-btn"
              onClick={() => setShowCompareModal(true)}
              className="hidden lg:flex items-center gap-1 px-2 py-1 border border-[var(--border-hairline)] bg-[var(--bg-subtle)] hover:bg-[var(--bg-hover)] text-[var(--ink-primary)] cursor-pointer text-[11px]"
              title="Compare Any Two Runs"
            >
              <GitCompare className="w-3.5 h-3.5" />
              <span>Compare</span>
            </button>

            {/* In-Memory Token Status */}
            <button
              type="button"
              data-testid="token-status-indicator"
              onClick={() => setShowTokenInput(true)}
              className="flex items-center gap-1 px-2 py-1 border border-[var(--border-hairline)] bg-[var(--bg-subtle)] hover:bg-[var(--bg-hover)] text-[10px] cursor-pointer"
              title="In-Memory API Token (Never Persisted to Disk)"
            >
              <KeyRound className="w-3 h-3 text-[var(--ink-muted)]" />
              <span className="font-bold">TOKEN: {inMemoryToken ? "[PRESENT]" : "[NONE]"}</span>
            </button>

            {/* Manual Theme Toggle */}
            <button
              type="button"
              data-testid="theme-toggle-btn"
              onClick={toggleTheme}
              title="Switch theme (m)"
              className="flex items-center gap-1 px-2 py-1 border border-[var(--border-hairline)] bg-[var(--bg-subtle)] hover:bg-[var(--bg-hover)] text-[var(--ink-primary)] cursor-pointer text-[11px]"
            >
              {theme === "light" ? (
                <>
                  <Moon className="w-3 h-3 text-[var(--ink-secondary)]" />
                  <span>DARK [m]</span>
                </>
              ) : (
                <>
                  <Sun className="w-3 h-3 text-[var(--ink-secondary)]" />
                  <span>LIGHT [m]</span>
                </>
              )}
            </button>

            {/* Shortcuts Trigger */}
            <button
              type="button"
              onClick={() => setShowShortcuts(true)}
              aria-label="Keyboard Shortcuts Cheat Sheet (?)"
              title="Keyboard Shortcuts (?)"
              className="p-1 border border-[var(--border-hairline)] bg-[var(--bg-subtle)] hover:bg-[var(--bg-hover)] text-[var(--ink-primary)] cursor-pointer"
            >
              <HelpCircle className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="flex-1 max-w-7xl w-full mx-auto p-4">
        {selectedRunId ? (
          <RunDetail
            runId={selectedRunId}
            onBack={handleBack}
            onSelectRun={handleSelectRun}
            allRuns={runs}
          />
        ) : currentView === "approvals" ? (
          <ApprovalInbox
            runs={runs}
            runDetails={runDetailsMap}
            apiToken={inMemoryToken}
            onSelectRun={handleSelectRun}
            onApprovalSuccess={(runId) => {
              addToast("success", `Decision recorded for run ${runId.slice(0, 8)}...`);
              refetchRuns();
            }}
          />
        ) : (
          <RunList onSelectRun={handleSelectRun} />
        )}
      </main>

      {/* Persistent Instrument Status Bar & Telemetry Footer */}
      {/* System Status Bar */}
      <StatusBar healthData={healthData} inMemoryToken={inMemoryToken} />

      {/* Feature 2: Command Palette Modal */}
      <CommandPalette
        isOpen={showCommandPalette}
        onClose={() => setShowCommandPalette(false)}
        runs={runs}
        currentRunId={selectedRunId}
        onSelectRun={handleSelectRun}
        onToggleTheme={toggleTheme}
        onOpenExport={() => {
          if (!selectedRunId && runs[0]) handleSelectRun(runs[0].id);
        }}
      />

      {/* Feature 7: Worker Pool Modal */}
      <WorkerPoolView isOpen={showWorkersModal} onClose={() => setShowWorkersModal(false)} />

      {/* Feature 6: Compare Any Two Runs Modal */}
      <CompareRunsModal
        isOpen={showCompareModal}
        onClose={() => setShowCompareModal(false)}
        runs={runs}
        initialRunA={runs[0]?.id}
        initialRunB={runs[1]?.id || runs[0]?.id}
      />

      {/* In-Memory Token Configuration Dialog */}
      {showTokenInput && (
        <div
          data-testid="token-config-modal"
          role="dialog"
          aria-modal="true"
          aria-label="In-Memory API Token"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
        >
          <div className="w-full max-w-md bg-[var(--bg-panel)] border border-[var(--border-hairline)] p-4 flex flex-col gap-3 font-mono text-xs text-[var(--ink-primary)]">
            <div className="flex items-center justify-between border-b border-[var(--border-hairline)] pb-2">
              <span className="font-bold uppercase tracking-wider text-xs flex items-center gap-1.5">
                <KeyRound className="w-4 h-4" />
                In-Memory Authentication Token
              </span>
              <button
                type="button"
                onClick={() => setShowTokenInput(false)}
                aria-label="Close dialog"
                className="p-1 hover:bg-[var(--bg-hover)] cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <p className="text-[11px] text-[var(--ink-secondary)]">
              This token is stored purely in React memory and used for mutating requests (forks,
              approvals). It is never saved to localStorage, indexedDB, or browser cookies.
            </p>

            <div className="flex flex-col gap-1">
              <label
                htmlFor="token-input"
                className="text-[10px] uppercase text-[var(--ink-muted)]"
              >
                Bearer Token:
              </label>
              <input
                id="token-input"
                data-testid="token-secret-input"
                type="password"
                value={inMemoryToken}
                onChange={(e) => setInMemoryToken(e.target.value)}
                placeholder="Paste API_TOKEN here"
                className="w-full p-2 bg-[var(--bg-subtle)] border border-[var(--border-hairline)] text-xs text-[var(--ink-primary)] focus:outline-hidden"
              />
            </div>

            <div className="flex items-center justify-between pt-2 border-t border-[var(--border-hairline)]">
              {inMemoryToken ? (
                <button
                  type="button"
                  data-testid="clear-token-btn"
                  onClick={() => {
                    setInMemoryToken("");
                    addToast("info", "In-memory API token cleared");
                  }}
                  className="text-[11px] text-[#B91C1C] dark:text-[#F87171] hover:underline cursor-pointer"
                >
                  Clear Token
                </button>
              ) : (
                <span />
              )}

              <button
                type="button"
                data-testid="save-token-btn"
                onClick={() => {
                  setShowTokenInput(false);
                  addToast("success", inMemoryToken ? "Token loaded in memory" : "Token cleared");
                }}
                className="px-3 py-1 bg-[var(--bg-subtle)] border border-[var(--border-hairline)] text-[var(--ink-primary)] hover:bg-[var(--bg-hover)] cursor-pointer text-xs font-bold"
              >
                Save to Session
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Keyboard Shortcuts Dialog Modal */}
      {showShortcuts && (
        <div
          role="dialog"
          aria-label="Keyboard Shortcuts Cheat Sheet"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
        >
          <div className="w-full max-w-md bg-[var(--bg-panel)] border border-[var(--border-hairline)] p-4 flex flex-col gap-3 font-mono text-xs text-[var(--ink-primary)]">
            <div className="flex items-center justify-between border-b border-[var(--border-hairline)] pb-2">
              <span className="font-bold uppercase tracking-wider text-xs">Keyboard Shortcuts</span>
              <button
                type="button"
                onClick={() => setShowShortcuts(false)}
                aria-label="Close shortcuts dialog"
                className="p-1 border border-transparent hover:border-[var(--border-hairline)] text-[var(--ink-secondary)] hover:text-[var(--ink-primary)] cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="flex flex-col gap-2 text-[11px]">
              <div className="flex items-center justify-between py-1 border-b border-[var(--border-hairline)]">
                <span className="text-[var(--ink-secondary)]">Command Palette</span>
                <kbd className="px-1.5 py-0.5 border border-[var(--border-hairline)] bg-[var(--bg-subtle)]">
                  Ctrl+K / Cmd+K
                </kbd>
              </div>
              <div className="flex items-center justify-between py-1 border-b border-[var(--border-hairline)]">
                <span className="text-[var(--ink-secondary)]">Toggle Keyboard Cheat Sheet</span>
                <kbd className="px-1.5 py-0.5 border border-[var(--border-hairline)] bg-[var(--bg-subtle)]">
                  ?
                </kbd>
              </div>
              <div className="flex items-center justify-between py-1 border-b border-[var(--border-hairline)]">
                <span className="text-[var(--ink-secondary)]">Toggle Light / Dark Theme</span>
                <kbd className="px-1.5 py-0.5 border border-[var(--border-hairline)] bg-[var(--bg-subtle)]">
                  m
                </kbd>
              </div>
              <div className="flex items-center justify-between py-1 border-b border-[var(--border-hairline)]">
                <span className="text-[var(--ink-secondary)]">Close Dialog / Drawer</span>
                <kbd className="px-1.5 py-0.5 border border-[var(--border-hairline)] bg-[var(--bg-subtle)]">
                  Esc
                </kbd>
              </div>
            </div>
            <div className="pt-2 border-t border-[var(--border-hairline)] flex justify-end">
              <button
                type="button"
                onClick={() => setShowShortcuts(false)}
                className="px-3 py-1 bg-[var(--bg-subtle)] border border-[var(--border-hairline)] text-[var(--ink-primary)] hover:bg-[var(--bg-hover)] cursor-pointer text-xs"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Feature 10: Toasts Notification Container */}
      <ToastContainer toasts={toasts} onDismiss={removeToast} />
    </div>
  );
}
