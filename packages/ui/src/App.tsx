import { Activity, Database, GitBranch, HelpCircle, Moon, Server, Sun, X } from "lucide-react";
import { useEffect, useState } from "react";
import { RunDetail } from "./components/RunDetail.js";
import { RunList } from "./components/RunList.js";
import { applyTheme, getInitialTheme, type Theme } from "./utils/theme.js";

export function App() {
  const [selectedRunId, setSelectedRunId] = useState<string | null>(() => {
    const hash = window.location.hash.replace(/^#/, "");
    return hash || null;
  });

  const [theme, setTheme] = useState<Theme>(getInitialTheme);
  const [showShortcuts, setShowShortcuts] = useState<boolean>(false);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const toggleTheme = () => {
    setTheme((prev) => (prev === "light" ? "dark" : "light"));
  };

  useEffect(() => {
    const onHashChange = () => {
      const hash = window.location.hash.replace(/^#/, "");
      setSelectedRunId(hash || null);
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  // Global keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't trigger if user is typing in an input or textarea
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
        setTheme((prev) => (prev === "light" ? "dark" : "light"));
      } else if (e.key === "Escape") {
        setShowShortcuts(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const handleSelectRun = (id: string) => {
    window.location.hash = id;
    setSelectedRunId(id);
  };

  const handleBack = () => {
    window.location.hash = "";
    setSelectedRunId(null);
  };

  return (
    <div className="min-h-screen bg-[var(--bg-page)] text-[var(--ink-primary)] font-mono flex flex-col selection:bg-[var(--accent)] selection:text-[var(--accent-fg)]">
      {/* Top Instrument Status Bar */}
      <header className="border-b border-[var(--border-hairline)] bg-[var(--bg-panel)] sticky top-0 z-40 px-4 py-2">
        <div className="max-w-7xl mx-auto flex flex-wrap items-center justify-between gap-3 text-xs">
          {/* Logo & Navigation */}
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

          {/* System Telemetry Strips */}
          <div className="flex items-center gap-4 text-[11px] text-[var(--ink-secondary)]">
            <span className="flex items-center gap-1.5">
              <span className="inline-block w-2 h-2 bg-[#1E5A36] dark:bg-[#4EAD75]" />
              <Activity className="w-3.5 h-3.5 text-[#1E5A36] dark:text-[#4EAD75]" />
              <span>LIVE</span>
            </span>

            <span className="hidden sm:flex items-center gap-1.5">
              <Server className="w-3.5 h-3.5 text-[var(--ink-muted)]" />
              <span>1 worker active</span>
            </span>

            <span className="hidden sm:flex items-center gap-1.5">
              <Database className="w-3.5 h-3.5 text-[var(--ink-muted)]" />
              <span className="tabular-nums">db: &lt;1ms</span>
            </span>

            <span className="hidden md:inline px-1 py-0.5 border border-[var(--border-hairline)] bg-[var(--bg-subtle)] text-[10px]">
              schema: v1
            </span>

            {/* Manual Theme Toggle */}
            <button
              type="button"
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
          <RunDetail runId={selectedRunId} onBack={handleBack} onSelectRun={handleSelectRun} />
        ) : (
          <RunList onSelectRun={handleSelectRun} />
        )}
      </main>

      {/* Bottom Keyboard Hints Bar & Footer */}
      <footer className="border-t border-[var(--border-hairline)] bg-[var(--bg-panel)] py-2 px-4 text-xs font-mono">
        <div className="max-w-7xl mx-auto flex flex-wrap items-center justify-between gap-2 text-[11px] text-[var(--ink-secondary)]">
          <div className="flex items-center gap-3">
            <span className="text-[var(--ink-muted)]">Shortcuts:</span>
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
            <span>
              <kbd className="px-1 border border-[var(--border-hairline)] bg-[var(--bg-subtle)]">
                Esc
              </kbd>{" "}
              dismiss
            </span>
          </div>
          <div>Durable Workflow Engine &bull; Instrument Panel</div>
        </div>
      </footer>

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
              <div className="flex items-center justify-between py-1">
                <span className="text-[var(--ink-secondary)]">Select Run / Inspect</span>
                <span className="text-[var(--ink-muted)]">Click Row</span>
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
    </div>
  );
}
