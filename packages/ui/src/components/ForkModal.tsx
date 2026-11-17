import { AlertCircle, AlertTriangle, CheckCircle, GitFork, X } from "lucide-react";
import { useState } from "react";
import { forkRun } from "../api.js";
import type { RunDetail, RunEvent } from "../types.js";

interface ForkModalProps {
  run: RunDetail;
  initialEvent?: RunEvent | null;
  isOpen: boolean;
  onClose: () => void;
  onForkSuccess: (forkRunId: string) => void;
}

export function ForkModal({ run, initialEvent, isOpen, onClose, onForkSuccess }: ForkModalProps) {
  const stepEvents = run.events.filter((e) => e.type === "StepCompleted");

  const defaultEvent =
    initialEvent && initialEvent.type === "StepCompleted" ? initialEvent : (stepEvents[0] ?? null);

  const [selectedSeq, setSelectedSeq] = useState<number>(defaultEvent?.seq ?? 1);
  const [editMode, setEditMode] = useState<"input" | "result">("input");

  const activeEvent = run.events.find((e) => e.seq === selectedSeq) ?? defaultEvent;
  const activePayload = (activeEvent?.payload ?? {}) as {
    name?: string;
    input?: unknown;
    result?: unknown;
  };

  const initialJson =
    editMode === "input"
      ? JSON.stringify(activePayload.input ?? {}, null, 2)
      : JSON.stringify(activePayload.result ?? {}, null, 2);

  const [jsonText, setJsonText] = useState<string>(initialJson);
  const [mocksText, setMocksText] = useState<string>("");
  // In-memory ONLY: never written to localStorage, sessionStorage, cookies, or URL
  const [apiToken, setApiToken] = useState<string>("");

  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [forkResult, setForkResult] = useState<{
    forkRunId: string;
    warnings?: string[];
  } | null>(null);

  if (!isOpen) return null;

  const handleSeqChange = (newSeq: number) => {
    setSelectedSeq(newSeq);
    const ev = run.events.find((e) => e.seq === newSeq);
    const p = (ev?.payload ?? {}) as { input?: unknown; result?: unknown };
    setJsonText(JSON.stringify(editMode === "input" ? (p.input ?? {}) : (p.result ?? {}), null, 2));
  };

  const handleEditModeChange = (mode: "input" | "result") => {
    setEditMode(mode);
    setJsonText(
      JSON.stringify(
        mode === "input" ? (activePayload.input ?? {}) : (activePayload.result ?? {}),
        null,
        2,
      ),
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);

    let parsedValue: unknown;
    try {
      parsedValue = JSON.parse(jsonText);
    } catch {
      setErrorMsg("Invalid JSON: Please check the edited value syntax.");
      return;
    }

    let parsedMocks: Array<{ stepName: string; occurrence?: number; result: unknown }> | undefined;
    if (mocksText.trim()) {
      try {
        const parsed = JSON.parse(mocksText);
        if (!Array.isArray(parsed)) {
          setErrorMsg("Mocks must be a JSON array of objects: [{ stepName, result }]");
          return;
        }
        parsedMocks = parsed;
      } catch {
        setErrorMsg("Invalid Mocks JSON: Please check syntax.");
        return;
      }
    }

    setIsSubmitting(true);
    try {
      const result = await forkRun(
        run.id,
        {
          atSeq: selectedSeq,
          edit: {
            [editMode]: parsedValue,
            mocks: parsedMocks,
          },
        },
        apiToken.trim() || undefined,
      );

      const forkId = result.forkRunId || result.runId;
      setForkResult({
        forkRunId: forkId,
        warnings: result.warnings,
      });
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      data-testid="fork-modal"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
    >
      <div className="w-full max-w-2xl bg-[var(--bg-panel)] border border-[var(--border-hairline)] rounded-none shadow-none flex flex-col max-h-[90vh] overflow-hidden text-[var(--ink-primary)]">
        {/* Modal Header */}
        <div className="flex items-center justify-between p-3.5 border-b border-[var(--border-hairline)] bg-[var(--bg-subtle)]">
          <div className="flex items-center gap-2">
            <GitFork className="w-4 h-4 text-[var(--ink-primary)]" />
            <h2 className="text-xs font-mono font-bold uppercase tracking-wider text-[var(--ink-primary)]">
              Create Shadow Fork &bull; Replay With Overrides
            </h2>
            <span className="px-1.5 py-0.5 text-[10px] bg-[var(--status-shadow-bg)] border border-[var(--status-shadow-border)] text-[var(--status-shadow-fg)] font-mono">
              SHADOW ONLY
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close modal"
            title="Close"
            className="p-1 border border-transparent hover:border-[var(--border-hairline)] hover:bg-[var(--bg-hover)] text-[var(--ink-secondary)] hover:text-[var(--ink-primary)] cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-4 overflow-y-auto flex flex-col gap-4 text-xs font-mono">
          {/* Informational banner */}
          <div className="p-2.5 bg-[var(--bg-subtle)] border border-[var(--border-hairline)] text-[var(--ink-secondary)] flex items-start gap-2">
            <GitFork className="w-4 h-4 shrink-0 mt-0.5 text-[var(--ink-primary)]" />
            <span>
              Forks run strictly in <strong>shadow mode</strong>. Side-effectful steps (HTTP/SQL)
              are intercepted with zero live mutations (Safe: external effects mocked / isolated).
            </span>
          </div>

          {forkResult ? (
            /* Success State */
            <div
              data-testid="fork-success-card"
              className="flex flex-col gap-3 p-3 bg-[var(--status-completed-bg)] border border-[var(--status-completed-border)] text-[var(--status-completed-fg)]"
            >
              <div className="flex items-center gap-2 font-bold text-xs uppercase tracking-wide">
                <CheckCircle className="w-4 h-4" />
                <span>Shadow Fork Created Successfully</span>
              </div>
              <div className="flex flex-col gap-1 text-[var(--ink-primary)]">
                <span className="text-[11px] text-[var(--ink-secondary)]">Fork Run ID:</span>
                <span className="font-mono text-xs bg-[var(--bg-subtle)] p-2 border border-[var(--border-hairline)] break-all select-all">
                  {forkResult.forkRunId}
                </span>
              </div>
              {forkResult.warnings && forkResult.warnings.length > 0 && (
                <div className="p-2 bg-[var(--status-running-bg)] border border-[var(--status-running-border)] text-[var(--status-running-fg)] flex flex-col gap-1">
                  <div className="flex items-center gap-1.5 font-bold">
                    <AlertTriangle className="w-3.5 h-3.5" />
                    <span>Warnings:</span>
                  </div>
                  <ul className="list-disc pl-5 text-[11px] space-y-0.5">
                    {forkResult.warnings.map((w) => (
                      <li key={w}>{w}</li>
                    ))}
                  </ul>
                </div>
              )}
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="px-3 py-1.5 border border-[var(--border-hairline)] bg-[var(--bg-subtle)] hover:bg-[var(--bg-hover)] text-[var(--ink-primary)] cursor-pointer text-xs"
                >
                  Close
                </button>
                <button
                  type="button"
                  data-testid="navigate-to-fork-btn"
                  onClick={() => onForkSuccess(forkResult.forkRunId)}
                  className="px-3 py-1.5 bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-[var(--accent-fg)] font-semibold cursor-pointer border border-transparent text-xs"
                >
                  Inspect Shadow Fork
                </button>
              </div>
            </div>
          ) : (
            /* Fork Creation Form */
            <form onSubmit={handleSubmit} className="flex flex-col gap-3.5">
              {errorMsg && (
                <div
                  data-testid="fork-error-banner"
                  className="p-2.5 bg-[var(--status-failed-bg)] border border-[var(--status-failed-border)] flex items-center gap-2 text-[var(--status-failed-fg)]"
                >
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  <span>{errorMsg}</span>
                </div>
              )}

              {/* Step Selection */}
              <div className="flex flex-col gap-1">
                <label
                  htmlFor="fork-step-select"
                  className="font-bold text-[11px] uppercase tracking-wider text-[var(--ink-primary)]"
                >
                  Fork Sequence Boundary:
                </label>
                <select
                  id="fork-step-select"
                  data-testid="fork-step-select"
                  value={selectedSeq}
                  onChange={(e) => handleSeqChange(Number(e.target.value))}
                  className="bg-[var(--bg-subtle)] border border-[var(--border-hairline)] p-2 text-[var(--ink-primary)] font-mono text-xs focus:outline-hidden"
                >
                  {stepEvents.map((ev) => {
                    const p = ev.payload as { name?: string };
                    return (
                      <option key={ev.seq} value={ev.seq}>
                        Seq {ev.seq}: {p.name ?? ev.type}
                      </option>
                    );
                  })}
                </select>
              </div>

              {/* Edit Mode Radio */}
              <div className="flex flex-col gap-1">
                <span className="font-bold text-[11px] uppercase tracking-wider text-[var(--ink-primary)]">
                  Override Parameter Target:
                </span>
                <div className="flex items-center gap-4">
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="radio"
                      name="editMode"
                      value="input"
                      checked={editMode === "input"}
                      onChange={() => handleEditModeChange("input")}
                      className="accent-[var(--accent)]"
                    />
                    <span>Edit Step Input</span>
                  </label>
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="radio"
                      name="editMode"
                      value="result"
                      checked={editMode === "result"}
                      onChange={() => handleEditModeChange("result")}
                      className="accent-[var(--accent)]"
                    />
                    <span>Edit Step Result</span>
                  </label>
                </div>
              </div>

              {/* JSON Textarea */}
              <div className="flex flex-col gap-1">
                <label
                  htmlFor="fork-json-textarea"
                  className="font-bold text-[11px] uppercase tracking-wider text-[var(--ink-primary)]"
                >
                  Edited {editMode === "input" ? "Input" : "Result"} (JSON):
                </label>
                <textarea
                  id="fork-json-textarea"
                  data-testid="fork-json-textarea"
                  rows={5}
                  value={jsonText}
                  onChange={(e) => setJsonText(e.target.value)}
                  className="bg-[var(--bg-subtle)] border border-[var(--border-hairline)] p-2 font-mono text-[var(--ink-primary)] text-xs focus:border-[var(--accent)] focus:outline-hidden"
                />
              </div>

              {/* Optional Mocks Textarea */}
              <div className="flex flex-col gap-1">
                <label
                  htmlFor="fork-mocks-textarea"
                  className="font-bold text-[11px] uppercase tracking-wider text-[var(--ink-secondary)]"
                >
                  Injected Mocks (JSON array of &#123; stepName, result &#125;):
                </label>
                <textarea
                  id="fork-mocks-textarea"
                  data-testid="fork-mocks-textarea"
                  rows={2}
                  placeholder='[ { "stepName": "step-payment", "result": { "status": 200 } } ]'
                  value={mocksText}
                  onChange={(e) => setMocksText(e.target.value)}
                  className="bg-[var(--bg-subtle)] border border-[var(--border-hairline)] p-2 font-mono text-[var(--ink-primary)] text-xs focus:border-[var(--accent)] focus:outline-hidden"
                />
              </div>

              {/* API Token Input (In-Memory Only) */}
              <div className="flex flex-col gap-1">
                <label
                  htmlFor="fork-token-input"
                  className="font-bold text-[11px] uppercase tracking-wider text-[var(--ink-secondary)] flex items-center justify-between"
                >
                  <span>API Bearer Token (Optional):</span>
                  <span className="text-[10px] text-[var(--ink-muted)] font-normal normal-case">
                    Held strictly in memory
                  </span>
                </label>
                <input
                  id="fork-token-input"
                  data-testid="fork-token-input"
                  type="password"
                  placeholder="Bearer token"
                  value={apiToken}
                  onChange={(e) => setApiToken(e.target.value)}
                  className="bg-[var(--bg-subtle)] border border-[var(--border-hairline)] p-2 text-[var(--ink-primary)] text-xs focus:border-[var(--accent)] focus:outline-hidden"
                />
              </div>

              {/* Form Buttons */}
              <div className="flex justify-end gap-2.5 pt-3 border-t border-[var(--border-hairline)]">
                <button
                  type="button"
                  onClick={onClose}
                  className="px-3 py-1.5 border border-[var(--border-hairline)] bg-[var(--bg-subtle)] hover:bg-[var(--bg-hover)] text-[var(--ink-primary)] cursor-pointer text-xs"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  data-testid="submit-fork-btn"
                  className="px-3.5 py-1.5 bg-[var(--accent)] hover:bg-[var(--accent-hover)] disabled:opacity-50 text-[var(--accent-fg)] font-semibold cursor-pointer border border-transparent flex items-center gap-1.5 text-xs"
                >
                  <GitFork className="w-3.5 h-3.5" />
                  {isSubmitting ? "Creating..." : "Execute Shadow Fork"}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
