import { Check, Copy, Terminal, X } from "lucide-react";
import { useState } from "react";
import type { RunDetail } from "../types.js";

interface CliSnippetModalProps {
  run: RunDetail;
  isOpen: boolean;
  onClose: () => void;
}

export function CliSnippetModal({ run, isOpen, onClose }: CliSnippetModalProps) {
  const [copiedCurl, setCopiedCurl] = useState<boolean>(false);
  const [copiedCli, setCopiedCli] = useState<boolean>(false);

  if (!isOpen) return null;

  const origin = typeof window !== "undefined" ? window.location.origin : "http://localhost:3000";

  const curlSnippet = `curl -X POST "${origin}/runs/${run.id}/fork" \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer <YOUR_TOKEN>" \\
  -d '{
    "atSeq": ${run.forkedFromSeq ?? 1},
    "edit": {
      "input": {}
    }
  }'`;

  const cliSnippet = `# Execute shadow fork via durable CLI:
pnpm cli fork ${run.id} --seq ${run.forkedFromSeq ?? 1}

# Or resume failed run with attempt budget:
pnpm cli resume ${run.id}`;

  const copyToClipboard = (text: string, isCurl: boolean) => {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).catch(() => {});
    }
    if (isCurl) {
      setCopiedCurl(true);
      setTimeout(() => setCopiedCurl(false), 2000);
    } else {
      setCopiedCli(true);
      setTimeout(() => setCopiedCli(false), 2000);
    }
  };

  return (
    <div
      data-testid="cli-snippet-modal"
      role="dialog"
      aria-modal="true"
      aria-label="cURL and CLI Command Snippets"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
    >
      <div className="w-full max-w-2xl bg-[var(--bg-panel)] border border-[var(--border-hairline)] p-4 flex flex-col gap-4 font-mono text-xs text-[var(--ink-primary)]">
        <div className="flex items-center justify-between border-b border-[var(--border-hairline)] pb-2.5">
          <div className="flex items-center gap-2">
            <Terminal className="w-4 h-4 text-[var(--ink-primary)]" />
            <h2 className="text-xs font-bold uppercase tracking-wider text-[var(--ink-primary)]">
              Reproduce & Fork &bull; cURL / CLI Commands
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close dialog"
            className="p-1 border border-transparent hover:border-[var(--border-hairline)] text-[var(--ink-secondary)] hover:text-[var(--ink-primary)] cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* cURL Snippet */}
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-bold text-[var(--ink-secondary)] uppercase">
              cURL Command (HTTP Gateway)
            </span>
            <button
              type="button"
              data-testid="copy-curl-btn"
              onClick={() => copyToClipboard(curlSnippet, true)}
              className="flex items-center gap-1 px-2 py-0.5 border border-[var(--border-hairline)] bg-[var(--bg-subtle)] hover:bg-[var(--bg-hover)] text-[11px] cursor-pointer"
            >
              {copiedCurl ? (
                <>
                  <Check className="w-3 h-3 text-[#1E5A36] dark:text-[#4EAD75]" /> Copied!
                </>
              ) : (
                <>
                  <Copy className="w-3 h-3" /> Copy cURL
                </>
              )}
            </button>
          </div>
          <pre
            data-testid="cli-curl-pre"
            className="p-2.5 bg-[var(--bg-subtle)] border border-[var(--border-hairline)] text-xs overflow-x-auto whitespace-pre-wrap break-all"
          >
            <code>{curlSnippet}</code>
          </pre>
          <span className="text-[10px] text-[var(--ink-muted)]">
            Note: Sensitive authentication tokens are replaced with placeholder &lt;YOUR_TOKEN&gt;.
          </span>
        </div>

        {/* CLI Snippet */}
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-bold text-[var(--ink-secondary)] uppercase">
              CLI Commands (Workspace Root)
            </span>
            <button
              type="button"
              data-testid="copy-cli-btn"
              onClick={() => copyToClipboard(cliSnippet, false)}
              className="flex items-center gap-1 px-2 py-0.5 border border-[var(--border-hairline)] bg-[var(--bg-subtle)] hover:bg-[var(--bg-hover)] text-[11px] cursor-pointer"
            >
              {copiedCli ? (
                <>
                  <Check className="w-3 h-3 text-[#1E5A36] dark:text-[#4EAD75]" /> Copied!
                </>
              ) : (
                <>
                  <Copy className="w-3 h-3" /> Copy CLI
                </>
              )}
            </button>
          </div>
          <pre className="p-2.5 bg-[var(--bg-subtle)] border border-[var(--border-hairline)] text-xs overflow-x-auto whitespace-pre-wrap break-all">
            <code>{cliSnippet}</code>
          </pre>
        </div>

        <div className="flex justify-end pt-2 border-t border-[var(--border-hairline)]">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1 bg-[var(--bg-subtle)] border border-[var(--border-hairline)] text-[var(--ink-primary)] hover:bg-[var(--bg-hover)] cursor-pointer text-xs"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
