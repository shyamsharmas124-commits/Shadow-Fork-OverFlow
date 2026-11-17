import { Code, Download, GitFork, Search, SplitSquareVertical, Sun } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { RunSummary } from "../types.js";

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  runs: RunSummary[];
  currentRunId: string | null;
  onSelectRun: (id: string) => void;
  onForkRun?: () => void;
  onToggleTheme: () => void;
  onOpenExport?: () => void;
  onOpenSnippets?: () => void;
  onSwitchTab?: (tab: "timeline" | "diff") => void;
}

export function CommandPalette({
  isOpen,
  onClose,
  runs,
  currentRunId,
  onSelectRun,
  onForkRun,
  onToggleTheme,
  onOpenExport,
  onOpenSnippets,
  onSwitchTab,
}: CommandPaletteProps) {
  const [query, setQuery] = useState<string>("");
  const [selectedIndex, setSelectedIndex] = useState<number>(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setQuery("");
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  const actions = useMemo(() => {
    const list: Array<{
      id: string;
      label: string;
      category: "Action" | "Run";
      icon: typeof Search;
      execute: () => void;
    }> = [];

    // Contextual Actions
    if (currentRunId && onForkRun) {
      list.push({
        id: "action-fork",
        label: `Fork Current Run (${currentRunId.slice(0, 8)}...)`,
        category: "Action",
        icon: GitFork,
        execute: () => {
          onClose();
          onForkRun();
        },
      });
    }

    if (currentRunId && onSwitchTab) {
      list.push({
        id: "action-diff",
        label: "Switch to Execution Diff View",
        category: "Action",
        icon: SplitSquareVertical,
        execute: () => {
          onClose();
          onSwitchTab("diff");
        },
      });
      list.push({
        id: "action-timeline",
        label: "Switch to Timeline View",
        category: "Action",
        icon: Search,
        execute: () => {
          onClose();
          onSwitchTab("timeline");
        },
      });
    }

    if (onOpenSnippets) {
      list.push({
        id: "action-snippets",
        label: "Open cURL / CLI Command Generator",
        category: "Action",
        icon: Code,
        execute: () => {
          onClose();
          onOpenSnippets();
        },
      });
    }

    if (onOpenExport) {
      list.push({
        id: "action-export",
        label: "Export / Import Run Trace (JSON)",
        category: "Action",
        icon: Download,
        execute: () => {
          onClose();
          onOpenExport();
        },
      });
    }

    list.push({
      id: "action-theme",
      label: "Toggle Light / Dark Theme",
      category: "Action",
      icon: Sun,
      execute: () => {
        onClose();
        onToggleTheme();
      },
    });

    // Run Search Matches
    const q = query.trim().toLowerCase();
    for (const r of runs) {
      const matchId = r.id.toLowerCase().includes(q);
      const matchWf = r.workflowType.toLowerCase().includes(q);
      const matchStatus = r.status.toLowerCase().includes(q);
      if (!q || matchId || matchWf || matchStatus) {
        list.push({
          id: `run-${r.id}`,
          label: `${r.id} (${r.workflowType} - ${r.status})`,
          category: "Run",
          icon: GitFork,
          execute: () => {
            onClose();
            onSelectRun(r.id);
          },
        });
      }
    }

    return list;
  }, [
    query,
    runs,
    currentRunId,
    onForkRun,
    onSwitchTab,
    onOpenSnippets,
    onOpenExport,
    onToggleTheme,
    onSelectRun,
    onClose,
  ]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((prev) => (prev + 1) % Math.max(actions.length, 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((prev) => (prev - 1 + actions.length) % Math.max(actions.length, 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const active = actions[selectedIndex];
      if (active) active.execute();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  if (!isOpen) return null;

  return (
    <div
      data-testid="command-palette"
      role="dialog"
      aria-modal="true"
      aria-label="Command Palette"
      className="fixed inset-0 z-50 flex items-start justify-center pt-20 bg-black/60 p-4"
    >
      <div className="w-full max-w-xl bg-[var(--bg-panel)] border border-[var(--border-hairline)] flex flex-col font-mono text-xs overflow-hidden">
        {/* Search Header */}
        <div className="flex items-center gap-2.5 p-3 border-b border-[var(--border-hairline)] bg-[var(--bg-subtle)]">
          <Search className="w-4 h-4 text-[var(--ink-secondary)] shrink-0" />
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded={isOpen}
            aria-controls="command-palette-results"
            aria-activedescendant={actions[selectedIndex]?.id}
            data-testid="command-palette-input"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIndex(0);
            }}
            onKeyDown={handleKeyDown}
            placeholder="Type a command or search runs by ID / status / workflow..."
            className="w-full bg-transparent text-[var(--ink-primary)] text-xs focus:outline-hidden"
          />
          <kbd className="px-1.5 py-0.5 border border-[var(--border-hairline)] bg-[var(--bg-panel)] text-[10px] text-[var(--ink-secondary)]">
            ESC
          </kbd>
        </div>

        {/* Results Listbox */}
        <div
          id="command-palette-results"
          role="listbox"
          data-testid="command-palette-list"
          className="max-h-72 overflow-y-auto divide-y divide-[var(--border-hairline)]"
        >
          {actions.length === 0 ? (
            <div className="p-4 text-center text-xs text-[var(--ink-muted)]">
              No matching commands or runs found.
            </div>
          ) : (
            actions.map((act, idx) => {
              const isSelected = idx === selectedIndex;
              const Icon = act.icon;
              return (
                <button
                  type="button"
                  key={act.id}
                  id={act.id}
                  role="option"
                  tabIndex={0}
                  aria-selected={isSelected}
                  data-testid={`command-palette-item-${act.id}`}
                  onClick={() => act.execute()}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      act.execute();
                    }
                  }}
                  className={`w-full text-left p-2.5 flex items-center justify-between cursor-pointer transition-colors ${
                    isSelected
                      ? "bg-[var(--bg-subtle)] font-bold text-[var(--ink-primary)]"
                      : "text-[var(--ink-secondary)] hover:bg-[var(--bg-hover)]"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <Icon className="w-3.5 h-3.5 shrink-0" />
                    <span>{act.label}</span>
                  </div>
                  <span className="text-[10px] uppercase text-[var(--ink-muted)] px-1 border border-[var(--border-hairline)]">
                    {act.category}
                  </span>
                </button>
              );
            })
          )}
        </div>

        {/* Footer */}
        <div className="p-2 border-t border-[var(--border-hairline)] bg-[var(--bg-subtle)] flex items-center justify-between text-[10px] text-[var(--ink-muted)]">
          <span>Use ↑ and ↓ to navigate, Enter to select</span>
          <span>Cmd+K / Ctrl+K</span>
        </div>
      </div>
    </div>
  );
}
