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
  // Filter StepCompleted events as forkable points
  const stepEvents = run.events.filter((e) => e.type === "StepCompleted");

  // Determine starting event
  const defaultEvent =
    initialEvent && initialEvent.type === "StepCompleted" ? initialEvent : (stepEvents[0] ?? null);

  const [selectedSeq, setSelectedSeq] = useState<number>(defaultEvent?.seq ?? 1);
  const [editMode, setEditMode] = useState<"input" | "result">("input");

  // Current selected event
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
  // In-memory ONLY: never written to localStorage, sessionStorage, or URL
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

    // Validate JSON payload
    let parsedValue: unknown;
    try {
      parsedValue = JSON.parse(jsonText);
    } catch {
      setErrorMsg("Invalid JSON: Please check the edited value syntax.");
      return;
    }

    // Validate optional mocks if provided
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
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-xs"
    >
      <div className="w-full max-w-2xl bg-slate-900 border border-slate-800 rounded-xl shadow-2xl flex flex-col max-h-[90vh] overflow-hidden">
        {/* Modal Header */}
        <div className="flex items-center justify-between p-4 border-b border-slate-800 bg-slate-950/60">
          <div className="flex items-center gap-2">
            <GitFork className="w-5 h-5 text-purple-400" />
            <h2 className="text-base font-semibold text-slate-100">Create Shadow Fork</h2>
            <span className="px-2 py-0.5 rounded text-[10px] bg-purple-900/60 border border-purple-500/40 text-purple-300 font-mono">
              SHADOW ONLY
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-slate-200 p-1 rounded hover:bg-slate-800 cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-6 overflow-y-auto flex flex-col gap-5 text-xs text-slate-300">
          {/* Informational banner */}
          <div className="p-3 bg-purple-950/30 border border-purple-500/30 rounded-lg text-purple-200 flex items-start gap-2.5">
            <GitFork className="w-4 h-4 text-purple-400 shrink-0 mt-0.5" />
            <span>
              Forks are executed strictly in <strong>shadow mode</strong>. Side-effectful steps
              (HTTP/SQL) will be safely intercepted with zero external mutations.
            </span>
          </div>

          {forkResult ? (
            /* Success State */
            <div
              data-testid="fork-success-card"
              className="flex flex-col gap-4 p-4 bg-slate-950 rounded-lg border border-emerald-500/40"
            >
              <div className="flex items-center gap-2 text-emerald-400 font-semibold text-sm">
                <CheckCircle className="w-5 h-5" />
                <span>Shadow Fork Created Successfully!</span>
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-slate-400">Fork Run ID:</span>
                <span className="font-mono text-purple-300 text-xs bg-slate-900 p-2 rounded border border-slate-800 break-all select-all">
                  {forkResult.forkRunId}
                </span>
              </div>
              {forkResult.warnings && forkResult.warnings.length > 0 && (
                <div className="p-3 bg-amber-950/40 border border-amber-500/40 rounded flex flex-col gap-1 text-amber-200">
                  <div className="flex items-center gap-1.5 font-semibold">
                    <AlertTriangle className="w-3.5 h-3.5" />
                    <span>Warnings:</span>
                  </div>
                  <ul className="list-disc pl-5 text-[11px] space-y-1">
                    {forkResult.warnings.map((w) => (
                      <li key={w}>{w}</li>
                    ))}
                  </ul>
                </div>
              )}
              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="px-4 py-2 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 cursor-pointer"
                >
                  Close
                </button>
                <button
                  type="button"
                  data-testid="navigate-to-fork-btn"
                  onClick={() => onForkSuccess(forkResult.forkRunId)}
                  className="px-4 py-2 rounded bg-purple-600 hover:bg-purple-500 text-white font-medium cursor-pointer shadow-lg shadow-purple-900/30"
                >
                  Go to Shadow Fork
                </button>
              </div>
            </div>
          ) : (
            /* Fork Creation Form */
            <form onSubmit={handleSubmit} className="flex flex-col gap-4">
              {errorMsg && (
                <div
                  data-testid="fork-error-banner"
                  className="p-3 bg-rose-950/50 border border-rose-500/50 rounded flex items-center gap-2 text-rose-300"
                >
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  <span>{errorMsg}</span>
                </div>
              )}

              {/* Step Selection */}
              <div className="flex flex-col gap-1.5">
                <label htmlFor="fork-step-select" className="font-semibold text-slate-200">
                  Fork at Step (Sequence Number):
                </label>
                <select
                  id="fork-step-select"
                  data-testid="fork-step-select"
                  value={selectedSeq}
                  onChange={(e) => handleSeqChange(Number(e.target.value))}
                  className="bg-slate-950 border border-slate-700 rounded p-2 text-slate-200 font-mono"
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
              <div className="flex flex-col gap-1.5">
                <span className="font-semibold text-slate-200">Fork Edit Target:</span>
                <div className="flex items-center gap-6">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="editMode"
                      value="input"
                      checked={editMode === "input"}
                      onChange={() => handleEditModeChange("input")}
                      className="accent-purple-500"
                    />
                    <span>Edit Step Input</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="editMode"
                      value="result"
                      checked={editMode === "result"}
                      onChange={() => handleEditModeChange("result")}
                      className="accent-purple-500"
                    />
                    <span>Edit Step Result</span>
                  </label>
                </div>
              </div>

              {/* JSON Textarea */}
              <div className="flex flex-col gap-1.5">
                <label htmlFor="fork-json-textarea" className="font-semibold text-slate-200">
                  Edited {editMode === "input" ? "Input" : "Result"} (JSON):
                </label>
                <textarea
                  id="fork-json-textarea"
                  data-testid="fork-json-textarea"
                  rows={6}
                  value={jsonText}
                  onChange={(e) => setJsonText(e.target.value)}
                  className="bg-slate-950 border border-slate-700 rounded p-2.5 font-mono text-slate-200 text-xs focus:border-purple-500 focus:outline-hidden"
                />
              </div>

              {/* Optional Mocks Textarea */}
              <div className="flex flex-col gap-1.5">
                <label htmlFor="fork-mocks-textarea" className="font-semibold text-slate-400">
                  Optional Injected Mocks (JSON array of &#123; stepName, result &#125;):
                </label>
                <textarea
                  id="fork-mocks-textarea"
                  data-testid="fork-mocks-textarea"
                  rows={3}
                  placeholder='[ { "stepName": "step-payment", "result": { "status": 200 } } ]'
                  value={mocksText}
                  onChange={(e) => setMocksText(e.target.value)}
                  className="bg-slate-950 border border-slate-800 rounded p-2 font-mono text-slate-300 text-xs focus:border-purple-500 focus:outline-hidden"
                />
              </div>

              {/* API Token Input (In-Memory Only) */}
              <div className="flex flex-col gap-1.5">
                <label
                  htmlFor="fork-token-input"
                  className="font-semibold text-slate-400 flex items-center justify-between"
                >
                  <span>API Token (if server requires authentication):</span>
                  <span className="text-[10px] text-slate-500 font-normal">
                    Stored in-memory only (never saved to storage)
                  </span>
                </label>
                <input
                  id="fork-token-input"
                  data-testid="fork-token-input"
                  type="password"
                  placeholder="Bearer token"
                  value={apiToken}
                  onChange={(e) => setApiToken(e.target.value)}
                  className="bg-slate-950 border border-slate-800 rounded p-2 text-slate-200 text-xs focus:border-purple-500 focus:outline-hidden"
                />
              </div>

              {/* Form Buttons */}
              <div className="flex justify-end gap-3 pt-3 border-t border-slate-800">
                <button
                  type="button"
                  onClick={onClose}
                  className="px-4 py-2 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  data-testid="submit-fork-btn"
                  className="px-4 py-2 rounded bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white font-medium cursor-pointer shadow-lg shadow-purple-900/30 flex items-center gap-2"
                >
                  <GitFork className="w-4 h-4" />
                  {isSubmitting ? "Creating Fork..." : "Create Shadow Fork"}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
