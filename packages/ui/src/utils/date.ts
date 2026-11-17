export function formatDate(val?: string | Date | null, options?: { timeOnly?: boolean }): string {
  if (!val) return "-";
  try {
    const d = val instanceof Date ? val : new Date(val);
    if (Number.isNaN(d.getTime())) return "-";
    return options?.timeOnly ? d.toLocaleTimeString() : d.toLocaleString();
  } catch {
    return "-";
  }
}

export function formatTimeAgo(val?: string | Date | null): string {
  if (!val) return "-";
  try {
    const d = val instanceof Date ? val : new Date(val);
    if (Number.isNaN(d.getTime())) return "-";
    const ms = Date.now() - d.getTime();
    if (ms < 1000) return "just now";
    const sec = Math.floor(ms / 1000);
    if (sec < 60) return `${sec}s ago`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const days = Math.floor(hr / 24);
    return `${days}d ago`;
  } catch {
    return "-";
  }
}
