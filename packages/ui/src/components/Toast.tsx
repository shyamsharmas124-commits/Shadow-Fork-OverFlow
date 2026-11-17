import { CheckCircle2, Info, XCircle } from "lucide-react";
import { useEffect } from "react";

export interface ToastMessage {
  id: string;
  type: "success" | "error" | "info";
  message: string;
}

interface ToastContainerProps {
  toasts: ToastMessage[];
  onDismiss: (id: string) => void;
}

export function ToastContainer({ toasts, onDismiss }: ToastContainerProps) {
  useEffect(() => {
    if (toasts.length === 0) return;
    const timers = toasts.map((t) =>
      setTimeout(() => {
        onDismiss(t.id);
      }, 4000),
    );
    return () => {
      for (const timer of timers) {
        clearTimeout(timer);
      }
    };
  }, [toasts, onDismiss]);

  if (toasts.length === 0) return null;

  return (
    <div
      data-testid="toast-container"
      className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm font-mono text-xs"
    >
      {toasts.map((toast) => {
        const Icon =
          toast.type === "success" ? CheckCircle2 : toast.type === "error" ? XCircle : Info;

        const borderBg =
          toast.type === "success"
            ? "border-[#1E5A36] text-[#1E5A36] dark:text-[#4EAD75] bg-[var(--bg-panel)]"
            : toast.type === "error"
              ? "border-[#B91C1C] text-[#B91C1C] dark:text-[#F87171] bg-[var(--bg-panel)]"
              : "border-[var(--border-hairline)] text-[var(--ink-primary)] bg-[var(--bg-panel)]";

        return (
          <div
            key={toast.id}
            data-testid={`toast-${toast.id}`}
            className={`p-2.5 border shadow-xs flex items-center gap-2 ${borderBg}`}
          >
            <Icon className="w-4 h-4 shrink-0" />
            <span className="flex-1 text-xs text-[var(--ink-primary)]">{toast.message}</span>
            <button
              type="button"
              onClick={() => onDismiss(toast.id)}
              className="p-0.5 hover:opacity-70 cursor-pointer"
            >
              &times;
            </button>
          </div>
        );
      })}
    </div>
  );
}
