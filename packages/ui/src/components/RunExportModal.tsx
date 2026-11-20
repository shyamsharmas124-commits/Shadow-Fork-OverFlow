import { Check, Copy, Download, FileJson, Link as LinkIcon, ShieldCheck, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { RunDetail, RunEvent } from "../types.js";
import { redactSecretString } from "../utils/curl.js";

interface RunExportModalProps {
  run: RunDetail | null;
  selectedEvent: RunEvent | null;
  isOpen: boolean;
  onClose: () => void;
}

/**
 * Computes a standard SHA-256 hex string using the browser Web Crypto API.
 */
async function computeSha256(text: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function RunExportModal({ run, selectedEvent, isOpen, onClose }: RunExportModalProps) {
  const [sha256Hash, setSha256Hash] = useState<string>("");
  const [copiedJson, setCopiedJson] = useState<boolean>(false);
  const [copiedLink, setCopiedLink] = useState<boolean>(false);

  // Redacted export payload
  const exportJsonString = useMemo(() => {
    if (!run) return "";
    const raw = JSON.stringify(run, null, 2);
    return redactSecretString(raw);
  }, [run]);

  useEffect(() => {
    if (exportJsonString) {
      computeSha256(exportJsonString)
        .then(setSha256Hash)
        .catch(() => {});
    }
  }, [exportJsonString]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen || !run) return null;

  // Plain permalink hash: #run=<id>&seq=<seq> (no keys or tokens)
  const currentOrigin =
    typeof window !== "undefined" ? window.location.origin : "http://localhost:3000";
  const eventName = selectedEvent
    ? (selectedEvent.payload as { name?: string; stepName?: string }).name ||
      (selectedEvent.payload as { name?: string; stepName?: string }).stepName ||
      selectedEvent.type
    : "step";
  const permalinkUrl = `${currentOrigin}/#run=${run.id}&event=${encodeURIComponent(eventName)}`;

  const handleDownload = () => {
    const blob = new Blob([exportJsonString], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `run-trace-${run.id.slice(0, 8)}-${sha256Hash.slice(0, 8)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleCopyJson = () => {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(exportJsonString).catch(() => {});
    }
    setCopiedJson(true);
    setTimeout(() => setCopiedJson(false), 2000);
  };

  const handleCopyLink = () => {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(permalinkUrl).catch(() => {});
    }
    setCopiedLink(true);
    setTimeout(() => setCopiedLink(false), 2000);
  };

  return (
    <div
      data-testid="run-export-modal"
      role="dialog"
      aria-modal="true"
      aria-label="Export Redacted Run & Permalink"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
    >
      <div className="w-full max-w-2xl bg-[var(--bg-panel)] border border-[var(--border-hairline)] flex flex-col font-mono text-xs overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between p-3 border-b border-[var(--border-hairline)] bg-[var(--bg-subtle)]">
          <div className="flex items-center gap-2">
            <FileJson className="w-4 h-4 text-[var(--ink-primary)]" />
            <h2 className="text-xs font-bold uppercase tracking-wider text-[var(--ink-primary)]">
              Export Redacted Run &bull; SHA-256 Checksum
            </h2>
          </div>
          <button
            type="button"
            data-testid="close-export-modal-btn"
            onClick={onClose}
            aria-label="Close dialog"
            className="p-1 border border-transparent hover:border-[var(--border-hairline)] text-[var(--ink-secondary)] hover:text-[var(--ink-primary)] cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content Body */}
        <div className="p-4 flex flex-col gap-4 max-h-[75vh] overflow-y-auto">
          {/* Content Checksum */}
          <div className="p-3 bg-[var(--bg-subtle)] border border-[var(--border-hairline)] flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--ink-secondary)] flex items-center gap-1">
                <ShieldCheck className="w-3.5 h-3.5 text-[#1E5A36] dark:text-[#4EAD75]" />
                Content Checksum (SHA-256)
              </span>
              <span className="text-[10px] text-[var(--ink-muted)]">Computed</span>
            </div>
            <code
              data-testid="export-sha256-hash"
              className="text-[11px] font-mono break-all text-[var(--ink-primary)] font-bold"
            >
              {sha256Hash || "Computing..."}
            </code>
            <span className="text-[10px] text-[var(--ink-muted)]">
              Unauthenticated SHA-256 checksum for payload verification during transfer. Does not
              prove origin authenticity.
            </span>
          </div>

          {/* Plain Permalink Section */}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-bold uppercase tracking-wider text-[var(--ink-secondary)] flex items-center gap-1">
                <LinkIcon className="w-3.5 h-3.5" />
                Event Permalink (Plain Hash Only &bull; Zero Secrets)
              </span>
              <button
                type="button"
                data-testid="copy-permalink-btn"
                onClick={handleCopyLink}
                className="flex items-center gap-1 px-2 py-0.5 border border-[var(--border-hairline)] bg-[var(--bg-subtle)] hover:bg-[var(--bg-hover)] text-[10px] cursor-pointer"
              >
                {copiedLink ? (
                  <>
                    <Check className="w-3 h-3 text-[#1E5A36] dark:text-[#4EAD75]" /> Copied!
                  </>
                ) : (
                  <>
                    <Copy className="w-3 h-3" /> Copy Permalink
                  </>
                )}
              </button>
            </div>
            <pre
              data-testid="permalink-input"
              className="p-2 bg-[var(--bg-subtle)] border border-[var(--border-hairline)] text-xs overflow-x-auto whitespace-pre-wrap break-all"
            >
              <code>{permalinkUrl}</code>
            </pre>
            <span className="text-[10px] text-[var(--ink-muted)]">
              Permalinks use URI fragments (#event) exclusively. Tokens and API keys are never
              included.
            </span>
          </div>

          {/* Redacted JSON Preview */}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-bold uppercase tracking-wider text-[var(--ink-secondary)]">
                Redacted Run Trace JSON ({exportJsonString.length} bytes)
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  data-testid="copy-export-json-btn"
                  onClick={handleCopyJson}
                  className="flex items-center gap-1 px-2 py-0.5 border border-[var(--border-hairline)] bg-[var(--bg-subtle)] hover:bg-[var(--bg-hover)] text-[10px] cursor-pointer"
                >
                  {copiedJson ? (
                    <>
                      <Check className="w-3 h-3 text-[#1E5A36] dark:text-[#4EAD75]" /> Copied!
                    </>
                  ) : (
                    <>
                      <Copy className="w-3 h-3" /> Copy JSON
                    </>
                  )}
                </button>
                <button
                  type="button"
                  data-testid="download-export-json-btn"
                  onClick={handleDownload}
                  className="flex items-center gap-1 px-2.5 py-0.5 border border-[var(--border-hairline)] bg-[var(--ink-primary)] text-[var(--paper)] hover:opacity-90 text-[10px] font-bold cursor-pointer"
                >
                  <Download className="w-3 h-3" /> Download .json
                </button>
              </div>
            </div>
            {/* Pre container - tabIndex={0} required for axe scrollable-region-focusable */}
            <section
              // biome-ignore lint/a11y/noNoninteractiveTabindex: scrollable container requires tabIndex=0 for keyboard accessibility (axe scrollable-region-focusable)
              tabIndex={0}
              aria-label="Exported execution trace JSON"
              className="p-3 bg-[var(--bg-subtle)] border border-[var(--border-hairline)] text-xs overflow-x-auto max-h-56 text-[var(--ink-primary)]"
            >
              <pre data-testid="export-json-preview" className="whitespace-pre-wrap break-all">
                <code>{exportJsonString}</code>
              </pre>
            </section>
          </div>
        </div>

        {/* Footer */}
        <div className="p-2.5 border-t border-[var(--border-hairline)] bg-[var(--bg-subtle)] flex items-center justify-end">
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
