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
