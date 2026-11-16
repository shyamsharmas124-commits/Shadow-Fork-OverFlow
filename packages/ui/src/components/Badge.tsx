import type { ReactNode } from "react";

export function Badge({
  children,
  variant = "default",
}: {
  children: ReactNode;
  variant?: "default" | "success" | "warning" | "danger" | "purple" | "cyan";
}) {
  const styles = {
    default: "bg-slate-800 text-slate-300 border-slate-700",
    success: "bg-emerald-950/80 text-emerald-400 border-emerald-800",
    warning: "bg-amber-950/80 text-amber-400 border-amber-800",
    danger: "bg-rose-950/80 text-rose-400 border-rose-800",
    purple: "bg-purple-950/80 text-purple-300 border-purple-800",
    cyan: "bg-cyan-950/80 text-cyan-300 border-cyan-800",
  }[variant];

  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border ${styles}`}
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
    return <Badge variant="purple">Shadow Fork</Badge>;
  }
  return <Badge variant="default">Live</Badge>;
}
