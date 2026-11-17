import type { ReactNode } from "react";

export function Badge({
  children,
  variant = "default",
}: {
  children: ReactNode;
  variant?: "default" | "success" | "warning" | "danger" | "shadow" | "purple" | "cyan";
}) {
  // Map styles to instrument panel square tags with hairline borders
  const styleMap: Record<string, string> = {
    default: "bg-[var(--bg-subtle)] text-[var(--ink-secondary)] border-[var(--border-hairline)]",
    success:
      "bg-[var(--status-completed-bg)] text-[var(--status-completed-fg)] border-[var(--status-completed-border)]",
    warning:
      "bg-[var(--status-running-bg)] text-[var(--status-running-fg)] border-[var(--status-running-border)]",
    danger:
      "bg-[var(--status-failed-bg)] text-[var(--status-failed-fg)] border-[var(--status-failed-border)]",
    shadow:
      "bg-[var(--status-shadow-bg)] text-[var(--status-shadow-fg)] border-[var(--status-shadow-border)]",
    purple:
      "bg-[var(--status-shadow-bg)] text-[var(--status-shadow-fg)] border-[var(--status-shadow-border)]",
    cyan: "bg-[var(--bg-subtle)] text-[var(--ink-primary)] border-[var(--border-hairline)]",
  };

  const selectedClass = styleMap[variant] ?? styleMap.default;

  return (
    <span
      className={`inline-flex items-center px-1.5 py-0.5 text-[11px] font-mono font-medium border rounded-none tracking-tight ${selectedClass}`}
    >
      {children}
    </span>
  );
}

export function StatusBadge({ status }: { status: string }) {
  if (status === "completed") {
    return <Badge variant="success">Completed</Badge>;
  }
  if (status === "failed") {
    return <Badge variant="danger">Failed</Badge>;
  }
  return <Badge variant="warning">Running</Badge>;
}

export function ModeBadge({ mode }: { mode: string }) {
  if (mode === "shadow") {
    return <Badge variant="shadow">Shadow Fork</Badge>;
  }
  return <Badge variant="default">Live</Badge>;
}
