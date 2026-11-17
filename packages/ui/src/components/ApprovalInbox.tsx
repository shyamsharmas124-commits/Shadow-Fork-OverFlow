import { Check, CheckCircle2, Clock, Inbox, ShieldAlert, X, XCircle } from "lucide-react";
import { useMemo, useState } from "react";
import { submitApprovalApi } from "../api.js";
import type { RunDetail, RunSummary } from "../types.js";
import { formatTimeAgo } from "../utils/date.js";

interface PendingApproval {
  runId: string;
  workflowType: string;
  approvalName: string;
  payload: Record<string, unknown>;
  requestedAt: string;
  timeoutMs?: number;
}

interface ApprovalInboxProps {
  runs: RunSummary[];
  runDetails: Record<string, RunDetail>;
  apiToken: string;
  onSelectRun: (id: string) => void;
  onApprovalSuccess: (runId: string) => void;
}

export function ApprovalInbox({
  runs,
  runDetails,
  apiToken,
  onSelectRun,
  onApprovalSuccess,
}: ApprovalInboxProps) {
  const [rejectingApproval, setRejectingApproval] = useState<PendingApproval | null>(null);
  const [rejectReason, setRejectReason] = useState<string>("");
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Extract all pending approvals across runs
  const pendingApprovals = useMemo(() => {
    const list: PendingApproval[] = [];

    for (const run of runs) {
      const detail = runDetails[run.id];
      if (!detail) continue;

      // Find ApprovalRequested events that have not been granted or rejected
      const events = detail.events;
      const requestedEvents = events.filter((e) => e.type === "ApprovalRequested");

      for (const req of requestedEvents) {
        const payload = req.payload as { name?: string; payload?: unknown; timeoutMs?: number };
        const name = payload.name || "default";

        const resolved = events.some(
          (e) =>
            (e.type === "ApprovalGranted" || e.type === "ApprovalRejected") &&
            (e.payload as { name?: string }).name === name,
        );

        if (!resolved) {
          list.push({
            runId: run.id,
            workflowType: run.workflowType,
            approvalName: name,
            payload: (payload.payload as Record<string, unknown>) ?? {},
            requestedAt: req.createdAt,
            timeoutMs: payload.timeoutMs,
          });
        }
      }
    }

    return list;
  }, [runs, runDetails]);

  const handleApprove = async (approval: PendingApproval) => {
    setIsSubmitting(true);
    setActionError(null);
    try {
      await submitApprovalApi(
        approval.runId,
        approval.approvalName,
        "approve",
        undefined,
        apiToken || undefined,
      );
      onApprovalSuccess(approval.runId);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Approval submission failed");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleConfirmReject = async () => {
    if (!rejectingApproval) return;
    setIsSubmitting(true);
    setActionError(null);
    try {
      await submitApprovalApi(
        rejectingApproval.runId,
        rejectingApproval.approvalName,
        "reject",
        rejectReason || undefined,
        apiToken || undefined,
      );
      onApprovalSuccess(rejectingApproval.runId);
      setRejectingApproval(null);
      setRejectReason("");
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Rejection submission failed");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      data-testid="approval-inbox-view"
      className="flex flex-col gap-4 font-mono text-xs text-[var(--ink-primary)]"
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-[var(--border-hairline)] pb-3">
        <div className="flex items-center gap-2">
          <Inbox className="w-4 h-4 text-[var(--status-running-fg)]" />
          <h1 className="text-xs font-bold uppercase tracking-wider text-[var(--ink-primary)]">
            Human Approval Inbox &bull; Parked Workflows
          </h1>
          <span
            data-testid="approval-count-badge"
            className="px-1.5 py-0.2 border border-[var(--status-running-fg)] text-[var(--status-running-fg)] font-bold text-[10px]"
          >
            {pendingApprovals.length} PENDING
          </span>
        </div>
      </div>

      {actionError && (
        <div className="p-2 border border-[#B91C1C] text-[#B91C1C] dark:text-[#F87171] bg-[#B91C1C]/10 text-xs">
          {actionError}
        </div>
      )}

      {/* List of Pending Approvals */}
      {pendingApprovals.length === 0 ? (
        <div
          data-testid="empty-approval-inbox"
          className="p-8 border border-[var(--border-hairline)] bg-[var(--bg-panel)] flex flex-col items-center justify-center gap-2 text-center"
        >
          <CheckCircle2 className="w-8 h-8 text-[#1E5A36] dark:text-[#4EAD75]" />
          <span className="font-bold text-[var(--ink-primary)] text-sm">Inbox Zero</span>
          <span className="text-[11px] text-[var(--ink-muted)] max-w-sm">
            No workflows are currently parked waiting for human authorization. All execution gates
            are clear.
          </span>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3">
          {pendingApprovals.map((appr) => (
            <div
              key={`${appr.runId}-${appr.approvalName}`}
              data-testid={`approval-card-${appr.runId}`}
              className="p-4 border border-[var(--border-hairline)] bg-[var(--bg-panel)] flex flex-col gap-3"
            >
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border-hairline)] pb-2.5">
                <div className="flex items-center gap-2">
                  <span className="px-1.5 py-0.5 border border-[var(--border-hairline)] bg-[var(--bg-subtle)] font-bold text-[11px]">
                    {appr.workflowType}
                  </span>
                  <button
                    type="button"
                    onClick={() => onSelectRun(appr.runId)}
                    className="hover:underline font-bold text-[var(--ink-primary)] cursor-pointer"
                  >
                    Run {appr.runId.slice(0, 12)}...
                  </button>
                  <span className="text-[var(--ink-muted)]">
                    &bull; Gate: [{appr.approvalName}]
                  </span>
                </div>
                <div className="flex items-center gap-1.5 text-[10px] text-[var(--ink-muted)]">
                  <Clock className="w-3 h-3" />
                  Parked {formatTimeAgo(appr.requestedAt)}
                </div>
              </div>

              {/* Payload Preview */}
              <div className="flex flex-col gap-1.5">
                <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--ink-secondary)]">
                  Payload Submitted For Authorization:
                </span>
                <pre
                  data-testid="approval-payload-pre"
                  className="p-2.5 bg-[var(--bg-subtle)] border border-[var(--border-hairline)] text-xs overflow-x-auto whitespace-pre-wrap break-all"
                >
                  <code>{JSON.stringify(appr.payload, null, 2)}</code>
                </pre>
              </div>

              {/* Action Buttons */}
              <div className="flex items-center justify-end gap-2 pt-1">
                <button
                  type="button"
                  data-testid="reject-gate-btn"
                  onClick={() => setRejectingApproval(appr)}
                  disabled={isSubmitting}
                  className="flex items-center gap-1 px-3 py-1.5 border border-[#B91C1C] text-[#B91C1C] dark:text-[#F87171] hover:bg-[#B91C1C]/10 cursor-pointer disabled:opacity-50 text-xs font-bold"
                >
                  <XCircle className="w-3.5 h-3.5" />
                  Reject Gate
                </button>
                <button
                  type="button"
                  data-testid="approve-gate-btn"
                  onClick={() => handleApprove(appr)}
                  disabled={isSubmitting}
                  className="flex items-center gap-1 px-3 py-1.5 border border-[#1E5A36] text-[#1E5A36] dark:text-[#4EAD75] hover:bg-[#1E5A36]/10 cursor-pointer disabled:opacity-50 text-xs font-bold"
                >
                  <Check className="w-3.5 h-3.5" />
                  Authorize & Resume
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 2-Step Typed Rejection Confirmation Modal */}
      {rejectingApproval && (
        <div
          data-testid="rejection-confirm-modal"
          role="dialog"
          aria-modal="true"
          aria-label="Confirm Rejection"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
        >
          <div className="w-full max-w-md bg-[var(--bg-panel)] border border-[var(--border-hairline)] p-4 flex flex-col gap-3 font-mono text-xs text-[var(--ink-primary)]">
            <div className="flex items-center justify-between border-b border-[var(--border-hairline)] pb-2">
              <div className="flex items-center gap-1.5 text-[#B91C1C] dark:text-[#F87171] font-bold">
                <ShieldAlert className="w-4 h-4" />
                <span>Confirm Gate Rejection</span>
              </div>
              <button
                type="button"
                onClick={() => setRejectingApproval(null)}
                aria-label="Close dialog"
                className="p-1 hover:bg-[var(--bg-hover)] cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <p className="text-[11px] text-[var(--ink-secondary)]">
              Rejecting gate{" "}
              <strong className="text-[var(--ink-primary)]">
                {rejectingApproval.approvalName}
              </strong>{" "}
              will immediately fail or reject the parked workflow execution step.
            </p>

            <div className="flex flex-col gap-1">
              <label
                htmlFor="rejection-reason"
                className="text-[10px] uppercase text-[var(--ink-muted)]"
              >
                Rejection Reason (Audit Log):
              </label>
              <textarea
                id="rejection-reason"
                data-testid="rejection-reason-input"
                rows={2}
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
                placeholder="e.g. Budget exceeded or compliance check failed"
                className="w-full p-2 bg-[var(--bg-subtle)] border border-[var(--border-hairline)] text-xs text-[var(--ink-primary)] focus:outline-hidden"
              />
            </div>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-[var(--border-hairline)]">
              <button
                type="button"
                data-testid="cancel-rejection-btn"
                onClick={() => setRejectingApproval(null)}
                className="px-3 py-1 border border-[var(--border-hairline)] bg-[var(--bg-subtle)] text-[var(--ink-secondary)] hover:bg-[var(--bg-hover)] cursor-pointer text-xs"
              >
                Cancel
              </button>
              <button
                type="button"
                data-testid="confirm-rejection-btn"
                onClick={handleConfirmReject}
                disabled={isSubmitting}
                className="px-3 py-1 border border-[#B91C1C] bg-[#B91C1C] text-white hover:opacity-90 cursor-pointer disabled:opacity-50 text-xs font-bold"
              >
                Confirm Rejection
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
